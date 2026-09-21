//! AI 的「外部操作」通道：跑命令 / 按路径读写文件 / 列目录 / 探环境。
//!
//! 三条硬规矩（写在代码里，免得以后忘）：
//!   1) 两道门**默认都是关的**：页面设置里勾上 → 调 nf_sys_allow 把门打开；
//!      进程一重启就回到关。门关着时下面每条命令直接拒绝，一个字节都不碰。
//!      fs  = 联网下载 / 按路径读写文件（中等风险）
//!      run = 运行命令（高风险：等于把本机交给对面的模型，你自己决定开不开）
//!   2) 明显破坏性的命令模式直接拒（见 BLOCKED）。这是"拦明着来的"，**不是沙箱**：
//!      真要防住恶意命令，靠的是你别在装着敏感东西的机器上开这个开关。
//!   3) 不做交互：stdin 接空、超时就杀、输出截断——不能让 AI 把界面卡死。
//!
//! 为什么下载不自己实现 HTTP：Windows 10 1803 之后系统自带 curl.exe，用它比
//! 引一整套 TLS 依赖省事得多；探不到 curl 会明说（见 nf_sys_info 的 tools）。

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::io_bus::b64_encode;

/// 两道门。默认关；由页面调 nf_sys_allow 打开，重启即失效。
pub struct SysGate {
    pub fs: AtomicBool,
    pub run: AtomicBool,
}

impl Default for SysGate {
    fn default() -> Self {
        SysGate { fs: AtomicBool::new(false), run: AtomicBool::new(false) }
    }
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const OUT_CAP: usize = 200 * 1024;          /* 每条流最多回 200 KB */
const RUN_TIMEOUT_DEFAULT: u64 = 60_000;
const RUN_TIMEOUT_MAX: u64 = 600_000;
const READ_CHUNK_MAX: u64 = 8 * 1024 * 1024;
const WRITE_MAX: usize = 64 * 1024 * 1024;
const LIST_CAP: usize = 2000;

/* 临时 .cmd 的序号：同一秒里并发跑两条命令也不会撞名字 */
static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

/* 「拦明着来的」破坏性命令。故意只收没有歧义的写法：
   宁可漏，也不要因为一个正常的路径里带了个词就把活拦死。 */
const BLOCKED: &[&str] = &[
    "diskpart", "bcdedit", "vssadmin", "cipher /w", "mkfs", "wipefs", "takeown",
    "format c:", "format d:", "format e:", "format f:",
    "shutdown /", "shutdown -", "logoff",
    "del /f /s /q", "del /s /q", "del /q /s", "rd /s /q", "rmdir /s /q",
    "rm -rf /", "rm -fr /", "rm -rf c:", "rm -rf ~",
    "remove-item -recurse -force c:\\", "remove-item -r -fo c:\\",
    "reg delete", "sc delete", "net user", "net localgroup",
    "-encodedcommand", "-enc ",
    "> \\\\.\\physicaldrive",
];

fn home_dir() -> PathBuf {
    if let Ok(p) = std::env::var("USERPROFILE") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    std::env::temp_dir()
}

fn kv(k: &str, v: impl ToString) -> (String, String) { (k.to_string(), v.to_string()) }

/* ---- 门 ---- */
#[tauri::command]
pub fn nf_sys_allow(fs: bool, run: bool, gate: tauri::State<SysGate>) -> Vec<bool> {
    gate.fs.store(fs, Ordering::SeqCst);
    gate.run.store(run, Ordering::SeqCst);
    vec![gate.fs.load(Ordering::SeqCst), gate.run.load(Ordering::SeqCst)]
}

fn need_fs(gate: &tauri::State<SysGate>) -> Result<(), String> {
    if gate.fs.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err("AI 的外部操作开关没打开（AI 面板 → 设置 → 允许 AI 操作本机）".into())
    }
}

/// 用户自己从「打开」对话框里挑过的文件。
///
/// 为什么单独有这么一份：打开一个几百 MB 的大工程**是用户自己的动作**，
/// 跟「允不允许 AI 操作本机」是两码事——不能为了开个自己的文件去开 AI 的门。
/// 只有用户在原生对话框里亲手选过的路径才会进来，进程一重启就清空。
#[derive(Default)]
pub struct Approved(pub Mutex<Vec<PathBuf>>);

fn same_path(a: &Path, b: &Path) -> bool {
    let ca = std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let cb = std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}

fn approve(p: &Path, st: &tauri::State<Approved>) {
    let mut v = st.0.lock().unwrap();
    if !v.iter().any(|x| same_path(x, p)) {
        v.push(p.to_path_buf());
    }
    while v.len() > 32 {
        v.remove(0);
    }
}

fn is_approved(p: &Path, st: &tauri::State<Approved>) -> bool {
    st.0.lock().unwrap().iter().any(|x| same_path(x, p))
}

/// 读文件的放行条件：要么 AI 那道「读写文件」的门开着，要么这个路径是用户自己选的。
fn need_fs_or_approved(
    gate: &tauri::State<SysGate>,
    p: &Path,
    st: &tauri::State<Approved>,
) -> Result<(), String> {
    if gate.fs.load(Ordering::SeqCst) || is_approved(p, st) {
        return Ok(());
    }
    Err("这个路径用户没选过，AI 的外部操作开关也没打开（AI 面板 → 设置 → 允许 AI 操作本机）；
或者用「文件 → 打开大工程（流式）」自己把文件选出来".into())
}

/// 让用户自己挑一个大工程文件：原生对话框选完就地「批准」这个路径，
/// 之后 nf_read_file 读它就不用开 AI 那道门。返回 (路径, 名字, 字节数)。
#[tauri::command]
pub fn nf_approve_file(approved: tauri::State<Approved>) -> Result<Vec<(String, String)>, String> {
    let 挑 = rfd::FileDialog::new()
        .set_title("打开大工程（流式：只读文件头，靠近的块才解压）")
        .add_filter("NeuroForge 工程", &["nforge"])
        .add_filter("全部文件", &["*"])
        .pick_file();
    let p = match 挑 {
        Some(p) => p,
        None => return Err("没有选文件".into()),
    };
    let size = std::fs::metadata(&p)
        .map_err(|e| format!("读不到大小：{}", e))?
        .len();
    approve(&p, &approved);
    Ok(vec![
        kv("path", p.to_string_lossy().to_string()),
        kv("name", p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()),
        kv("size", size),
    ])
}

/* ---- 探环境：不设门（只读 PATH 上的名字，不碰任何文件内容） ---- */
#[tauri::command]
pub fn nf_sys_info() -> Vec<(String, String)> {
    let home = home_dir();
    let exe = std::env::current_exe().ok();
    let mut v = vec![
        kv("os", if cfg!(windows) { "windows" } else { std::env::consts::OS }),
        kv("arch", std::env::consts::ARCH),
        kv("user", std::env::var("USERNAME").unwrap_or_default()),
        kv("home", home.to_string_lossy().to_string()),
        kv("cwd", std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()),
        kv("temp", std::env::temp_dir().to_string_lossy().to_string()),
        kv("documents", home.join("Documents").to_string_lossy().to_string()),
        kv("exe", exe.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()),
        kv("exe_dir", exe.as_ref().and_then(|p| p.parent()).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()),
    ];
    let mut notes: Vec<String> = Vec::new();
    let path = std::env::var("PATH").unwrap_or_default();
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    /* 这些名字只要在 PATH 上探到一个，就把绝对路径报回去：
       AI 得先知道这台机器上是 py 还是 python、有没有 git / curl，才敢往下写命令 */
    for tool in ["python", "python3", "py", "pip", "pip3", "node", "npm", "git", "curl", "tar", "7z", "unzip"] {
        let found = dirs.iter().find_map(|d| {
            for ext in [".exe", ".cmd", ".bat", ""] {
                let p = d.join(format!("{}{}", tool, ext));
                if p.is_file() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
            None
        });
        if let Some(p) = found.as_ref() {
            /* WindowsApps 里那个 python.exe 多半是 Microsoft Store 的"占位程序"：
               跑起来什么都不干（或者把商店弹出来）。标一句，别让 AI 以为这台机器有能用的 python。 */
            if p.to_lowercase().contains("\\windowsapps\\") {
                notes.push(format!("{} 在 WindowsApps 里，多半是 Microsoft Store 的占位程序（跑不出东西），先试 py", tool));
            }
        }
        v.push(kv(format!("tool:{}", tool).as_str(), found.unwrap_or_default()));
    }
    if !notes.is_empty() {
        v.push(kv("warn", notes.join("；")));
    }
    v
}

/* ---- 跑命令 ---- */
#[tauri::command]
pub fn nf_run(
    cmd: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    gate: tauri::State<SysGate>,
) -> Result<Vec<(String, String)>, String> {
    if !gate.run.load(Ordering::SeqCst) {
        return Err("AI 的「运行命令」开关没打开（AI 面板 → 设置 → 允许 AI 操作本机 → 运行命令）".into());
    }
    let raw = cmd.trim().to_string();
    if raw.is_empty() {
        return Err("命令是空的".into());
    }
    check_blocked(&raw)?;
    let dir = run_dir(&cwd);
    if !dir.is_dir() {
        return Err(format!("工作目录不存在：{}", dir.display()));
    }
    let t0 = Instant::now();
    /* 为什么把命令写进一个临时 .cmd 再跑，而不是直接 cmd /C "命令行"：
       cmd.exe 会把**命令行字符串本身**按控制台的 OEM 代码页转一遍，中文（UTF-8）到那儿就成乱码
       —— 实测 'echo 中文OK' 回来是 "????OK"。改成写进 .cmd 文件、文件头一行 chcp 65001，
       cmd 就按 UTF-8 读后面的内容，中文原样进、原样出。
       文件放临时目录（不脏工作目录），current_dir 仍然设成用户给的目录，
       所以 %CD% 和相对路径还是一样的。 */
    let script = write_cmd_script(&raw, "run")?;
    let mut c = Command::new("cmd");
    c.arg("/C").arg(&script)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => { let _ = std::fs::remove_file(&script); return Err(format!("命令起不来：{}", e)); }
    };
    /* 两路输出各自一个线程读走，不然管道塞满会把子进程噎住（死等超时） */
    let mut so = match child.stdout.take() {
        Some(o) => o,
        None => { let _ = std::fs::remove_file(&script); return Err("拿不到 stdout".into()); }
    };
    let mut se = match child.stderr.take() {
        Some(o) => o,
        None => { let _ = std::fs::remove_file(&script); return Err("拿不到 stderr".into()); }
    };
    let h_out = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = so.read_to_end(&mut v);
        v
    });
    let h_err = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = se.read_to_end(&mut v);
        v
    });
    let limit = timeout_ms.unwrap_or(RUN_TIMEOUT_DEFAULT).clamp(1000, RUN_TIMEOUT_MAX);
    let mut killed = false;
    let code: i32;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                code = st.code().unwrap_or(-1);
                break;
            }
            Ok(None) => {}
            Err(e) => { let _ = std::fs::remove_file(&script); return Err(format!("等命令结束出错：{}", e)); }
        }
        if t0.elapsed().as_millis() as u64 >= limit {
            let pid = child.id();
            /* 光杀 cmd 不够：它下面起的孙进程（ping / python / 常驻服务…）还攥着输出管道，
               会让下面 join 读线程时一直等下去——实测超时设 1.5 秒却等了 6.6 秒才回来。
               连整棵进程树一起杀，管道才会松开。
               注意顺序：**必须先 taskkill 再 kill**——先杀掉 cmd 的话，它就没法凭 PID 往下找树了
               （第一次写反了，结果一点没改善，实测才看出来）。 */
            #[cfg(windows)]
            {
                let mut tk = Command::new("taskkill");
                tk.arg("/F").arg("/T").arg("/PID").arg(pid.to_string())
                    .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                tk.creation_flags(CREATE_NO_WINDOW);
                let _ = tk.status();
            }
            let _ = child.kill();
            let _ = child.wait();
            killed = true;
            code = -1;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_file(&script);   /* 跑完就收拾干净 */
    let dl = Instant::now() + Duration::from_secs(5);
    while !(h_out.is_finished() && h_err.is_finished()) && Instant::now() < dl {
        std::thread::sleep(Duration::from_millis(20));
    }
    let lost = !(h_out.is_finished() && h_err.is_finished());
    let mut out = if h_out.is_finished() { h_out.join().unwrap_or_default() } else { Vec::new() };
    let mut err = if h_err.is_finished() { h_err.join().unwrap_or_default() } else { Vec::new() };
    if lost {
        err.extend_from_slice("\n[输出没读完：还有别的进程攥着管道，这次先返回已经拿到的部分]".as_bytes());
    }
    let mut truncated = lost;
    if out.len() > OUT_CAP {
        out.truncate(OUT_CAP);
        truncated = true;
    }
    if err.len() > OUT_CAP {
        err.truncate(OUT_CAP);
        truncated = true;
    }
    Ok(vec![
        kv("code", code),
        kv("killed", killed),
        kv("ms", t0.elapsed().as_millis() as u64),
        kv("cwd", dir.to_string_lossy().to_string()),
        kv("truncated", truncated),
        kv("cmd", raw),
        kv("out", String::from_utf8_lossy(&out).to_string()),
        kv("err", String::from_utf8_lossy(&err).to_string()),
    ])
}

/* ---- 按路径读文件（分块，页面自己拼） ---- */
#[tauri::command]
pub fn nf_read_file(
    path: String,
    offset: Option<u64>,
    len: Option<u64>,
    gate: tauri::State<SysGate>,
    approved: tauri::State<Approved>,
) -> Result<Vec<(String, String)>, String> {
    let p = PathBuf::from(path.trim());
    need_fs_or_approved(&gate, &p, &approved)?;
    let mut f = std::fs::File::open(&p).map_err(|e| format!("打不开 {}：{}", p.display(), e))?;
    let size = f.metadata().map_err(|e| format!("读不到大小：{}", e))?.len();
    let off = offset.unwrap_or(0).min(size);
    let want = len.unwrap_or(READ_CHUNK_MAX).clamp(1, READ_CHUNK_MAX).min(size - off);
    f.seek(SeekFrom::Start(off)).map_err(|e| format!("定位失败：{}", e))?;
    let mut buf = vec![0u8; want as usize];
    let mut got = 0usize;
    while got < buf.len() {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) => return Err(format!("读失败：{}", e)),
        }
    }
    buf.truncate(got);
    Ok(vec![
        kv("path", p.to_string_lossy().to_string()),
        kv("name", p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()),
        kv("size", size),
        kv("offset", off),
        kv("read", got),
        kv("eof", off + got as u64 >= size),
        kv("b64", b64_encode(&buf)),
    ])
}

/* ---- 按路径写文件（父目录不存在就建） ---- */
#[tauri::command]
pub fn nf_write_file(
    path: String,
    data: String,
    append: Option<bool>,
    gate: tauri::State<SysGate>,
) -> Result<Vec<(String, String)>, String> {
    need_fs(&gate)?;
    let p = PathBuf::from(path.trim());
    let bytes = crate::io_bus::b64_decode(&data)?;
    if bytes.len() > WRITE_MAX {
        return Err(format!("一次最多写 {} MB，这次有 {:.1} MB", WRITE_MAX / 1048576, bytes.len() as f64 / 1048576.0));
    }
    if let Some(d) = p.parent() {
        if !d.as_os_str().is_empty() && !d.exists() {
            std::fs::create_dir_all(d).map_err(|e| format!("建目录 {} 失败：{}", d.display(), e))?;
        }
    }
    /* append = true 时**缀在文件末尾**，不截断。
       为什么要它：一次能传的字节有上限（WRITE_MAX），而编译出来的 model.bin
       实测能到 300 MB 以上（16.8M 连接 + 时间展开的回边）。所以大文件由前端
       切成几段（第一段普通写、后面每段 append）分次送过来。
       用 OpenOptions + append 而不是"读出来再拼"：后者在 300 MB 上白吃一份内存。 */
    if append == Some(true) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .map_err(|e| format!("追加 {} 失败：{}", p.display(), e))?;
        f.write_all(&bytes).map_err(|e| format!("追加写 {} 失败：{}", p.display(), e))?;
    } else {
        std::fs::write(&p, &bytes).map_err(|e| format!("写 {} 失败：{}", p.display(), e))?;
    }
    let total = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(bytes.len() as u64);
    Ok(vec![
        kv("path", p.to_string_lossy().to_string()),
        kv("bytes", bytes.len()),
        kv("total", total),
    ])
}

/* ---- 列目录 ---- */
#[tauri::command]
pub fn nf_list_dir(path: Option<String>, gate: tauri::State<SysGate>) -> Result<Vec<(String, String, String)>, String> {
    need_fs(&gate)?;
    let dir: PathBuf = match path {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => home_dir(),
    };
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("列不了 {}：{}", dir.display(), e))?;
    let mut items: Vec<(String, String, String)> = Vec::new();
    for e in rd.flatten() {
        let md = e.metadata().ok();
        let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = md.as_ref().map(|m| m.len()).unwrap_or(0);
        items.push((
            e.file_name().to_string_lossy().to_string(),
            if is_dir { "dir".into() } else { "file".into() },
            if is_dir { String::new() } else { size.to_string() },
        ));
    }
    items.sort_by(|a, b| {
        let da = a.1 == "dir";
        let db = b.1 == "dir";
        db.cmp(&da).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });
    items.truncate(LIST_CAP);
    Ok(items)
}

/* ---- 下载：走系统自带的 curl，存到本机 ----
   为什么不自己写 HTTP：为一条下载引一套 TLS 依赖不划算（Windows 10 1803 之后自带 curl.exe）；
   探不到 curl 会明说。网址和路径按 argv 传、不经过 cmd，所以网址里的 & | > 不会被当成命令解析。 */
#[tauri::command]
pub fn nf_http_get(
    url: String,
    path: Option<String>,
    timeout_ms: Option<u64>,
    gate: tauri::State<SysGate>,
) -> Result<Vec<(String, String)>, String> {
    need_fs(&gate)?;
    let u = url.trim().to_string();
    if u.is_empty() {
        return Err("网址是空的".into());
    }
    let low = u.to_lowercase();
    if !(low.starts_with("http://") || low.starts_with("https://")) {
        return Err("只认 http / https 的网址".into());
    }
    let out: PathBuf = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => std::env::temp_dir().join("nf_download.tmp"),
    };
    if let Some(d) = out.parent() {
        if !d.as_os_str().is_empty() && !d.exists() {
            std::fs::create_dir_all(d).map_err(|e| format!("建目录 {} 失败：{}", d.display(), e))?;
        }
    }
    let secs = timeout_ms.unwrap_or(120_000).clamp(5_000, 600_000) / 1000;
    let t0 = Instant::now();
    let mut c = Command::new("curl");
    c.arg("-L")
        .arg("--fail")
        .arg("--silent")
        .arg("--show-error")
        .arg("--max-time")
        .arg(secs.to_string())
        .arg("-o")
        .arg(&out)
        .arg(&u)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let res = c.output().map_err(|e| {
        format!("起不来 curl（Windows 10 1803+ 自带 curl.exe；这台机器上没探到它）：{}", e)
    })?;
    if !res.status.success() {
        let msg = String::from_utf8_lossy(&res.stderr).trim().to_string();
        return Err(format!("下载失败（curl 退出码 {:?}）：{}",
            res.status.code(),
            if msg.is_empty() { "没有更多信息".to_string() } else { msg }));
    }
    let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    Ok(vec![
        kv("url", u),
        kv("path", out.to_string_lossy().to_string()),
        kv("bytes", bytes),
        kv("ms", t0.elapsed().as_millis() as u64),
    ])
}

/* ---- AI 的对话通道（给本机 / 内网的推理服务用）----
   为什么需要它：页面里的 fetch 要过同源策略（CORS）。Ollama / LM Studio / llama.cpp 默认
   不带跨域头，浏览器就直接报「连不上」——服务明明是好的。这条命令从 Rust 侧发出去，
   没有同源策略的问题；返回体原样带回给页面。

   为什么**不挂 SysGate**：这不是「AI 操作本机」那类动作，它就是 AI 对话自己的传输层；
   挂上那道门，用户一关外部操作连聊天都聊不了了。
   替代的边界是**只替回环 / 内网地址转发**（见 host_is_local）：公网地址页面直连就通，
   用不着它，也不该让这条通道变成任意 POST 的出口。

   为什么还是走 curl：跟下载那条一个理由——为一条转发引一整套 TLS 依赖不划算。 */
fn host_is_local(url: &str) -> bool {
    let low = url.trim().to_lowercase();
    let rest = match low.strip_prefix("http://").or_else(|| low.strip_prefix("https://")) {
        Some(r) => r,
        None => return false,
    };
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or("");
    let hostport = match hostport.rsplit('@').next() { Some(h) => h, None => hostport };
    let host = if let Some(h) = hostport.strip_prefix('[') {
        h.split(']').next().unwrap_or("")          /* [::1]:8080 */
    } else {
        hostport.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return false;
    }
    if host == "localhost" || host == "::1" || host == "0.0.0.0" || host == "host.docker.internal" {
        return true;
    }
    if host.starts_with("127.") || host.starts_with("10.") || host.starts_with("192.168.") {
        return true;
    }
    if let Some(second) = host.strip_prefix("172.").and_then(|r| r.split('.').next()) {
        if let Ok(n) = second.parse::<u32>() {
            if (16..=31).contains(&n) {
                return true;
            }
        }
    }
    for suf in [".local", ".lan", ".internal", ".home", ".localdomain"] {
        if host.ends_with(suf) {
            return true;
        }
    }
    false
}

#[tauri::command]
pub fn nf_ai_http(
    url: String,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    method: Option<String>,
) -> Result<Vec<(String, String)>, String> {
    let u = url.trim().to_string();
    if u.is_empty() {
        return Err("接口地址是空的".into());
    }
    let low = u.to_lowercase();
    if !(low.starts_with("http://") || low.starts_with("https://")) {
        return Err("只认 http / https 的地址".into());
    }
    if !host_is_local(&u) {
        return Err("这条通道只替本机 / 内网地址转发（公网地址页面自己就能直连）".into());
    }
    /* GET 也得能发：拉模型列表就是 GET /…/v1/models，全当 POST 发出去服务那边只会回 404，
       看起来像「服务没开」。其余动词一律按 POST 处理。 */
    let md = match method.unwrap_or_default().trim().to_uppercase().as_str() {
        "GET" => "GET",
        _ => "POST",
    };
    let is_post = md == "POST";
    /* 本地模型首 token 可能要等很久（尤其 CPU 上跑），默认给 10 分钟 */
    let secs = timeout_ms.unwrap_or(600_000).clamp(5_000, 1_800_000) / 1000;
    let seq = RUN_SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir();
    let bpath = dir.join(format!("nf_ai_body_{}_{}.json", std::process::id(), seq));
    let opath = dir.join(format!("nf_ai_resp_{}_{}.json", std::process::id(), seq));
    let payload = body.unwrap_or_default();
    if is_post {
        std::fs::write(&bpath, payload.as_bytes())
            .map_err(|e| format!("写临时请求体失败：{}", e))?;
    }
    let t0 = Instant::now();
    let mut c = Command::new("curl");
    c.arg("-s").arg("-S")
        .arg("--max-time").arg(secs.to_string())
        .arg("-X").arg(md)
        .arg("-H").arg("Content-Type: application/json");
    if let Some(hs) = headers {
        for (k, v) in hs {
            let kk = k.trim().to_string();
            /* 头里塞换行 = 头注入，直接丢掉那一条 */
            if kk.is_empty() || kk.contains('\n') || v.contains('\n') || v.contains('\r') {
                continue;
            }
            c.arg("-H").arg(format!("{}: {}", kk, v));
        }
    }
    if is_post {
        c.arg("--data-binary").arg(format!("@{}", bpath.display()));
    }
    c
        .arg("-o").arg(&opath)
        .arg("-w").arg("%{http_code}")
        .arg(&u)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let out = c.output();
    if is_post {
        let _ = std::fs::remove_file(&bpath);
    }
    let res = match out {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_file(&opath);
            return Err(format!("起不来 curl（Windows 10 1803+ 自带 curl.exe；这台机器上没探到它）：{}", e));
        }
    };
    let code_txt = String::from_utf8_lossy(&res.stdout).trim().to_string();
    let code: u32 = code_txt.parse().unwrap_or(0);
    let body_txt = std::fs::read_to_string(&opath).unwrap_or_default();
    let _ = std::fs::remove_file(&opath);
    if code == 0 {
        let msg = String::from_utf8_lossy(&res.stderr).trim().to_string();
        return Err(format!("发不出去（curl 退出码 {:?}）：{}", res.status.code(),
            if msg.is_empty() { "没有更多信息".to_string() } else { msg }));
    }
    Ok(vec![
        kv("url", u),
        kv("status", code),
        kv("body", body_txt),
        kv("ms", t0.elapsed().as_millis() as u64),
    ])
}
/* ============================================================================
   智能体那一层：后台任务 + 能改文件 + 能找文件
   ----------------------------------------------------------------------------
   为什么要有后台任务：装个 mujoco 要几分钟，一次 60 秒的同步调用根本装不完；
   而"等它跑完再返回"又会把对话卡死。所以长活一律丢后台：
     启动 → 立刻拿 id → 之后拿 id 轮询增量输出 → 不想要了就杀掉。
   输出只用一条合并缓冲（stderr 的块前面加 "[err] "），配一个绝对游标 cursor：
   页面记住上次读到哪，下次只取新增的那一段。游标是相对整条流的绝对位置，
   缓冲区满了从头丢字节时只把 base 往前挪，游标语义不变。
   ============================================================================ */

const JOB_BUF_CAP: usize = 2 * 1024 * 1024;
const JOBS_MAX: usize = 8;
const POLL_MAX_TEXT: usize = 200 * 1024;
const FIND_MAX_SCAN: usize = 40000;
const FIND_MAX_DEPTH: usize = 24;

struct Job {
    cmd: String,
    cwd: String,
    child: Child,
    buf: Arc<Mutex<Vec<u8>>>,
    base: Arc<AtomicU64>,
    done: Arc<AtomicBool>,
    code: Arc<AtomicI32>,
    t0: Instant,
}

/// 同时开着的后台任务。跟 SysGate 一样是进程内的，重启就没了。
pub struct Jobs {
    map: Mutex<HashMap<u64, Job>>,
    seq: AtomicU64,
}

impl Default for Jobs {
    fn default() -> Self {
        Jobs { map: Mutex::new(HashMap::new()), seq: AtomicU64::new(1) }
    }
}

fn job_push(buf: &Arc<Mutex<Vec<u8>>>, base: &Arc<AtomicU64>, data: &[u8]) {
    let mut b = buf.lock().unwrap();
    b.extend_from_slice(data);
    if b.len() > JOB_BUF_CAP {
        let cut = b.len() - JOB_BUF_CAP;
        b.drain(0..cut);
        base.fetch_add(cut as u64, Ordering::SeqCst);
    }
}

fn job_reader<R: Read + Send + 'static>(mut r: R, buf: Arc<Mutex<Vec<u8>>>, base: Arc<AtomicU64>, tag: &'static str) {
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if !tag.is_empty() {
                    job_push(&buf, &base, tag.as_bytes());
                }
                job_push(&buf, &base, &chunk[..n]);
            }
            Err(_) => break,
        }
    }
}

fn run_dir(cwd: &Option<String>) -> PathBuf {
    match cwd {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d.trim()),
        _ => home_dir(),
    }
}

/// 把命令写进一个临时 .cmd 再交给 cmd 跑。为什么不能直接 cmd /C "命令行"：
/// cmd.exe 会把命令行字符串本身按控制台 OEM 代码页转一遍，中文到那儿就是乱码
/// （实测 echo 中文OK → "????OK"）。文件头一行 chcp 65001，cmd 就按 UTF-8 读后面的内容。
fn write_cmd_script(raw: &str, tag: &str) -> Result<PathBuf, String> {
    let seq = RUN_SEQ.fetch_add(1, Ordering::SeqCst);
    let script = std::env::temp_dir().join(format!("nf_{}_{}_{}.cmd", tag, std::process::id(), seq));
    let body = format!("@echo off\r\nchcp 65001 >nul\r\n{}\r\n", raw);
    std::fs::write(&script, body.as_bytes())
        .map_err(|e| format!("临时脚本写不出去（{}）：{}", script.display(), e))?;
    Ok(script)
}

fn need_run(gate: &tauri::State<SysGate>) -> Result<(), String> {
    if gate.run.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err("AI 的「运行命令」开关没打开（AI 面板 → 设置 → 允许 AI 操作本机 → 运行命令）".into())
    }
}

fn check_blocked(raw: &str) -> Result<(), String> {
    let low = raw.to_lowercase();
    for b in BLOCKED {
        if low.contains(b) {
            return Err(format!("这条命令被拒了（命中危险写法「{}」）", b));
        }
    }
    Ok(())
}

/* ---- 起一个后台任务 ---- */
#[tauri::command]
pub fn nf_job_start(
    cmd: String,
    cwd: Option<String>,
    gate: tauri::State<SysGate>,
    jobs: tauri::State<Jobs>,
) -> Result<Vec<(String, String)>, String> {
    need_run(&gate)?;
    let raw = cmd.trim().to_string();
    if raw.is_empty() {
        return Err("命令是空的".into());
    }
    check_blocked(&raw)?;
    let dir = run_dir(&cwd);
    if !dir.is_dir() {
        return Err(format!("工作目录不存在：{}", dir.display()));
    }
    {
        let mut m = jobs.map.lock().unwrap();
        /* 先扫掉早就跑完的，别让它们一直占着名额 */
        m.retain(|_, j| !(j.done.load(Ordering::SeqCst) && j.t0.elapsed().as_secs() > 120));
        if m.len() >= JOBS_MAX {
            return Err(format!("同时最多 {} 个后台任务；先 job_kill 掉不用的，或者等旧任务过期", JOBS_MAX));
        }
    }
    let script = write_cmd_script(&raw, "job")?;
    let mut c = Command::new("cmd");
    c.arg("/C").arg(&script)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => { let _ = std::fs::remove_file(&script); return Err(format!("命令起不来：{}", e)); }
    };
    let buf = Arc::new(Mutex::new(Vec::new()));
    let base = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicBool::new(false));
    let code = Arc::new(AtomicI32::new(-1));
    if let Some(so) = child.stdout.take() {
        let b1 = buf.clone();
        let s1 = base.clone();
        std::thread::spawn(move || job_reader(so, b1, s1, ""));
    }
    if let Some(se) = child.stderr.take() {
        let b2 = buf.clone();
        let s2 = base.clone();
        std::thread::spawn(move || job_reader(se, b2, s2, "[err] "));
    }
    let id = jobs.seq.fetch_add(1, Ordering::SeqCst);
    jobs.map.lock().unwrap().insert(id, Job {
        cmd: raw.clone(),
        cwd: dir.to_string_lossy().to_string(),
        child,
        buf,
        base,
        done,
        code,
        t0: Instant::now(),
    });
    Ok(vec![
        kv("id", id),
        kv("cmd", raw),
        kv("cwd", dir.to_string_lossy().to_string()),
        kv("note", "已经在后台跑起来了。用 job_poll（带上 cursor）取增量输出"),
    ])
}

/* ---- 取增量输出（可以等一小会儿，省得空转轮询） ---- */
#[tauri::command]
pub fn nf_job_poll(
    id: u64,
    cursor: Option<u64>,
    wait_ms: Option<u64>,
    gate: tauri::State<SysGate>,
    jobs: tauri::State<Jobs>,
) -> Result<Vec<(String, String)>, String> {
    need_run(&gate)?;
    let cur = cursor.unwrap_or(0);
    let deadline = Instant::now() + Duration::from_millis(wait_ms.unwrap_or(0).min(30_000));
    loop {
        let mut m = jobs.map.lock().unwrap();
        let j = m.get_mut(&id).ok_or_else(|| format!("没有这个后台任务：{}（可能已经清掉了）", id))?;
        if !j.done.load(Ordering::SeqCst) {
            if let Ok(Some(st)) = j.child.try_wait() {
                j.done.store(true, Ordering::SeqCst);
                j.code.store(st.code().unwrap_or(-1), Ordering::SeqCst);
            }
        }
        let running = !j.done.load(Ordering::SeqCst);
        let base = j.base.load(Ordering::SeqCst);
        let total = base + j.buf.lock().unwrap().len() as u64;
        let has_new = total > cur;
        let out_of_time = Instant::now() >= deadline;
        if has_new || !running || out_of_time {
            let mut text = String::new();
            let mut next = cur;
            if has_new {
                let b = j.buf.lock().unwrap();
                let start = cur.saturating_sub(base) as usize;
                let mut slice = &b[start.min(b.len())..];
                if slice.len() > POLL_MAX_TEXT {
                    slice = &slice[..POLL_MAX_TEXT];
                }
                /* 游标只推到能完整解码的地方：不切开多字节字符，中文不会被劈成半个 */
                match std::str::from_utf8(slice) {
                    Ok(t) => { text.push_str(t); next = cur + slice.len() as u64; }
                    Err(e) => {
                        let ok = e.valid_up_to();
                        text.push_str(&String::from_utf8_lossy(&slice[..ok]));
                        if e.error_len().is_none() {
                            next = cur + ok as u64;   /* 尾巴是个没写完的字符，下次再来 */
                        } else {
                            text.push_str(&String::from_utf8_lossy(&slice[ok..]));
                            next = cur + slice.len() as u64;
                        }
                    }
                }
            }
            return Ok(vec![
                kv("id", id),
                kv("running", running),
                kv("code", j.code.load(Ordering::SeqCst)),
                kv("ms", j.t0.elapsed().as_millis() as u64),
                kv("cursor", next),
                kv("total", total),
                kv("dropped", base),
                kv("cmd", j.cmd.clone()),
                kv("cwd", j.cwd.clone()),
                kv("text", text),
            ]);
        }
        drop(m);
        std::thread::sleep(Duration::from_millis(40));
    }
}

/* ---- 杀掉一个后台任务（连它的子进程树一起） ---- */
#[tauri::command]
pub fn nf_job_kill(id: u64, gate: tauri::State<SysGate>, jobs: tauri::State<Jobs>) -> Result<Vec<(String, String)>, String> {
    need_run(&gate)?;
    let mut m = jobs.map.lock().unwrap();
    if !m.contains_key(&id) {
        return Err(format!("没有这个后台任务：{}（可能已经清掉了）", id));
    }
    /* 已经跑完的：这一下不是「杀」，是把它从名单里撤掉、把名额让出来。
       名额满了的时候提示里让人「先 job_kill 掉不用的」；要是跑完的那些清不掉，
       就成了说一套做一套：明明没在跑，却一直占着位置，第 9 条起不来。 */
    if m.get(&id).map(|j| j.done.load(Ordering::SeqCst)).unwrap_or(false) {
        let code = m.get(&id).map(|j| j.code.load(Ordering::SeqCst)).unwrap_or(-1);
        m.remove(&id);
        return Ok(vec![kv("id", id), kv("killed", false), kv("reaped", true),
                       kv("note", "它早就跑完了；这一下把它从名单里撤掉，名额让出来了"), kv("code", code)]);
    }
    let j = m.get_mut(&id).ok_or_else(|| format!("没有这个后台任务：{}", id))?;
    let pid = j.child.id();
    #[cfg(windows)]
    {
        let mut tk = Command::new("taskkill");
        tk.arg("/F").arg("/T").arg("/PID").arg(pid.to_string())
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        tk.creation_flags(CREATE_NO_WINDOW);
        let _ = tk.status();
    }
    let _ = j.child.kill();
    let _ = j.child.wait();
    j.done.store(true, Ordering::SeqCst);
    Ok(vec![kv("id", id), kv("killed", true), kv("cmd", j.cmd.clone())])
}

/* ---- 现在有哪些后台任务 ---- */
#[tauri::command]
pub fn nf_job_list(gate: tauri::State<SysGate>, jobs: tauri::State<Jobs>) -> Result<Vec<(String, String, String, String, String, String)>, String> {
    need_run(&gate)?;
    let mut m = jobs.map.lock().unwrap();
    let mut out = Vec::new();
    let ids: Vec<u64> = m.keys().cloned().collect();
    for id in ids {
        if let Some(j) = m.get_mut(&id) {
            if !j.done.load(Ordering::SeqCst) {
                if let Ok(Some(st)) = j.child.try_wait() {
                    j.done.store(true, Ordering::SeqCst);
                    j.code.store(st.code().unwrap_or(-1), Ordering::SeqCst);
                }
            }
            out.push((
                id.to_string(),
                j.cmd.clone(),
                if j.done.load(Ordering::SeqCst) { "done".to_string() } else { "running".to_string() },
                j.code.load(Ordering::SeqCst).to_string(),
                (j.t0.elapsed().as_millis() as u64).to_string(),
                j.base.load(Ordering::SeqCst).to_string(),
            ));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/* ============================================================================
   改文件 / 找文件：智能体干活真正需要的那几件
   整读整写一个几百行的文件又费 token 又容易把别的地方弄坏，所以要有"改一处"；
   要在一片目录里找东西，也不能靠一层层 list。
   ============================================================================ */

/// 通配符匹配：* 任意串、? 任意一个字符，不分大小写（Windows 上的直觉就是这样）
fn wild_match(pat: &str, s: &str) -> bool {
    let p: Vec<char> = pat.to_lowercase().chars().collect();
    let t: Vec<char> = s.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1; ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi; mark = ti; pi += 1;
        } else if star != usize::MAX {
            pi = star + 1; mark += 1; ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' { pi += 1; }
    pi == p.len()
}

fn is_probably_text(bytes: &[u8]) -> bool {
    let n = bytes.len().min(4096);
    if bytes[..n].contains(&0) { return false; }
    true
}

/* ---- 按路径找文件：按名字 / 按路径通配，或者在文件内容里搜 ---- */
#[tauri::command]
pub fn nf_find(
    root: String,
    pattern: String,
    mode: Option<String>,
    limit: Option<u32>,
    gate: tauri::State<SysGate>,
) -> Result<Vec<(String, String, String)>, String> {
    need_fs(&gate)?;
    let base = PathBuf::from(root.trim());
    if !base.is_dir() {
        return Err(format!("找不到这个目录：{}", base.display()));
    }
    let pat = pattern.trim().to_string();
    if pat.is_empty() { return Err("pattern 不能空".into()); }
    let md = mode.unwrap_or_else(|| "name".into()).to_lowercase();
    let lim = limit.unwrap_or(200).clamp(1, 2000) as usize;
    let t0 = Instant::now();
    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(base.clone(), 0)];
    let mut scanned = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= lim || scanned >= FIND_MAX_SCAN || t0.elapsed().as_secs() > 12 {
            break;
        }
        let rd = match std::fs::read_dir(&dir) { Ok(r) => r, Err(_) => continue };
        for e in rd.flatten() {
            if out.len() >= lim || scanned >= FIND_MAX_SCAN { break; }
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let md2 = match e.metadata() { Ok(m) => m, Err(_) => continue };
            let is_dir = md2.is_dir();
            if is_dir {
                if name == ".git" || depth >= FIND_MAX_DEPTH { continue; }
                let rel = p.strip_prefix(&base).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                if md == "path" && wild_match(&pat, &rel) {
                    out.push((rel.clone(), "dir".into(), String::new()));
                }
                stack.push((p, depth + 1));
                continue;
            }
            scanned += 1;
            let rel = p.strip_prefix(&base).unwrap_or(&p).to_string_lossy().replace('\\', "/");
            if md == "text" {
                if md2.len() > 8 * 1024 * 1024 { continue; }
                let bytes = match std::fs::read(&p) { Ok(b) => b, Err(_) => continue };
                if !is_probably_text(&bytes) { continue; }
                let txt = String::from_utf8_lossy(&bytes);
                let needle = pat.to_lowercase();
                let mut hits = 0;
                for (i, line) in txt.lines().enumerate() {
                    if line.to_lowercase().contains(&needle) {
                        out.push((rel.clone(), "hit".into(), format!("{}:{}", i + 1, line.trim().chars().take(200).collect::<String>())));
                        hits += 1;
                        if hits >= 20 { break; }
                    }
                    if out.len() >= lim { break; }
                }
            } else if md == "path" {
                if wild_match(&pat, &rel) { out.push((rel.clone(), "file".into(), md2.len().to_string())); }
            } else if wild_match(&pat, &name) {
                out.push((rel.clone(), "file".into(), md2.len().to_string()));
            }
        }
    }
    out.truncate(lim);
    Ok(out)
}

/* ---- 看一眼路径存不存在、多大 ---- */
#[tauri::command]
pub fn nf_stat(path: String, gate: tauri::State<SysGate>) -> Result<Vec<(String, String)>, String> {
    need_fs(&gate)?;
    let p = PathBuf::from(path.trim());
    match std::fs::metadata(&p) {
        Ok(m) => {
            let mt = m.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()).unwrap_or(0);
            Ok(vec![
                kv("path", p.to_string_lossy().to_string()),
                kv("exists", true),
                kv("kind", if m.is_dir() { "dir" } else { "file" }),
                kv("size", m.len()),
                kv("mtime", mt),
            ])
        }
        Err(_) => Ok(vec![kv("path", p.to_string_lossy().to_string()), kv("exists", false)]),
    }
}

/* ---- 建目录 ---- */
#[tauri::command]
pub fn nf_mkdir(path: String, gate: tauri::State<SysGate>) -> Result<Vec<(String, String)>, String> {
    need_fs(&gate)?;
    let p = PathBuf::from(path.trim());
    std::fs::create_dir_all(&p).map_err(|e| format!("建目录 {} 失败：{}", p.display(), e))?;
    Ok(vec![kv("path", p.to_string_lossy().to_string()), kv("ok", true)])
}

/* ---- 改文件里的一处（而不是整篇重写） ----
   跟 Codex 的编辑一个道理：find 必须一字不差、而且在文件里是唯一的，
   否则宁可报错让模型多写点上下文，也别把文件改坏。 */
#[tauri::command]
pub fn nf_edit_file(
    path: String,
    find: String,
    replace: Option<String>,
    all: Option<bool>,
    gate: tauri::State<SysGate>,
) -> Result<Vec<(String, String)>, String> {
    need_fs(&gate)?;
    let p = PathBuf::from(path.trim());
    if find.is_empty() { return Err("find 不能空".into()); }
    let bytes = std::fs::read(&p).map_err(|e| format!("读不了 {}：{}", p.display(), e))?;
    if bytes.len() > WRITE_MAX {
        return Err(format!("这个文件有 {:.1} MB，超过一次能改的上限（{} MB）", bytes.len() as f64 / 1048576.0, WRITE_MAX / 1048576));
    }
    let txt = String::from_utf8(bytes).map_err(|_| format!("{} 不是 UTF-8 文本（可能是二进制），先用 sys_read_text 看一眼", p.display()))?;
    let n = txt.matches(&find).count();
    if n == 0 {
        return Err("文件里没有这段内容。find 要一字不差（连缩进、换行都算），先 sys_read_text 看清楚再改".into());
    }
    if n > 1 && !all.unwrap_or(false) {
        return Err(format!("这段内容在文件里出现了 {} 处，不唯一。要么多带两行上下文把它变得唯一，要么 all=true 全改", n));
    }
    let rep = replace.unwrap_or_default();
    let out = if all.unwrap_or(false) { txt.replace(&find, &rep) } else { txt.replacen(&find, &rep, 1) };
    std::fs::write(&p, out.as_bytes()).map_err(|e| format!("写 {} 失败：{}", p.display(), e))?;
    Ok(vec![
        kv("path", p.to_string_lossy().to_string()),
        kv("changed", if all.unwrap_or(false) { n } else { 1 }),
        kv("found", n),
        kv("bytes", out.len()),
    ])
}

/* ==========================================================================
   5. 软件自己的配置与扩展（不走那两道门）
   --------------------------------------------------------------------------
   这两件事动的都是软件自己的目录（%APPDATA%\NeuroForge），不是「外部操作」，
   所以不吃 fs / run 那两道门。代价是只允许碰这一个目录：目录名由代码拼出来，
   页面传进来的名字还要过一道「只能当文件名」的检查（不许有分隔符、不许 ..）。

   为什么设置要落一份文件：API Key 之类的设置原本只存在 WebView2 的 localStorage
   （%LOCALAPPDATA%\com.neuroforge.editor\EBWebView\）。实测在同一个标识符上覆盖安装，
   localStorage 是留得住的（那是"升级不丢"那条底线）；但卸载重装、清浏览器数据、
   换标识符都带不走。所以现在**两边都写**：localStorage 管启动时的同步快路径，
   这个文件管"真的还在"，而且是一个你能直接复制备份的明文 JSON。
   ========================================================================== */
fn cfg_dir() -> Result<PathBuf, String> {
    let base = std::env::var("APPDATA").map_err(|_| "读不到 %APPDATA%，定位不了设置目录".to_string())?;
    let d = PathBuf::from(base).join("NeuroForge");
    std::fs::create_dir_all(&d).map_err(|e| format!("建不了设置目录 {}：{}", d.display(), e))?;
    Ok(d)
}
fn cfg_file() -> Result<PathBuf, String> { Ok(cfg_dir()?.join("settings.json")) }
/* 备份：只要这份配置里有 Key，就额外留一份在这里。两个文件各存一份，坏一个还有另一个 */
fn cfg_bak() -> Result<PathBuf, String> { Ok(cfg_dir()?.join("settings.bak.json")) }
fn tools_dir() -> Result<PathBuf, String> {
    let d = cfg_dir()?.join("tools");
    std::fs::create_dir_all(&d).map_err(|e| format!("建不了工具目录 {}：{}", d.display(), e))?;
    Ok(d)
}
/* 工具名只当文件名看：不许带分隔符、不许 .. 、不许 Windows 不认的字符 */
fn safe_tool_name(raw: &str) -> Result<String, String> {
    let mut n = raw.trim().to_string();
    if n.is_empty() { return Err("工具名不能空".into()); }
    if n.chars().count() > 64 { return Err("工具名太长（最多 64 个字符）".into()); }
    if n.contains('/') || n.contains('\\') || n.contains(':') || n.contains("..") {
        return Err("工具名只能是文件名，不能带路径（不许有 / \\ : ..）".into());
    }
    for c in ["<", ">", "\"", "|", "?", "*"] {
        if n.contains(c) { return Err("工具名里有 Windows 文件名不允许的字符".into()); }
    }
    if !n.ends_with(".js") { n.push_str(".js"); }
    Ok(n)
}
const CFG_MAX: usize = 1024 * 1024;
const TOOL_MAX: usize = 256 * 1024;
const TOOL_COUNT_MAX: usize = 64;

#[tauri::command]
pub fn nf_cfg_paths() -> Result<Vec<(String, String)>, String> {
    Ok(vec![
        kv("dir", cfg_dir()?.to_string_lossy().to_string()),
        kv("settings", cfg_file()?.to_string_lossy().to_string()),
        kv("bak", cfg_bak()?.to_string_lossy().to_string()),
        kv("tools", tools_dir()?.to_string_lossy().to_string()),
    ])
}

#[tauri::command]
pub fn nf_cfg_read() -> Result<String, String> { cfg_read_file(cfg_file()?) }

/* 备份那份也让人能读：设置被写坏时，界面可以拿它兜底 */
#[tauri::command]
pub fn nf_cfg_read_bak() -> Result<String, String> { cfg_read_file(cfg_bak()?) }

fn cfg_read_file(p: PathBuf) -> Result<String, String> {
    match std::fs::read(&p) {
        Ok(b) => {
            if b.len() > CFG_MAX { return Err("设置文件大得不像设置（超过 1 MB），没有读".into()); }
            Ok(String::from_utf8_lossy(&b).to_string())
        }
        Err(_) => Ok(String::new()),
    }
}

/* 先写临时文件再换名：写到一半断电也不会把好端端的设置留成半截 */
fn cfg_write_file(p: &PathBuf, text: &str) -> Result<(), String> {
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| format!("写不了 {}：{}", tmp.display(), e))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("换名失败 {}：{}", p.display(), e))
}

fn cfg_field(v: &serde_json::Value, name: &str) -> String {
    v.get(name).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/* 写设置。force = 用户在界面上明确按了「保存 / 清除 Key」，这时候才允许把 Key 写成空的。
   别的任何路径（开机同步、测试脚本、界面顺手一改）都不许把已有的 Key 抹掉：
   非空的 Key 只会被非空的 Key 换掉。这一条放在壳里，页面那侧写错了也丢不了。 */
#[tauri::command]
pub fn nf_cfg_write(text: String, force: Option<bool>) -> Result<Vec<(String, String)>, String> {
    if text.len() > CFG_MAX { return Err("设置超过 1 MB，没写".into()); }
    let force = force.unwrap_or(false);
    let main = cfg_file()?;
    let bak = cfg_bak()?;
    let mut want: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("这份设置不是 JSON，没写：{}", e))?;
    if !want.is_object() { return Err("这份设置不是 JSON 对象，没写".into()); }
    let cur = cfg_read_file(main.clone())?;
    let prev_bak = cfg_read_file(bak.clone())?;
    let cur_v: serde_json::Value = serde_json::from_str(&cur).unwrap_or(serde_json::Value::Null);
    let bak_v: serde_json::Value = serde_json::from_str(&prev_bak).unwrap_or(serde_json::Value::Null);
    let mut carried: usize = 0;
    if !force {
        for f in ["key", "visKey"] {
            if cfg_field(&want, f).is_empty() {
                let mut got = cfg_field(&cur_v, f);
                if got.is_empty() { got = cfg_field(&bak_v, f); }
                if !got.is_empty() {
                    want[f] = serde_json::Value::String(got);
                    if f == "key" { carried = 1; }
                }
            }
        }
    }
    let out = want.to_string();
    let key_len = cfg_field(&want, "key").chars().count();
    /* 备份的规矩：这份里有 Key 就留一份；用户明确清空时备份跟着一起清，
       不然下次自动写又把它捡回来，用户会以为删不掉。 */
    if key_len > 0 || force { cfg_write_file(&bak, &out)?; }
    cfg_write_file(&main, &out)?;
    Ok(vec![
        kv("path", main.to_string_lossy().to_string()),
        kv("bak", bak.to_string_lossy().to_string()),
        kv("bytes", out.len()),
        kv("keyLen", key_len),
        kv("carried", carried),
        kv("final", out),
    ])
}

#[tauri::command]
pub fn nf_tools_list() -> Result<Vec<(String, String, String)>, String> {
    let d = tools_dir()?;
    let mut paths: Vec<String> = Vec::new();
    let rd = match std::fs::read_dir(&d) { Ok(r) => r, Err(_) => return Ok(Vec::new()) };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().map(|x| x.eq_ignore_ascii_case("js")).unwrap_or(false) {
            paths.push(p.to_string_lossy().to_string());
        }
    }
    paths.sort();
    let mut out = Vec::new();
    for path in paths.into_iter().take(TOOL_COUNT_MAX) {
        let b = std::fs::read(&path).map_err(|e| format!("读不了 {}：{}", path, e))?;
        if b.len() > TOOL_MAX { return Err(format!("{} 超过 256 KB，没有加载", path)); }
        let name = PathBuf::from(&path).file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
        out.push((name, path, String::from_utf8_lossy(&b).to_string()));
    }
    Ok(out)
}

#[tauri::command]
pub fn nf_tools_write(name: String, code: String, gate: tauri::State<SysGate>) -> Result<Vec<(String, String)>, String> {
    need_fs(&gate)?;
    let n = safe_tool_name(&name)?;
    if code.len() > TOOL_MAX { return Err("一个工具最多 256 KB".into()); }
    let p = tools_dir()?.join(&n);
    std::fs::write(&p, code.as_bytes()).map_err(|e| format!("写不了 {}：{}", p.display(), e))?;
    Ok(vec![kv("name", n), kv("path", p.to_string_lossy().to_string()), kv("bytes", code.len())])
}

#[tauri::command]
pub fn nf_tools_delete(name: String, gate: tauri::State<SysGate>) -> Result<Vec<(String, String)>, String> {
    need_fs(&gate)?;
    let n = safe_tool_name(&name)?;
    let p = tools_dir()?.join(&n);
    let existed = p.exists();
    if existed { std::fs::remove_file(&p).map_err(|e| format!("删不掉 {}：{}", p.display(), e))?; }
    Ok(vec![kv("name", n), kv("deleted", existed)])
}
