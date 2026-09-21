//! NeuroForge 通用接口：本地传输层
//!
//! 编辑器里的「接口运行时」负责把信号翻译成字节 / 从字节还原成信号，这里只管
//! 把字节真的搬进搬出。支持的传输方式：
//!
//!   udp    —— 绑一个本地端口收数据报（一个包一帧）；发送用临时套接字
//!   udpout —— 只发不收（发给别的程序）
//!   tcp    —— 起一个 TCP 服务端：谁连上来都能收发，发的时候广播给所有连接
//!   tcpc   —— 主动连到别的程序（Simulink / LabVIEW / Python 那种"我是服务端"的）
//!   serial —— 打开 COM 口，先调 mode 设好波特率再读写
//!
//! 收进来的数据一律按「帧」塞进总线：UDP 一个数据报一帧；TCP / 串口按换行分帧
//! （一直没换行就攒够 4096 字节切一帧，免得对数流卡住）。
//! 帧用 base64 传给页面：二进制信号（float32 这种）走 JSON 数组会膨胀十几倍。
//!
//! 为什么不引现成的 crate：这里要的就是 std::net + std::fs，不添依赖，编译快、
//! 离线也能编，行为完全看得见。系统按键那一段用 windows-sys 的 SendInput。

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/* ------------------------------------------------------------------ base64 */

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_char(v: u32) -> char { B64[(v & 63) as usize] as char }

pub fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0usize;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(b64_char(n >> 18));
        out.push(b64_char(n >> 12));
        out.push(b64_char(n >> 6));
        out.push(b64_char(n));
        i += 3;
    }
    let rest = data.len() - i;
    if rest == 1 {
        let n = (data[i] as u32) << 16;
        out.push(b64_char(n >> 18));
        out.push(b64_char(n >> 12));
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        out.push(b64_char(n >> 18));
        out.push(b64_char(n >> 12));
        out.push(b64_char(n >> 6));
        out.push('=');
    }
    out
}

fn b64_val(c: u8) -> i32 {
    match c {
        b'A'..=b'Z' => (c - b'A') as i32,
        b'a'..=b'z' => (c - b'a') as i32 + 26,
        b'0'..=b'9' => (c - b'0') as i32 + 52,
        b'+' => 62,
        b'/' => 63,
        _ => -1,
    }
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::with_capacity(s.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in s.as_bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' { continue; }
        let v = b64_val(c);
        if v < 0 { return Err(format!("base64 里有不认识的字符：{}", c as char)); }
        acc = (acc << 6) | (v as u32);
        bits += 6;
        if bits >= 8 { bits -= 8; out.push(((acc >> bits) & 0xFF) as u8); }
    }
    Ok(out)
}

/* --------------------------------------------------------------- 收件总线 */

/// 收进来的帧：(通道号, base64)。页面每 250 ms 来取一次，取走即清空。
#[derive(Clone, Default)]
pub struct IoBus(pub Arc<Mutex<Vec<(u32, String)>>>);

impl IoBus {
    fn push(&self, id: u32, b64: String) {
        if let Ok(mut v) = self.0.lock() {
            if v.len() >= 4096 { v.remove(0); }   /* 页面卡住时不能让内存无限涨 */
            v.push((id, b64));
        }
    }
}

/// 所有开着的通道。"发"的能力做成闭包，省掉一大坨 match。
pub struct Link {
    stop: Arc<AtomicBool>,
    send: Box<dyn Fn(&[u8]) -> Result<usize, String> + Send + Sync>,
    kind: String,
    desc: String,
}

#[derive(Default)]
pub struct IoLinks(pub Mutex<HashMap<u32, Link>>);

fn split_frames(acc: &mut Vec<u8>, id: u32, bus: &IoBus) {
    loop {
        if let Some(p) = acc.iter().position(|&b| b == b'\n') {
            let frame: Vec<u8> = acc.drain(..=p).collect();
            bus.push(id, b64_encode(&frame));
        } else if acc.len() >= 4096 {
            let frame: Vec<u8> = acc.drain(..).collect();
            bus.push(id, b64_encode(&frame));
        } else {
            break;
        }
    }
}

fn spawn_stream_recv(mut st: TcpStream, id: u32, bus: IoBus, stop: Arc<AtomicBool>, eof_breaks: bool) {
    std::thread::spawn(move || {
        let _ = st.set_read_timeout(Some(Duration::from_millis(150)));
        let mut acc: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 8192];
        while !stop.load(Ordering::SeqCst) {
            match st.read(&mut buf) {
                Ok(0) => {
                    if eof_breaks { break; }
                    std::thread::sleep(Duration::from_millis(40));
                }
                Ok(k) => {
                    acc.extend_from_slice(&buf[..k]);
                    split_frames(&mut acc, id, &bus);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => std::thread::sleep(Duration::from_millis(60)),
            }
        }
    });
}

fn spawn_serial_recv(mut f: File, id: u32, bus: IoBus, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut acc: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 4096];
        while !stop.load(Ordering::SeqCst) {
            match f.read(&mut buf) {
                Ok(0) => std::thread::sleep(Duration::from_millis(20)),
                Ok(k) => {
                    acc.extend_from_slice(&buf[..k]);
                    split_frames(&mut acc, id, &bus);
                }
                Err(_) => std::thread::sleep(Duration::from_millis(40)),
            }
        }
    });
}

fn resolve(addr: &str, port: u16) -> Result<std::net::SocketAddr, String> {
    let host = if addr.trim().is_empty() { "127.0.0.1" } else { addr.trim() };
    (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("地址 {}:{} 解析不了：{}", host, port, e))?
        .next()
        .ok_or_else(|| format!("地址 {}:{} 解析不出结果", host, port))
}

/* ----------------------------------------------------------------- 命令层 */

/// 打开一个通道。kind / addr / port / extra 由页面按传输方式给。
/// extra：串口写 "COM3:115200"，其它可不填。
#[tauri::command]
pub fn nf_io_open(
    id: u32,
    kind: String,
    addr: String,
    port: u16,
    extra: Option<String>,
    bus: tauri::State<IoBus>,
    links: tauri::State<IoLinks>,
) -> Result<String, String> {
    {
        let mut m = links.0.lock().unwrap();
        if let Some(l) = m.remove(&id) { l.stop.store(true, Ordering::SeqCst); }
    }
    let bus = bus.inner().clone();
    let stop = Arc::new(AtomicBool::new(false));
    let extra = extra.unwrap_or_default();

    match kind.as_str() {
        "udp" => {
            let sa = resolve(&addr, port)?;
            let sock = UdpSocket::bind(sa).map_err(|e| format!("UDP 绑不上 {}：{}", sa, e))?;
            let _ = sock.set_read_timeout(Some(Duration::from_millis(150)));
            let target = sa;
            let tx = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("UDP 发送套接字建不起来：{}", e))?;
            let s1 = stop.clone();
            let b1 = bus.clone();
            let recv = sock.try_clone().map_err(|e| e.to_string())?;
            std::thread::spawn(move || {
                let mut buf = vec![0u8; 65536];
                while !s1.load(Ordering::SeqCst) {
                    match recv.recv(&mut buf) {
                        Ok(k) if k > 0 => b1.push(id, b64_encode(&buf[..k])),
                        _ => {}
                    }
                }
            });
            let mut m = links.0.lock().unwrap();
            m.insert(id, Link {
                stop,
                send: Box::new(move |d: &[u8]| tx.send_to(d, target).map_err(|e| format!("UDP 发不出去：{}", e))),
                kind: "udp".into(),
                desc: format!("UDP 监听 {}", sa),
            });
            Ok(format!("UDP 已在 {} 上监听", sa))
        }
        "udpout" => {
            let sa = resolve(&addr, port)?;
            let tx = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("UDP 发送套接字建不起来：{}", e))?;
            let mut m = links.0.lock().unwrap();
            m.insert(id, Link {
                stop,
                send: Box::new(move |d: &[u8]| tx.send_to(d, sa).map_err(|e| format!("UDP 发不出去：{}", e))),
                kind: "udpout".into(),
                desc: format!("UDP 发往 {}", sa),
            });
            Ok(format!("UDP 发送已指向 {}", sa))
        }
        "tcp" => {
            let sa = resolve(&addr, port)?;
            let l = TcpListener::bind(sa).map_err(|e| format!("TCP 服务端绑不上 {}：{}", sa, e))?;
            let _ = l.set_nonblocking(true);
            let peers: Arc<Mutex<Vec<TcpStream>>> = Arc::new(Mutex::new(Vec::new()));
            let (peers_r, peers_s) = (peers.clone(), peers.clone());
            let (s1, s2) = (stop.clone(), stop.clone());
            let b1 = bus.clone();
            std::thread::spawn(move || {
                while !s1.load(Ordering::SeqCst) {
                    match l.accept() {
                        Ok((st, _)) => {
                            let _ = st.set_nodelay(true);
                            if let Ok(c) = st.try_clone() {
                                if let Ok(mut v) = peers_r.lock() { v.push(c); }
                                spawn_stream_recv(st, id, b1.clone(), s1.clone(), true);
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(60)),
                        Err(_) => std::thread::sleep(Duration::from_millis(150)),
                    }
                }
            });
            let mut m = links.0.lock().unwrap();
            m.insert(id, Link {
                stop: s2,
                send: Box::new(move |d: &[u8]| {
                    let mut v = peers_s.lock().map_err(|_| "连接表锁坏了".to_string())?;
                    v.retain(|s| s.peer_addr().is_ok());
                    if v.is_empty() { return Err("还没有任何程序连上来（TCP 服务端）".into()); }
                    let mut sent = 0usize;
                    for s in v.iter_mut() {
                        if let Ok(k) = s.write(d) { sent += k; }
                    }
                    Ok(sent)
                }),
                kind: "tcp".into(),
                desc: format!("TCP 服务端 {}", sa),
            });
            Ok(format!("TCP 服务端已在 {} 上监听", sa))
        }
        "tcpc" => {
            let sa = resolve(&addr, port)?;
            let st = TcpStream::connect_timeout(&sa, Duration::from_secs(4))
                .map_err(|e| format!("连不上 {}：{}", sa, e))?;
            let _ = st.set_nodelay(true);
            let w = st.try_clone().map_err(|e| e.to_string())?;
            let _ = w.set_write_timeout(Some(Duration::from_millis(800)));
            spawn_stream_recv(st, id, bus.clone(), stop.clone(), true);
            let mut m = links.0.lock().unwrap();
            m.insert(id, Link {
                stop,
                send: Box::new(move |d: &[u8]| {
                    let mut w2 = &w;
                    w2.write(d).map_err(|e| format!("TCP 发不出去：{}", e))
                }),
                kind: "tcpc".into(),
                desc: format!("TCP 客户端 {}", sa),
            });
            Ok(format!("已连上 {}", sa))
        }
        "serial" => {
            let spec = if extra.trim().is_empty() { "COM3:115200".to_string() } else { extra.clone() };
            let mut it = spec.split(':');
            let com = it.next().unwrap_or("COM3").trim().to_string();
            let baud = it.next().unwrap_or("115200").trim().to_string();
            /* 波特率交给系统的 mode 命令设：不用 unsafe，也不用引 DCB 那套结构 */
            let _ = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mode")
                .arg(format!("{}: BAUD={},PARITY=N,DATA=8,STOP=1", com.trim_end_matches(':'), baud))
                .output();
            let dev = format!(r"\\.\{}", com);
            let f = OpenOptions::new().read(true).write(true).open(&dev)
                .map_err(|e| format!("打不开串口 {}：{}（口对不对？被别的软件占了没？）", dev, e))?;
            let w = f.try_clone().map_err(|e| format!("串口复制句柄失败：{}", e))?;
            spawn_serial_recv(f, id, bus.clone(), stop.clone());
            let mut m = links.0.lock().unwrap();
            m.insert(id, Link {
                stop,
                send: Box::new(move |d: &[u8]| {
                    let mut w2 = &w;
                    w2.write(d).map_err(|e| format!("串口写不进去：{}", e))
                }),
                kind: "serial".into(),
                desc: format!("串口 {} @ {}", com, baud),
            });
            Ok(format!("串口 {} 已打开（{} 波特）", com, baud))
        }
        other => Err(format!("不认识的传输方式：{}", other)),
    }
}

#[tauri::command]
pub fn nf_io_close(id: u32, links: tauri::State<IoLinks>) -> Result<bool, String> {
    let mut m = links.0.lock().unwrap();
    match m.remove(&id) {
        Some(l) => { l.stop.store(true, Ordering::SeqCst); Ok(true) }
        None => Ok(false),
    }
}

/// 页面每次可以只关一部分；换工程时直接把所有通道关掉。
#[tauri::command]
pub fn nf_io_close_all(links: tauri::State<IoLinks>) -> Result<u32, String> {
    let mut m = links.0.lock().unwrap();
    let n = m.len() as u32;
    for (_, l) in m.drain() { l.stop.store(true, Ordering::SeqCst); }
    Ok(n)
}

#[tauri::command]
pub fn nf_io_send(id: u32, data: String, links: tauri::State<IoLinks>) -> Result<usize, String> {
    let bytes = b64_decode(&data)?;
    let m = links.0.lock().unwrap();
    let l = m.get(&id).ok_or_else(|| format!("通道 {} 还没打开", id))?;
    (l.send)(&bytes)
}

/// 取走这一拍收到的所有帧；取走即清空。
#[tauri::command]
pub fn nf_io_poll(bus: tauri::State<IoBus>) -> Vec<(u32, String)> {
    let mut out: Vec<(u32, String)> = Vec::new();
    if let Ok(mut v) = bus.0.lock() { std::mem::swap(&mut out, &mut *v); }
    out
}

#[tauri::command]
pub fn nf_io_links(links: tauri::State<IoLinks>) -> Vec<(u32, String, String)> {
    let m = links.0.lock().unwrap();
    let mut v: Vec<(u32, String, String)> = m.iter().map(|(k, l)| (*k, l.kind.clone(), l.desc.clone())).collect();
    v.sort_by_key(|x| x.0);
    v
}

/* ------------------------------------------------------- 系统按键（SendInput） */
#[cfg(windows)]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT;

#[cfg(windows)]
/// 浏览器 KeyboardEvent.code → Windows 虚拟键码。
/// 传进来的必须已经小写。认不出返回 None，交给下面那张 VK 名字表继续认。
fn vk_of_dom_code(n: &str) -> Option<u16> {
    let b = n.as_bytes();
    /* KeyA..KeyZ -> 0x41..0x5A */
    if n.len() == 4 && n.starts_with("key") && b[3].is_ascii_lowercase() {
        return Some(b[3].to_ascii_uppercase() as u16);
    }
    /* Digit0..Digit9 -> 0x30..0x39 */
    if n.len() == 6 && n.starts_with("digit") && b[5].is_ascii_digit() {
        return Some(b[5] as u16);
    }
    /* Numpad0..Numpad9 -> 0x60..0x69 */
    if n.len() == 7 && n.starts_with("numpad") && b[6].is_ascii_digit() {
        return Some(0x60 + (b[6] - b'0') as u16);
    }
    Some(match n {
        "arrowup" => 0x26, "arrowdown" => 0x28, "arrowleft" => 0x25, "arrowright" => 0x27,
        "escape" => 0x1B, "space" => 0x20, "enter" | "numpadenter" => 0x0D,
        "numpadadd" => 0x6B, "numpadsubtract" => 0x6D, "numpadmultiply" => 0x6A,
        "numpaddivide" => 0x6F, "numpaddecimal" => 0x6E,
        "capslock" => 0x14, "numlock" => 0x90, "scrolllock" => 0x91,
        "printscreen" => 0x2C, "pause" => 0x13, "contextmenu" => 0x5D,
        "controlleft" | "controlright" => 0x11,
        "shiftleft" | "shiftright" => 0x10,
        "altleft" | "altright" => 0x12,
        "metaleft" | "osleft" => 0x5B, "metaright" | "osright" => 0x5C,
        "minus" => 0xBD, "equal" => 0xBB, "bracketleft" => 0xDB, "bracketright" => 0xDD,
        "backslash" => 0xDC, "semicolon" => 0xBA, "quote" => 0xDE, "comma" => 0xBC,
        "period" => 0xBE, "slash" => 0xBF, "backquote" => 0xC0,
        _ => return None,
    })
}
#[cfg(windows)]
fn vk_of(name: &str) -> Option<u16> {
    let n = name.trim().to_ascii_lowercase();
    /* 页面采集键位存下来的是 KeyboardEvent.code（KeyZ / Digit1 / ArrowUp / Numpad5…），
       而下面那张表只认 VK 名字（z / 1 / up）。以前只认后者，于是「输出到外界 → 系统按键」
       对字母、数字、方向键一律报"不认识的键名"，只有 F5 / Enter 这种两边写法一样的能发出去。 */
    if let Some(v) = vk_of_dom_code(&n) {
        return Some(v);
    }
    if n.len() == 1 {
        let c = n.as_bytes()[0];
        if c.is_ascii_digit() { return Some(c as u16); }
        if c.is_ascii_alphabetic() { return Some(c.to_ascii_uppercase() as u16); }
    }
    if n.starts_with('f') && n.len() <= 3 {
        if let Ok(k) = n[1..].parse::<u16>() {
            if (1..=24).contains(&k) { return Some(0x70 + k - 1); }
        }
    }
    Some(match n.as_str() {
        "enter" | "return" => 0x0D,
        "space" => 0x20,
        "esc" | "escape" => 0x1B,
        "tab" => 0x09,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "insert" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "ctrl" | "control" => 0x11,
        "shift" => 0x10,
        "alt" => 0x12,
        "win" => 0x5B,
        _ => return None,
    })
}

#[cfg(windows)]
fn key_input(vk: u16, up: bool) -> INPUT {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP};
    let mut e: INPUT = unsafe { std::mem::zeroed() };
    e.r#type = INPUT_KEYBOARD;
    e.Anonymous.ki = KEYBDINPUT {
        wVk: vk,
        wScan: 0,
        dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
        time: 0,
        dwExtraInfo: 0,
    };
    e
}

/// 往**当前前台窗口**按键。seq 形如 "1" / "F5" / "ctrl+shift+s"。
/// 修饰键是真的按住，主键按完才松开——"按住 ctrl 再按 s"那种程序也认。
#[tauri::command]
pub fn send_keys(seq: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::SendInput;
        let parts: Vec<&str> = seq.split('+').map(|x| x.trim()).filter(|x| !x.is_empty()).collect();
        if parts.is_empty() { return Err("没有要按的键".into()); }
        let mut mods: Vec<u16> = Vec::new();
        let mut key: u16 = 0;
        for (i, p) in parts.iter().enumerate() {
            let v = vk_of(p).ok_or_else(|| format!("不认识的键名：{}", p))?;
            if i + 1 == parts.len() { key = v; } else { mods.push(v); }
        }
        let mut ins: Vec<INPUT> = Vec::with_capacity(mods.len() * 2 + 2);
        for &m in &mods { ins.push(key_input(m, false)); }
        ins.push(key_input(key, false));
        ins.push(key_input(key, true));
        for &m in mods.iter().rev() { ins.push(key_input(m, true)); }
        let n = unsafe { SendInput(ins.len() as u32, ins.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
        if n != ins.len() as u32 {
            return Err("SendInput 没送完（可能被安全软件拦了，或者目标窗口没在前台）".into());
        }
        Ok(format!("已发出 {}", seq))
    }
    #[cfg(not(windows))]
    {
        let _ = seq;
        Err("系统按键只在 Windows 上实现".into())
    }
}

/// 跟 send_keys 同一件事，留个显式的名字给「组合键」用。
#[tauri::command]
pub fn send_keys_combo(seq: String) -> Result<String, String> { send_keys(seq) }
