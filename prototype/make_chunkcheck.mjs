/* 生成 prototype/_chunkcheck.html：分块渲染与视锥剔除的验收页。
   分块剔剔除一旦算错，症状是"拉近看少了一块"——肉眼很难发现，所以这里全部对账：
     1) 块表自洽：每块画的实例范围正好是它那一段
     2) 包围盒真的框住自己的成员
     3) 被剔掉的块里没有任何落在视口里的神经元
     4) 同一视角下"开剔除 / 关剔除"逐像素一致（画面不能变）
   用法：打开页面等标题变成 NFCHUNK OK 或 NFCHUNK BAD。 */
import fs from "node:fs";
const SRC = "prototype/\u795e\u7ecf\u5143\u7f16\u8f91\u5668\u539f\u578b.html";
const html = fs.readFileSync(SRC, "utf8");
const TEST = `
<script>
(async () => {
  const out = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const pre = document.createElement("pre");
  pre.id = "nf-chunkout";
  pre.setAttribute("style", "position:fixed;left:0;top:0;z-index:99999;margin:0;padding:12px;max-width:52%;max-height:100%;overflow:auto;background:#05070c;color:#bff5c8;font:12px/1.5 Consolas,monospace;white-space:pre-wrap");
  document.body.appendChild(pre);
  const NL = String.fromCharCode(10);
  let pass = 0, fail = 0;
  const mark = (t) => { out.push(t); pre.textContent = out.join(NL); };
  const log = (ok, name, detail) => {
    if (ok) pass++; else fail++;
    mark((ok ? "PASS" : "FAIL") + " | " + name + (detail === undefined ? "" : " | " + detail));
  };
  const q = (k) => new URLSearchParams(location.search).get(k);
  const num = (k, d) => { const v = parseInt(q(k), 10); return isNaN(v) ? d : v; };
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(200); }
    return false;
  };
  try {
    if (document.readyState !== "complete") await new Promise(r => addEventListener("load", r));
    await sleep(400);
    /* 应用启动会自带一份示例网络（22 神经元 / 94 连接）。不清掉的话，下面点「生成测试网络」
       会弹一个整图替换的确认框；测试里没人点，于是这一页静默退化成「量示例网络」——
       分块数当然是 1、剔除当然剔不掉，几条断言全成了空测。必须自己先把图清干净。 */
    NF.clear();
    const wantN = num("n", 120000), wantL = num("l", 160), wantF = num("f", 5);
    mark("· 生成测试网络 " + wantN + " 神经元 / " + wantL + " 层 / 扇出 " + wantF);
    set("gen-n", wantN); set("gen-l", wantL); set("gen-f", wantF);
    document.getElementById("gen-go").click();
    const built = await waitFor(() => NF.graph().n >= wantN && !NF.debugScene().building, 120000);
    const g = NF.graph();
    if (g.n < wantN) throw new Error("生成测试网络没生效：要 " + wantN + " 个神经元，只拿到 " + g.n + " 个（后面的分块 / 剔除断言全是空测）");
    mark("· 图：" + g.n + " 神经元 / " + g.e + " 连接（构建完成=" + built + "）");
    NF.setLod("high");
    NF.rebuild();
    await sleep(200);

    /* ---- 1. 块表 ---- */
    const cs = NF.chunkState();
    mark("· 分块：" + JSON.stringify(cs));
    log(cs.n.chunks > 1, "神经元层被切成了多块", cs.n.chunks + " 块，每块 " + cs.chunkSize);
    log(cs.cyl.chunks > 0, "圆柱层也有块", cs.cyl.chunks + " 块");
    log(!!cs.line && cs.line.chunks > 0, "细线层也有块", cs.line ? cs.line.chunks + " 块" : "无");
    log(cs.chunkSize >= 1024 && cs.chunkSize <= 65536, "块宽在 [1024, 65536] 内", cs.chunkSize);
    log(cs.n.built === g.n && cs.cyl.built === g.e, "三条层都写到位了", cs.n.built + "/" + g.n + "  " + cs.cyl.built + "/" + g.e);

    /* ---- 2. 逐块对账 ---- */
    const cov = NF.chunkCoverage();
    log(cov.nRange === 0, "每块画的神经元实例数 == 它那一段", JSON.stringify(cov));
    log(cov.nBox === 0, "神经元块的包围盒框住了自己的成员", "越界块 " + cov.nBox + " / 共 " + cov.blocks);
    log(cov.eRange === 0, "每块画的圆柱实例数 == 它那一段", "错 " + cov.eRange);
    log(cov.lineRange === 0, "细线层的 drawRange == 它那一段", "错 " + cov.lineRange);
    log(cov.eBox === 0, "连线块的包围盒框住了两端", "越界块 " + cov.eBox);

    /* ---- 3. 找一个覆盖全图的包围盒，用来摆相机 ---- */
    const step = Math.max(1, Math.floor(g.n / 4000));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < g.n; i += step) {
      const p = NF.node(i);
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const span = Math.max(x1 - x0, y1 - y0, z1 - z0, 1);
    mark("· 模型范围 x " + x0.toFixed(0) + ".." + x1.toFixed(0) + "，尺度 " + span.toFixed(0));

    /* ---- 4. 拉近看一端 ---- */
    NF.cull(true);
    NF.setCam(x0 + span * 0.06, cy + span * 0.05, cz + span * 0.22, x0 + span * 0.02, cy, cz);
    await sleep(120);
    const near = NF.cullSafety();
    mark("· 近看：" + JSON.stringify(near));
    log(near.drawn > 0, "近看时还有块在画", near.drawn + " 块");
    log(near.hiddenChunks > 0, "近看时确实剔掉了一些块", "剔掉 " + near.hiddenChunks + " / " + near.total);
    log(near.leaks === 0, "被剔掉的块里没有落在视口里的神经元", "漏 " + near.leaks + " 块");
    const imgNearOn = NF.grabFrame();
    NF.cull(false);
    const imgNearOff = NF.grabFrame();
    const dNear = NF.pixelDiff(imgNearOn, imgNearOff);
    log(dNear === 0, "近看：开 / 关剔除逐像素一致", "差异像素 " + dNear);
    NF.cull(true);

    /* ---- 5. 拉远看全图 ---- */
    const dist = span * 1.6;
    NF.setCam(cx, cy + dist * 0.35, cz + dist, cx, cy, cz);
    await sleep(120);
    const far = NF.cullSafety();
    mark("· 远看：" + JSON.stringify(far));
    log(far.leaks === 0, "远看时被剔掉的块也没有漏网的", "漏 " + far.leaks);
    log(far.drawn >= near.drawn, "远看画的块不少于近看", far.drawn + " >= " + near.drawn);
    const imgFarOn = NF.grabFrame();
    NF.cull(false);
    const imgFarOff = NF.grabFrame();
    const dFar = NF.pixelDiff(imgFarOn, imgFarOff);
    log(dFar === 0, "远看：开 / 关剔除逐像素一致", "差异像素 " + dFar);
    NF.cull(true);

    /* ---- 6. 剔除确实省了工作量 ---- */
    const saved = near.total - near.drawn;
    log(saved > 0, "近看时省下的块会真的少提交 draw call", "少提交 " + saved + " 块");
    /* 7. 省下的块是不是真的变成了开销下降：同一视角下开 / 关剔除各画几批，每批取最小值。
       两件事要说清楚：
         a. 帧间隔被 vsync 钉在 16.7 ms，量不出差别，只能量"每帧提交出去的开销"；
         b. WebGL 是异步的，gl.finish() 并不保证等到 GPU 真干完，所以这个数字是
            CPU 提交耗时，不是 GPU 耗时。块级剔除省的是 draw call 提交。 */
    /* 开 / 关剔除交替采样：单边连跑会撞上机器上的漂移（别的进程起伏、热降频），
       各跑 3 批取最小仍是五五开地随机翻车。交替采样能把共模漂移抵掉，剩下的差别
       才是剔除本身带来的。 */
    const reps = num("reps", 30);
    const batches = num("batches", 6);
    const sample = (cull) => {
      NF.cull(cull);
      NF.renderOnly();
      const t0 = performance.now();
      for (let k = 0; k < reps; k++) NF.renderOnly();
      return (performance.now() - t0) / reps;
    };
    NF.setCam(x0 + span * 0.06, cy + span * 0.05, cz + span * 0.22, x0 + span * 0.02, cy, cz);
    let msOn = Infinity, msOff = Infinity;
    for (let batch = 0; batch < batches; batch++) {
      const a = sample(true); if (a < msOn) msOn = a;
      const b = sample(false); if (b < msOff) msOff = b;
    }
    NF.cull(true);
    mark("· 近看每帧提交耗时（开/关交替 " + batches + " 轮 × 各 " + reps + " 帧，各取最小）：开剔除 " + msOn.toFixed(3) + " ms，关剔除 " + msOff.toFixed(3) + " ms");
    /* 到 12 万神经元这个量级，剔除省下的 draw call 只有几十微秒，跟测量噪声同一量级，
       「几倍差距」是量不出来的（曾经报过 4 倍，回看是噪声）。这里只能说：开剔除没有
       带来可见的额外开销。真正省了多少块，看上面那条确定的断言。 */
    const noise = Math.max(0.04, msOff * 1.5);
    log(msOn <= msOff + noise, "块级剔除没有可见的额外开销（差值落在测量噪声带内）",
        msOn.toFixed(3) + " vs " + msOff.toFixed(3) + " ms/帧；噪声带 ±" + noise.toFixed(3) +
        "，量到的差 " + (msOn - msOff >= 0 ? "+" : "") + (msOn - msOff).toFixed(3) + " ms");
    mark("· 合计 " + pass + " PASS / " + fail + " FAIL");
    document.title = (fail ? "NFCHUNK BAD " + fail + "F" : "NFCHUNK OK") + " " + pass + "P/" + fail + "F";
  } catch (e) {
    mark("ERROR " + String((e && e.stack) || e));
    document.title = "NFCHUNK ERR " + String((e && e.message) || e).slice(0, 80);
  }
})();
</script>
`;
fs.writeFileSync("prototype/_chunkcheck.html", html.replace("</body>", TEST + "</body>"));
console.log("generated prototype/_chunkcheck.html");
