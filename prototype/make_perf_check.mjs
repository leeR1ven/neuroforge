import fs from "node:fs";

/* 生成 _perf.html：大图下的帧率 / 分档基准，用来验证 LOD 真的兜住了帧率。
   跑法：起 _serve.mjs，浏览器打开 /_perf.html，结果同时写进页面和 _dump/perf.txt。 */

const SRC = "prototype/\u795e\u7ecf\u5143\u7f16\u8f91\u5668\u539f\u578b.html";
const html = fs.readFileSync(SRC, "utf8");
if (!html.includes("</body>")) throw new Error("no </body>");
if (!html.includes("<head>")) throw new Error("no <head>");

const TEST = `
<script>
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(r));
  const out = [];
  try {
    if (document.readyState !== "complete") await new Promise(r => addEventListener("load", r));
    /* 先记下画这块的是软件光栅化还是真显卡——不然 8ms 还是 80ms 没法解读 */
    try { const gi = NF.glInfo(); out.push("GPU " + gi.renderer + " | 画布 " + gi.buffer.join("x")); } catch (e) {}
    await sleep(500);

    /* 默认压一个"大到会让人担心"的图：12 万神经元、约 60 万连接。
       想压自己机器的极限就加参数：_perf.html?n=500000&l=200&f=6 */
    const qs = new URLSearchParams(location.search);
    const qn = (k, d) => { const v = parseInt(qs.get(k), 10); return Number.isFinite(v) && v > 0 ? v : d; };
    /* 卡顿测量：记录每一帧的间隔，最长的那一次就是用户感觉到的"卡住"时长 */
    let maxGap = 0, recOn = true, lastT = performance.now();
    const tick = () => {
      const now = performance.now();
      if (recOn) { const gp = now - lastT; if (gp > maxGap) maxGap = gp; }
      lastT = now;
      requestAnimationFrame(tick);
    };
    lastT = performance.now();
    requestAnimationFrame(tick);

    const set = (id, v) => { document.getElementById(id).value = v; };
    const wantN = qn("n", 120000);
    /* 应用启动自带示例网络（22/94）：不清掉的话，点「生成测试网络」会弹整图替换确认框，
       测试里没人点，量出来的就是示例网络的假数字 —— 后面的帧率 / 分块数字全部不可信。 */
    NF.clear();
    set("gen-n", wantN); set("gen-l", qn("l", 160)); set("gen-f", qn("f", 5));
    const tg0 = performance.now();
    document.getElementById("gen-go").click();
    const genSync = performance.now() - tg0;
    await sleep(5000);
    recOn = false;
    const g = NF.graph();
    if (g.n < wantN) throw new Error("生成测试网络没生效：要 " + wantN + " 个神经元，只拿到 " + g.n + " 个（后面的数字不可信）");
    out.push("build N=" + g.n + " E=" + g.e + " heap=" + heap() +
      " | 生成同步耗时 " + genSync.toFixed(0) + "ms　生成到建场结束期间最长卡顿 " + maxGap.toFixed(0) + "ms");

    /* 框选连线：一次 O(连接数) 的扫描 + 一次批量标脏。大图里"拉个框选一片"必须还是一下就完事，
       不然用户按住一拖就卡住。这里量三种：正中一小块、整屏全框、以及神经元连线一起框。 */
    const mrc = document.querySelector("canvas").getBoundingClientRect();
    const mq = (x0, y0, x1, y1, opt) => {
      const t = performance.now();
      const r = NF.marquee(x0, y0, x1, y1, opt);
      return { ms: performance.now() - t, n: r.n, e: r.e };
    };
    NF.select([], []);
    await frame();
    const mMid = mq(mrc.left + mrc.width * 0.3, mrc.top + mrc.height * 0.3,
                    mrc.left + mrc.width * 0.7, mrc.top + mrc.height * 0.7, { what: "edges" });
    await frame();
    const mAll = mq(mrc.left, mrc.top, mrc.right, mrc.bottom, { what: "edges" });
    await frame();
    const tClr = performance.now();
    NF.select([], []);
    const mClr = performance.now() - tClr;
    await frame();
    const mBoth = mq(mrc.left, mrc.top, mrc.right, mrc.bottom);
    await frame();
    NF.select([], []);
    await frame();
    out.push("框选连线 E=" + NF.graph().e + "：正中一小块 " + mMid.e + " 条 " + mMid.ms.toFixed(1) + "ms" +
      " | 整屏 " + mAll.e + " 条 " + mAll.ms.toFixed(1) + "ms" +
      " | 两样一起框 " + mBoth.n + " 神经元 + " + mBoth.e + " 条 " + mBoth.ms.toFixed(1) + "ms" +
      " | 清空选择 " + mClr.toFixed(1) + "ms");

    const sample = async (n) => {
      const t = []; let last = performance.now();
      for (let i = 0; i < n; i++) { await frame(); const now = performance.now(); t.push(now - last); last = now; }
      t.sort((a, b) => a - b);
      return { p50: t[(n * 0.5) | 0], p95: t[(n * 0.95) | 0], max: t[n - 1] };
    };
    const report = async (where, tier) => {
      NF.setLod(tier);
      await sleep(250); await frame(); await frame();
      const s = await sample(60);
      /* 稳态读数要在 rebuild 之前取：rebuild 会把层打回未建状态，
         之后再读 chunkState 只能读到一个空的中间态。 */
      const ls = NF.lodState();
      const cs = NF.chunkState();
      const blk = "块 n " + cs.n.drew + "/" + cs.n.chunks + " cyl " + cs.cyl.drew + "/" + cs.cyl.chunks +
        (cs.line ? (" line " + cs.line.drew + "/" + cs.line.chunks) : "");
      /* 帧间隔被 vsync 钉在 16.7ms，量不出差别；纯绘制耗时才是真的 */
      for (let i = 0; i < 3; i++) NF.renderOnly();
      const dt0 = performance.now();
      for (let i = 0; i < 20; i++) NF.renderOnly();
      const drawMs = (performance.now() - dt0) / 20;
      const b = NF.rebuild();          /* 强制按当前档位重建一次，看各层耗时 */
      NF.setLod(tier);
      out.push(where + " " + tier + " -> " + ls.tier + " 建层=" + ls.builtMask + " | " + blk +
        " | 纯绘制=" + drawMs.toFixed(2) + "ms/帧" +
        " | 重建 总=" + b.total.toFixed(0) + " 球=" + b.n.toFixed(0) + " 细线=" + b.line.toFixed(0) + " 圆柱=" + b.cyl.toFixed(0) + " ms" +
        " | p50=" + s.p50.toFixed(1) + " p95=" + s.p95.toFixed(1) + " ms | heap=" + heap());
    };

    out.push("-- 近看（默认机位，神经元就在眼前）--");
    await report("NEAR", "auto");
    await report("NEAR", "high");

    /* 滚轮往外拉，直到看得见整个模型 */
    const c = document.getElementById("c");
    for (let k = 0; k < 60; k++) {
      c.dispatchEvent(new WheelEvent("wheel", { deltaY: 900, bubbles: true, cancelable: true }));
      if (k % 10 === 0) await frame();
    }
    await sleep(400);
    out.push("-- 远看（拉远看整体）--");
    await report("FAR", "auto");
    await report("FAR", "high");
    await report("FAR", "medium");
    await report("FAR", "low");
    NF.setLod("auto");
    await sleep(200);
    out.push("HUD " + (document.getElementById("hud") || {}).textContent.replace(/\\s+/g, " "));
    out.push("DONE");
  } catch (e) { out.push("ERR " + String((e && e.stack) || e)); }

  function heap() {
    return performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + "MB" : "n/a";
  }
  const pre = document.createElement("pre");
  pre.id = "nf-perfout";
  pre.textContent = out.join("\\n");
  pre.setAttribute("style", "position:fixed;left:0;top:0;z-index:99999;margin:0;padding:12px;background:#05070c;color:#ffd9a0;font:12px/1.5 Consolas,monospace;white-space:pre-wrap");
  document.body.appendChild(pre);
  try { await fetch("/__dump?name=perf.txt", { method: "POST", body: out.join("\\n") }); } catch (e) {}
  document.title = "NFPERF " + out.join(" | ");
})();
<\/script>
`;
const FRESH = '<' + 'script>try{localStorage.removeItem("nf.lang");}catch(e){}<' + '/script>';
fs.writeFileSync("prototype/_perf.html", html.replace("<head>", "<head>" + FRESH).replace("</body>", TEST + "</body>"));
console.log("\u5df2\u751f\u6210\u6027\u80fd\u57fa\u51c6\u9875 prototype/_perf.html");
