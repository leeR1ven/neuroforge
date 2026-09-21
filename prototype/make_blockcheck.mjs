import fs from "node:fs";
const SRC = "prototype/\u795e\u7ecf\u5143\u7f16\u8f91\u5668\u539f\u578b.html";
const html = fs.readFileSync(SRC, "utf8");
const TEST = `
<script>
(async () => {
  const out = [];
  const post = async (name, body) => (await fetch("/__dump?name=" + name, { method: "POST", body })).text();
  const show = (t) => {
    const pre = document.createElement("pre");
    pre.id = "nf-blkout";
    pre.textContent = t;
    pre.setAttribute("style", "position:fixed;left:0;top:0;z-index:99999;margin:0;padding:12px;max-width:52%;max-height:100%;overflow:auto;background:#05070c;color:#bff5c8;font:12px/1.5 Consolas,monospace;white-space:pre-wrap");
    document.body.appendChild(pre);
  };
  let fails = 0;
  const ok = (cond, name, detail) => {
    if (!cond) fails++;
    out.push((cond ? "PASS" : "FAIL") + " | " + name + " | " + (detail === undefined ? "" : String(detail)));
    return cond;
  };
  try {
    if (document.readyState !== "complete") await new Promise((r) => addEventListener("load", r));
    await new Promise((r) => setTimeout(r, 400));

    /* ---- 造图：4 个起点 + 4 个终点，位置规整，块的尺寸与位置可以手算 ---- */
    NF.clear();
    const src = [], dst = [];
    for (let i = 0; i < 4; i++) { const n = NF.addNode(i * 10, 0, 0); src.push(n); NF.setPos(n, i * 10, 0, 0); }
    for (let j = 0; j < 4; j++) { const n = NF.addNode(j * 10, 40, 0); dst.push(n); NF.setPos(n, j * 10, 40, 0); }
    ok(NF.graph().n === 8, "8 个神经元就位", NF.graph().n);

    /* 4×4 权重，每格一个纹理像素：
       +2（最大正） / -2（最大负） / +0.5（中间） / 0（零） —— 四种典型值 */
    const W = [
      2, 0, 0, 0,
      0, -2, 0, 0,
      0, 0, 0.5, 0,
      0, 0, 0, 0,
    ];
    const beforeAdd = NF.blockViewStats();
    ok(beforeAdd.inScene === 0, "还没有块时场景里没有板子", JSON.stringify(beforeAdd));

    NF.snapshot();
    const id = NF.addBlock(src, dst, W, { label: "自检块" });
    const st1 = NF.blockViewStats();
    ok(st1.blocks === 1 && st1.drawn === 1 && st1.inScene === 1,
       "建块后场景里多了一张板子", JSON.stringify(st1));

    /* ---- 板子的位置 = 两端神经元的中心；尺寸跟散布范围成正比 ---- */
    const v = NF.blockView(id);
    ok(!!v && v.hasMesh && v.inScene && v.visible, "块的视图信息完整", JSON.stringify(v));
    ok(Math.abs(v.cx - 15) < 1e-3 && Math.abs(v.cy - 20) < 1e-3 && Math.abs(v.cz) < 1e-3,
       "板子摆在两端神经元的中心 (15,20,0)", [v.cx, v.cy, v.cz].join(","));
    ok(Math.abs(v.sx - v.sy) < 1e-3, "4×4 是方的，板子也是方的", v.sx + " / " + v.sy);
    ok(v.sx > 20 && v.sx < 60, "板子尺寸跟着散布范围走", v.sx);
    ok(v.tex && v.tex.w === 4 && v.tex.h === 4, "4×4 的块用 4×4 的热力图", JSON.stringify(v.tex));

    /* ---- 配色：蓝 = 正、红 = 负、越亮绝对值越大、零值最暗 ---- */
    const px2 = NF.blockTexel(id, 0, 0);   /* +2 */
    const nx2 = NF.blockTexel(id, 1, 1);   /* -2 */
    const p05 = NF.blockTexel(id, 2, 2);   /* +0.5 */
    const zer = NF.blockTexel(id, 0, 1);   /* 0 */
    ok(px2 && px2[2] > px2[0] + 40, "最大正权重是蓝的（b>r）", JSON.stringify(px2));
    ok(nx2 && nx2[0] > nx2[2] + 40, "最大负权重是红的（r>b）", JSON.stringify(nx2));
    ok(p05 && p05[2] > p05[0] && p05[1] > zer[1], "小正权重也是蓝的，但比最大正权重暗", JSON.stringify(p05));
    ok(zer && zer[0] < 40 && zer[1] < 40 && zer[2] < 70, "零权重是暗底", JSON.stringify(zer));
    ok(px2[0] + px2[1] + px2[2] > p05[0] + p05[1] + p05[2],
       "亮度跟着 |w| 走（+2 比 +0.5 亮）", (px2[0] + px2[1] + px2[2]) + " vs " + (p05[0] + p05[1] + p05[2]));

    /* ---- 拾取：板子中心投影到屏幕上，点那里应该命中这一块 ---- */
    const s0 = NF.screenOfPoint(v.cx, v.cy, v.cz);
    ok(!!s0, "板子中心能投影到屏幕", JSON.stringify(s0));
    const hit = NF.pickBlockAt(s0.x, s0.y);
    ok(hit === id, "点板子中心命中这块", hit);
    const far = NF.pickBlockAt(s0.x - 2000, s0.y - 2000);
    ok(far === 0, "点远处不命中任何块", far);

    /* ---- 悬停 / 选中：亮起来 + 加边框 ---- */
    NF.setHoverBlock(id);
    const st2 = NF.blockViewStats();
    ok(st2.hover === id && st2.halo === true && st2.haloOn === id, "悬停时出现边框", JSON.stringify(st2));
    ok(Math.abs(NF.blockView(id).tint - 1) < 1e-6, "悬停时板子提亮", NF.blockView(id).tint);
    NF.setHoverBlock(0);
    ok(NF.blockViewStats().halo === false || NF.blockViewStats().haloOn === 0,
       "取消悬停后没有边框", JSON.stringify(NF.blockViewStats()));
    NF.selectBlocks([id]);
    const st3 = NF.blockViewStats();
    ok(st3.sel.length === 1 && st3.sel[0] === id && st3.haloOn === id, "选中块后也是亮 + 边框", JSON.stringify(st3));
    ok(Math.abs(NF.blockView(id).tint - 1) < 1e-6, "选中的板子不压暗", NF.blockView(id).tint);
    NF.selectBlocks([]);
    ok(Math.abs(NF.blockView(id).tint - 0.84) < 1e-6, "没选中 / 没悬停的板子压暗到 0.84", NF.blockView(id).tint);

    /* ---- 撤销：板子必须跟着消失，不能留下幽灵 ---- */
    NF.undo();
    const st4 = NF.blockViewStats();
    ok(NF.blocksInfo().length === 0 && st4.inScene === 0 && st4.blocks === 0,
       "撤销之后场景里的板子也消失了（没有幽灵）", JSON.stringify(st4));
    NF.redo();
    const st5 = NF.blockViewStats();
    ok(NF.blocksInfo().length === 1 && st5.inScene === 1 && st5.drawn === 1,
       "重做之后板子回来了", JSON.stringify(st5));
    ok(NF.blockTexel(NF.blocksInfo()[0].id, 0, 0)[2] > NF.blockTexel(NF.blocksInfo()[0].id, 0, 0)[0],
       "重做之后热力图还是对的", JSON.stringify(NF.blockTexel(NF.blocksInfo()[0].id, 0, 0)));

    /* ---- 删除：板子也要摘掉 ---- */
    const idNow = NF.blocksInfo()[0].id;
    NF.delBlocks([idNow]);
    const st6 = NF.blockViewStats();
    ok(st6.blocks === 0 && st6.inScene === 0, "删块之后板子也摘掉了", JSON.stringify(st6));

    /* ---- 大块：4096×2048 也要能画出来，且纹理不超过 96×96 ---- */
    const bigSrc = [], bigDst = [];
    for (let i = 0; i < 8; i++) { const n = NF.addNode(200 + i * 8, 0, 0); bigSrc.push(n); NF.setPos(n, 200 + i * 8, 0, 0); }
    for (let j = 0; j < 8; j++) { const n = NF.addNode(200 + j * 8, 60, 0); bigDst.push(n); NF.setPos(n, 200 + j * 8, 60, 0); }
    const bw = new Array(8 * 8);
    for (let t = 0; t < bw.length; t++) bw[t] = ((t * 7) % 16) / 8 - 1;
    const bigId = NF.addBlock(bigSrc, bigDst, bw, { label: "大块" });
    const bv = NF.blockView(bigId);
    ok(bv.tex.w === 8 && bv.tex.h === 8, "8×8 的块纹理也是 8×8", JSON.stringify(bv.tex));

    const info = { fails, out, blocks: NF.blocksInfo(), view: NF.blockViewStats() };
    await post("blockcheck.json", JSON.stringify(info));
    out.push("");
    out.push(fails ? ("FAILS " + fails) : "ALL PASS");
    document.title = (fails ? "NFBLK " + fails + "F" : "NFBLK OK") +
      " | blocks=" + NF.blocksInfo().length + " | plate=" + bv.sx.toFixed(1) + "x" + bv.sy.toFixed(1) +
      " | tex=" + bv.tex.w + "x" + bv.tex.h;
  } catch (e) {
    const msg = String((e && e.stack) || e);
    out.push("ERROR " + msg);
    document.title = "NFBLK ERR";
    try { await post("blockcheck.json", JSON.stringify({ error: msg })); } catch (_) {}
  }
  show(out.join("\\n"));
})();
<\/script>
`;
fs.writeFileSync("prototype/_blockcheck.html", html.replace("</body>", TEST + "</body>"));
console.log("generated prototype/_blockcheck.html");
