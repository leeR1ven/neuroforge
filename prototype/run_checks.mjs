/* 无头批量校验：把所有 _*.html 校验页在真实 Chrome 里跑一遍，汇总结果。
   用法： node prototype/run_checks.mjs [--keep] [--only=selftest,chunk]
   依赖：本机装了 Chrome 或 Edge；playwright 从 Codex 运行时的 node_modules 里找。
   退出码 0 = 全过，1 = 有失败。 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const PORT = 8731;
const ROOT = "http://127.0.0.1:" + PORT + "/";
const OUT = path.resolve("_dump");

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

/* 页面清单：ok(title) 判断是否完成并通过；out = 结果 <pre> 的 id */
const PAGES = [
  { key: "selftest",  f: "_selftest.html",    pre: "nf-testout",    budget: 90,  ok: (t) => pf(t, "NFTEST ") },
  { key: "buildcheck", f: "_buildcheck.html", pre: "nf-buildout",   budget: 60,  ok: (t) => pf(t, "NFBUILD ") },
  { key: "blockcheck", f: "_blockcheck.html", pre: "nf-blkout",     budget: 60,  ok: (t) => t.startsWith("NFBLK OK") },
  { key: "crosscheck", f: "_crosscheck.html", pre: "nf-crossout",   budget: 60,  ok: (t) => t === "NFCROSS OK" },
  { key: "bincheck",   f: "_bincheck.html",   pre: null,            budget: 60,  ok: (t) => t.startsWith("NFBIN OK") },
  { key: "codegen",    f: "_codegen.html",    pre: null,            budget: 60,  ok: (t) => t.startsWith("NFGEN OK") },
  { key: "importcheck", f: "_importcheck.html", pre: "nf-importout", budget: 90, ok: (t) => t.startsWith("NFIMPORT OK") },
  { key: "chunkcheck", f: "_chunkcheck.html", pre: "nf-chunkout",   budget: 150, ok: (t) => pf(t, "NFCHUNK OK ") },
  { key: "opcheck",    f: "_opcheck.html",    pre: "nf-opout",      budget: 90,  ok: (t) => t.startsWith("NFOP OK") },
  /* 流式载入的标题后面还跟着样本信息，所以不用 pf 的 endsWith 判据 */
  { key: "streamcheck", f: "_streamcheck.html", pre: "nf-streamout", budget: 180,
    ok: (t) => /^NFSTREAM OK \d+P\/0F/.test(t) },
  { key: "compatcheck", f: "_compatcheck.html", pre: "nf-compatout", budget: 90, ok: (t) => pf(t, "NFCOMPAT ") },
  { key: "sesscheck",  f: "_sesscheck.html",  pre: "nf-sessout",  budget: 90, ok: (t) => pf(t, "NFSESS ") },
  { key: "plastcheck", f: "_plastcheck.html", pre: "nf-plastout", budget: 90, ok: (t) => pf(t, "NFPLAST ") },
  /* 可塑性对拍：这一页只负责把「学之前 / 学之后」的产物落盘，判分在 tools/verify_plastic.py */
  { key: "plastbin",  f: "_plastbin.html",   pre: null,            budget: 60,  ok: (t) => t.startsWith("NFPLASTBIN OK") },
  { key: "wmin", f: "_wmincheck.html", pre: "nf-wminout", budget: 120, ok: (t) => pf(t, "NFWMIN OK ") },
  { key: "appearcheck", f: "_appearcheck.html", pre: "nf-appearout", budget: 90, ok: (t) => pf(t, "NFAPPEAR ") },
  { key: "perf",       f: "_perf.html",       pre: "nf-perfout",    budget: 200, ok: (t) => t.includes("DONE") && !t.includes("ERR") },
];

const pf = (t, p) => t.startsWith(p) && t.endsWith("P/0F");

async function loadPlaywright() {
  try { return await import("playwright"); } catch (e) { /* 继续找 */ }
  const roots = [];
  const la = process.env.LOCALAPPDATA;
  if (la) {
    const base = la + "/OpenAI/Codex/runtimes/cua_node";
    if (fs.existsSync(base)) for (const d of fs.readdirSync(base)) roots.push(base + "/" + d + "/bin/node_modules/_probe.js");
  }
  roots.push(path.resolve("prototype/node_modules/_probe.js"));
  roots.push(path.resolve("node_modules/_probe.js"));
  const tried = [];
  for (const r of roots) {
    try { const m = createRequire(r)("playwright"); if (m && m.chromium) return m; }
    catch (e) { tried.push(r); }
  }
  throw new Error("找不到 playwright（试过：" + tried.length + " 个位置）。请先 npm i -D playwright。");
}

function pickBrowser() {
  const hit = BROWSERS.find((p) => fs.existsSync(p));
  if (!hit) throw new Error("找不到 Chrome / Edge 可执行文件。");
  return hit;
}

async function serverUp() {
  try { const r = await fetch(ROOT + "_selftest.html", { method: "HEAD" }); return r.ok; }
  catch (e) { return false; }
}

async function ensureServer() {
  if (await serverUp()) return { spawned: false };
  const p = spawn(process.execPath, ["prototype/_serve.mjs"], { stdio: "ignore", detached: false });
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); if (await serverUp()) return { spawned: true, proc: p }; }
  throw new Error("本地服务起不来（端口 " + PORT + "）");
}

async function waitDone(pg, page, ms) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = await pg.title();
    if (last && page.ok(last)) return last;
    if (last && (last.includes("ERR") || last.includes("BAD")) && last !== "NeuroForge 神经元搭建器 v0.1 (原型)") return last;
    await pg.waitForTimeout(200);
  }
  return last;
}

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const list = only.length ? PAGES.filter((p) => only.includes(p.key)) : PAGES;

const log = [];
const say = (s) => { log.push(s); console.log(s); };

let br = null, srv = null;
try {
  const pw = await loadPlaywright();
  const exe = pickBrowser();
  srv = await ensureServer();
  say("浏览器 " + exe);
  if (srv.spawned) say("已自动启动本地服务 :" + PORT);

  br = await pw.chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox", "--disable-gpu-sandbox"] });
  /* locale 必须显式给成中文：界面语言现在会跟着系统语言走（r60 起），
   不给的话无头 Chrome 默认报 en-US，整个自测页会切成英文、几百条中文文案断言全崩。
   给 zh-CN 才是这个软件真正的主场环境。 */
const pg = await br.newPage({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  const errs = [];
  /* 「探测本机」那一步会**故意**去连本机上没开的端口（11434 / 1234 / 8080 …），
     Chromium 会为每一次失败记一条 "Failed to load resource: net::ERR_CONNECTION_REFUSED"。
     那是这条功能预期内的输出，不是页面出错，所以单独计数、不算失败；但仍然打出来，不藏着。
     真正的页面错误（异常、ReferenceError、脚本报错）照旧算失败。 */
  const noise = [];
  /* 同类噪声的第二种：某个端口上**真的有服务在跑**、但它没开跨域（Ollama / LM Studio 默认就这样）。
     Chromium 会记一条 "blocked by CORS policy: No 'Access-Control-Allow-Origin'" + "net::ERR_FAILED"。
     这也是「探测本机」预期内的输出（桌面版这时会自己改走内部通道）；同样只计数、不算失败，但打出来。 */
  const noiseCors = [];
  const NOISE = /Failed to load resource: net::ERR_CONNECTION_REFUSED/;
  const NOISE_CORS = /blocked by CORS policy/;
  let sawCors = false;
  pg.on("pageerror", (e) => errs.push(String((e && e.message) || e).slice(0, 240)));
  pg.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = "console: " + m.text().slice(0, 240);
    if (NOISE.test(t)) { noise.push(t); return; }
    if (NOISE_CORS.test(t)) { sawCors = true; noiseCors.push(t); return; }
    if (sawCors && /net::ERR_FAILED/.test(t)) { noiseCors.push(t); return; }
    errs.push(t);
  });

  const gl = await (async () => { await pg.goto(ROOT + "_buildcheck.html", { waitUntil: "load" });
    return pg.evaluate(() => { const c = document.createElement("canvas"); const g = c.getContext("webgl2");
      if (!g) return "无 WebGL2"; const d = g.getExtension("WEBGL_debug_renderer_info");
      return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); }); })();
  say("GPU " + gl);

  let fail = 0;
  for (const page of list) {
    errs.length = 0;
    noise.length = 0;
    noiseCors.length = 0;
    sawCors = false;
    const t0 = Date.now();
    await pg.goto(ROOT + page.f + "?v=" + Date.now(), { waitUntil: "load", timeout: 45000 });
    const title = await waitDone(pg, page, page.budget * 1000);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const passed = page.ok(title);
    if (!passed) fail++;
    say((passed ? "PASS  " : "FAIL  ") + page.key.padEnd(12) + String(secs).padStart(6) + "s  " + title.slice(0, 180));
    if (page.pre) {
      const body = await pg.evaluate((id) => { const e = document.getElementById(id); return e ? e.textContent : ""; }, page.pre);
      const bad = body.split("\n").filter((l) => {
        const t = l.trim();
        return t.startsWith("FAIL") || t.startsWith("ERR") || t.startsWith("BAD") ||
          t.indexOf("| FAIL") >= 0 || t.indexOf("FAIL |") >= 0 || t.indexOf("不一致") >= 0;
      }).slice(0, 8);
      if (bad.length) { for (const l of bad) say("      ! " + l.slice(0, 200)); }
      const tail = body.trim().split("\n").slice(-2).join("  |  ");
      if (tail && !bad.length) say("        " + tail.slice(0, 200));
    }
    if (errs.length) { fail++; say("      页面报错 " + errs.slice(0, 3).join(" ; ").slice(0, 400)); }
    if (noise.length) say("      预期内：探本机端口试连失败 " + noise.length + " 次（不是页面报错，见 run_checks 里的说明）");
    if (noiseCors.length) say("      预期内：本机端口上有服务但没开跨域，被挡 " + noiseCors.length + " 次（桌面版会自动改走内部通道，浏览器版没有这条路）");
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "runchecks.txt"), log.join("\n"));
  say(fail ? ("合计 " + fail + " 项失败") : ("全部通过（" + list.length + " 个校验页）"));
  await br.close();
  if (srv && srv.spawned && srv.proc) srv.proc.kill();
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("run_checks 出错: " + String((e && e.stack) || e));
  try { if (br) await br.close(); } catch (x) { /* ignore */ }
  try { if (srv && srv.spawned && srv.proc) srv.proc.kill(); } catch (x) { /* ignore */ }
  process.exit(2);
}
