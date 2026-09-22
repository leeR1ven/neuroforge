#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/* ============================================================================
   NeuroForge 桌面壳
   ----------------------------------------------------------------------------
   界面仍然是那份单文件 HTML（desktop/dist/index.html，打包进 exe），
   这里只补浏览器给不了的东西：
     1. 一个真正的窗口、任务栏图标、开始菜单 / 桌面快捷方式；
     2. 导出走 Windows 原生对话框，而不是浏览器那种"下载到下载文件夹"；
     3. 连续导出记住上次的目录；重名不覆盖（自动加 (2) (3)）。
   别的什么都不做——渲染、编译、AI 全在页面里，壳子不掺和。

   导出为什么要分两条路：
     一个文件 -> 页面照常触发下载，这里在 on_download 里把落点换成原生「另存为」；
     一批文件 -> 页面先调 pick_export_dir 报个数，这里弹**一次**文件夹选择框，
                 然后页面把整批文件按 NFB1 打包成一段二进制发给 write_export_files，
                 这里直接 std::fs 写盘。
   为什么一批不走下载通道：同一页面连续自动下载会被 Chromium 拦掉（浏览器里会弹
   "允许下载多个文件"，WebView2 没有这个提示框），实测一批 3 个只落得下第 1 个。
   ========================================================================== */

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::DownloadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

mod io_bus;
mod sys_exec;
use io_bus::{IoBus, IoLinks};

/// 上次另存为 / 选目录用的目录（连续导出时不用每次重新找地方）
#[derive(Default)]
struct LastDir(Mutex<Option<PathBuf>>);

/// 一批导出选好的目标目录：(目录, 什么时候选的)
/// 带时间戳是因为「页面选了目录但没来写文件」时不能让这个目录一直挂着，
/// 否则下一次导出会静悄悄落进上一次选的文件夹——这种意外不能有。
#[derive(Default)]
struct PendingDir(Mutex<Option<(PathBuf, Instant)>>);

const PENDING_TTL: Duration = Duration::from_secs(300);

/* 渲染进程能用多少内存这件事，先把试过的路和结论写在这里，省得下次再撞一遍：

   WebView2 渲染进程的 V8 老生代上限是**硬的 4 GB**（实测 performance.memory.jsHeapSizeLimit
   = 4192 MB）。我们试过用 additional_browser_args 传 --js-flags=--max-old-space-size=8192：
   参数确实进了渲染进程的命令行（Get-CimInstance 看得到），但上限一点没变。
   正式版 Chromium 内核会忽略 --js-flags —— 在普通 Chrome 里做同样的实验也一样
   （无参数 3586 MB，传了 8192 还是 3586 MB）。所以这条路走不通。

   实测出来的用量：一个 104 MB / 143,796 神经元 / 16,817,110 连接的工程，全量驻留 1.8 GB；
   把 pytorch / onnx / c 三个目标都编译一遍、再在 14 万个神经元上批量调参，峰值 4141 MB ——
   于是渲染进程被系统杀掉：窗口全白、重建后回到示例网络，用户看到的是"我的工程没了"。

   应对放在前端，不在这里：
     1) buildArtifacts 一进来就 dlgDropArtifacts()，先放掉上一份产物再算下一份
        （model.bin 这个工程就有 336 MB，两份叠一起是峰值主因）；
     2) 开机发现本机自动保存会直接问"要接回来吗"，崩了也不至于以为工程丢了。 */

/* ---------------------------------------------------------------- 公共小工具 */

/// 默认文件名：能用 WebView2 建议的就用它，否则退回到 URL 最后一段
fn suggest_name(destination: &Path, url: &str) -> String {
    if let Some(n) = destination.file_name().and_then(|s| s.to_str()) {
        if !n.is_empty() && n != "download" {
            return n.to_string();
        }
    }
    let tail = url.rsplit(['/', '\\']).next().unwrap_or("");
    let tail = tail.split(['?', '#']).next().unwrap_or("");
    if tail.is_empty() {
        "neuroforge-export.bin".to_string()
    } else {
        tail.to_string()
    }
}

/// 只要文件名本身：页面给的名字里就算带了路径（或 ..\..\）也出不了目标目录
fn safe_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if base.is_empty() || base == "." || base == ".." {
        "file".to_string()
    } else {
        base.to_string()
    }
}

/// 目标文件已存在时不覆盖，学浏览器那样加 (2) (3)……
fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = p.extension().and_then(|s| s.to_str());
    for i in 2..1000u32 {
        let cand = match ext {
            Some(e) => dir.join(format!("{} ({}).{}", stem, i, e)),
            None => dir.join(format!("{} ({})", stem, i)),
        };
        if !cand.exists() {
            return cand;
        }
    }
    first
}

/// 没记录过目录时的起点：我的文档（有就先用它，省得对话框一开在系统盘根上）
fn default_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")?;
    let docs = Path::new(&home).join("Documents");
    if docs.is_dir() {
        Some(docs)
    } else {
        Some(PathBuf::from(home))
    }
}

fn start_dir(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<LastDir>();
    let cur = state.0.lock().unwrap().clone();
    cur.or_else(default_dir)
}

fn remember_dir(app: &AppHandle, dir: &Path) {
    let state = app.state::<LastDir>();
    *state.0.lock().unwrap() = Some(dir.to_path_buf());
}

/// 弹原生「另存为」（单个文件走这条）。None = 用户取消（这次导出作废，不偷偷写盘）
fn ask_where(app: &AppHandle, default_name: &str) -> Option<PathBuf> {
    let mut dlg = rfd::FileDialog::new()
        .set_title("另存为")
        .set_file_name(default_name);
    if let Some(dir) = start_dir(app) {
        dlg = dlg.set_directory(dir);
    }
    let picked = dlg.save_file();
    if let Some(p) = picked.as_ref() {
        if let Some(parent) = p.parent() {
            remember_dir(app, parent);
        }
    }
    picked
}

/* ------------------------------------------------------------------ 页面接口 */

/// 页面说「这一批有 count 个文件」时弹一次文件夹选择框。
/// 返回 Some(目录) = 选好了；None = 用户取消（页面就该整批放弃，不要偷偷写盘）。
#[tauri::command]
fn pick_export_dir(app: AppHandle, name: String, count: usize) -> Option<String> {
    let mut dlg = rfd::FileDialog::new().set_title(&format!(
        "选择导出文件夹（这一批 {} 个文件，例如 {}）",
        count,
        safe_name(&name)
    ));
    if let Some(dir) = start_dir(&app) {
        dlg = dlg.set_directory(dir);
    }
    let dir = dlg.pick_folder()?;
    remember_dir(&app, &dir);
    app.state::<PendingDir>()
        .0
        .lock()
        .unwrap()
        .replace((dir.clone(), Instant::now()));
    Some(dir.to_string_lossy().to_string())
}

/// NFB1 打包格式：'NFB1' + u32 个数 + 每个文件(u32 名字长度, 名字, u32 数据长度, 数据)，全小端
fn unpack(raw: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    if raw.len() < 8 || &raw[0..4] != b"NFB1" {
        return Err("导出数据头不对（不是 NFB1）".into());
    }
    let rd = |o: usize| -> Result<u32, String> {
        if o + 4 > raw.len() {
            return Err("导出数据被截断".into());
        }
        Ok(u32::from_le_bytes([raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]))
    };
    let count = rd(4)? as usize;
    let mut o = 8usize;
    let mut out = Vec::with_capacity(count.min(64));
    for i in 0..count {
        let nl = rd(o)? as usize;
        o += 4;
        if o + nl > raw.len() {
            return Err(format!("第 {} 个文件的文件名被截断", i + 1));
        }
        let name = String::from_utf8_lossy(&raw[o..o + nl]).to_string();
        o += nl;
        let dl = rd(o)? as usize;
        o += 4;
        if o + dl > raw.len() {
            return Err(format!("第 {} 个文件（{}）的内容被截断", i + 1, name));
        }
        out.push((name, raw[o..o + dl].to_vec()));
        o += dl;
    }
    Ok(out)
}

/// 把页面发来的一批文件写进刚才选好的目录。返回真正写出去的绝对路径。
#[tauri::command]
fn write_export_files(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Vec<String>, String> {
    let raw = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        _ => return Err("导出数据必须是二进制（NFB1）".into()),
    };
    let dir = {
        let st = app.state::<PendingDir>();
        let mut g = st.0.lock().unwrap();
        let (d, at) = g.clone().ok_or("没有选过导出目录")?;
        if at.elapsed() > PENDING_TTL {
            *g = None;
            return Err("选好的导出目录已经过期，请重新选一次".into());
        }
        *g = None;
        d
    };
    let files = unpack(raw)?;
    if files.is_empty() {
        return Err("这一批里没有文件".into());
    }
    let mut out = Vec::with_capacity(files.len());
    for (name, data) in files {
        let p = unique_in(&dir, &safe_name(&name));
        std::fs::write(&p, &data).map_err(|e| format!("写 {} 失败：{}", p.display(), e))?;
        out.push(p.to_string_lossy().to_string());
    }
    Ok(out)
}

fn main() {
    tauri::Builder::default()
        .manage(LastDir::default())
        .manage(PendingDir::default())
        .manage(IoBus::default())
        .manage(IoLinks::default())
        .manage(sys_exec::SysGate::default())
        .manage(sys_exec::Jobs::default())
        .manage(sys_exec::Approved::default())
        .invoke_handler(tauri::generate_handler![
            pick_export_dir,
            write_export_files,
            io_bus::nf_io_open,
            io_bus::nf_io_close,
            io_bus::nf_io_close_all,
            io_bus::nf_io_send,
            io_bus::nf_io_poll,
            io_bus::nf_io_links,
            io_bus::send_keys,
            io_bus::send_keys_combo,
            sys_exec::nf_sys_allow,
        sys_exec::nf_sys_ask_allow,
            sys_exec::nf_approve_file,
            sys_exec::nf_sys_info,
            sys_exec::nf_run,
            sys_exec::nf_read_file,
            sys_exec::nf_write_file,
            sys_exec::nf_list_dir,
            sys_exec::nf_http_get,
            sys_exec::nf_ai_http,
            sys_exec::nf_job_start,
            sys_exec::nf_job_poll,
            sys_exec::nf_job_kill,
            sys_exec::nf_job_list,
            sys_exec::nf_find,
            sys_exec::nf_stat,
            sys_exec::nf_mkdir,
            sys_exec::nf_edit_file,
            sys_exec::nf_cfg_paths,
            sys_exec::nf_cfg_read,
            sys_exec::nf_cfg_read_bak,
            sys_exec::nf_cfg_write,
            sys_exec::nf_tools_list,
            sys_exec::nf_tools_write,
            sys_exec::nf_tools_delete
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("NeuroForge 神经元搭建器")
                .inner_size(1600.0, 950.0)
                .min_inner_size(1080.0, 660.0)
                .center()
                /* 把 Tauri 自己的拖放处理关掉，恢复网页原生的 HTML5 拖放：
                   用户把 .nforge 从资源管理器拖进窗口就能打开 */
                .disable_drag_drop_handler()
                /* 窗口标题跟着页面的 document.title 走：任务栏、Alt+Tab 里看到的就是软件名 */
                .on_document_title_changed(|window, title| {
                    if !title.trim().is_empty() {
                        let _ = window.set_title(&title);
                    }
                })
                /* 单个文件的下载：把落点换成原生「另存为」。
                   一批文件不走这条路（见文件头注释），是由 write_export_files 直接写盘的。 */
                .on_download(move |_webview, event| {
                    if let DownloadEvent::Requested { url, destination } = event {
                        let name = suggest_name(destination, &url.to_string());
                        match ask_where(&handle, &name) {
                            Some(p) => {
                                *destination = p;
                                true
                            }
                            None => false,
                        }
                    } else {
                        true
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("NeuroForge 启动失败");
}
