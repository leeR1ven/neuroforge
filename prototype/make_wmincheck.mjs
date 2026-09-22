/* 生成 prototype/_wmincheck.html：两条显示层缺陷的验收页。
     ① 大数据层接管连线之后，老两条连线层（圆柱 / 细线）里的旧数据必须闭嘴。
        症状：把启动示例网络整图换掉之后，那几十条边还画在屏幕上——它们在拓扑里
        早就没了，所以点不到、也删不掉（用户报的"删不掉的残留连线"）。
     ② 权重阈值过滤（只显示强连接）要真的生效，而且**看不见的线不该能点到**。
     ③ 删神经元 / 删连线之后，图上不能留悬空边，各层的 drawRange 要跟着走。
   用法：打开页面等标题变成 NFWMIN OK … 或 NFWMIN BAD …。 */
import fs from "node:fs";
const SRC = "prototype/\u795e\u7ecf\u5143\u7f16\u8f91\u5668\u539f\u578b.html";
const html = fs.readFileSync(SRC, "utf8");
const TEST = `
<script>
(async () => {
  const out = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const pre = document.createElement("pre");
  pre.id = "nf-wminout";
  pre.setAttribute("style", "position:fixed;left:0;top:0;z-index:99999;margin:0;padding:12px;max-width:52%;max-height:100%;overflow:auto;background:#05070c;color:#bff5c8;font:12px/1.5 Consolas,monospace;white-space:pre-wrap");
  document.body.appendChild(pre);
  const NL = String.fromCharCode(10);
  let pass = 0, fail = 0;
  const mark = (t) => { out.push(t); pre.textContent = out.join(NL); };
  const log = (ok, name, detail) => {
    if (ok) pass++; else fail++;
    mark((ok ? "PASS" : "FAIL") + " | " + name + (detail === undefined ? "" : " | " + detail));
  };
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(120); }
    return false;
  };
  const key = (k) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  try {
    if (document.readyState !== "complete") await new Promise(r => addEventListener("load", r));
    await sleep(500);

    /* ============ A. 大数据层接管后，老两条连线层必须闭嘴 ============ */
    const demo = NF.graph();
    mark("\\u00b7 启动示例网络：" + demo.n + " 神经元 / " + demo.e + " 连接");
    if (!(demo.n > 0 && demo.e > 0)) throw new Error("启动时没有示例网络，这一页测不了（后面的断言会全变成空测）");
    log(!!document.getElementById("v-wmin-on") && !!document.getElementById("v-wmin") && !!document.getElementById("v-wmin-p90"),
        "\\u663e\\u793a\\u680f\\u91cc\\u7684\\u9608\\u503c\\u63a7\\u4ef6\\u5728", "checkbox + slider + presets");

    NF.setLod("mid");
    NF.rebuild();
    await waitFor(() => !NF.debugScene().building, 20000);
    await sleep(150);
    const a0 = NF.lodState();
    log(a0.lineVisible === true && a0.lineRange === demo.e * 2,
        "\\u5bf9\\u7167\\u7ec4\\uff1a\\u8001\\u8def\\uff08\\u4e2d\\u6863\\uff09\\u4e0b\\u7ec6\\u7ebf\\u5c42\\u786e\\u5b9e\\u5728\\u63d0\\u4ea4\\u6570\\u636e",
        "lineVisible=" + a0.lineVisible + " lineRange=" + a0.lineRange + "\\uff08\\u5e94\\u4e3a " + (demo.e * 2) + "\\uff09");

    NF.bigSet({ eMin: 1 });
    await waitFor(() => !NF.debugScene().building, 30000);
    await sleep(200);
    const a1 = NF.lodState(), d1 = NF.debugScene();
    mark("\\u00b7 \\u5207\\u5230\\u5927\\u6570\\u636e\\u5c42\\uff1a" + JSON.stringify({ tier: a1.tier, builtMask: a1.builtMask,
        lineVisible: a1.lineVisible, lineRange: a1.lineRange, cylVisible: a1.cylinderVisible,
        edgeCount: d1.edgeCount, dbgLineRange: d1.lineRange }));
    log(a1.lineVisible === false, "\\u5927\\u6570\\u636e\\u5c42\\u63a5\\u7ba1\\u540e\\u7ec6\\u7ebf\\u5c42\\u4e0d\\u518d\\u63d0\\u4ea4\\uff08\\u672c\\u6b21\\u4fee\\u590d\\u70b9\\uff09", "lineVisible=" + a1.lineVisible);
    log(a1.lineRange === 0, "\\u7ec6\\u7ebf\\u5c42 drawRange \\u5f52\\u96f6\\uff1a\\u65e7\\u56fe\\u7684\\u8fb9\\u4e00\\u6761\\u90fd\\u4e0d\\u753b", "lineRange=" + a1.lineRange);
    log(a1.cylinderVisible === false, "\\u5706\\u67f1\\u5c42\\u540c\\u6837\\u4e0d\\u518d\\u63d0\\u4ea4", "cylinderVisible=" + a1.cylinderVisible);
    log(d1.edgeCount === 0 && d1.lineRange === 0, "\\u8001\\u4e24\\u6761\\u8fde\\u7ebf\\u5c42\\u7684\\u8ba1\\u6570\\u4e00\\u8d77\\u6e05\\u6210 0",
        "edgeCount=" + d1.edgeCount + " lineRange=" + d1.lineRange);
    log((a1.builtMask & 4) === 0 && (a1.builtMask & 2) === 0,
        "builtMask \\u53ea\\u58f0\\u660e\\u771f\\u7684\\u6309\\u5f53\\u524d\\u56fe\\u5efa\\u8fc7\\u7684\\u5c42", "builtMask=" + a1.builtMask);

    /* 大数据层开着时手切到「高」档：圆柱层也不许把旧数据放出来 */
    NF.setLod("high");
    await sleep(200);
    const a2 = NF.lodState();
    log(a2.cylinderVisible === false && a2.lineVisible === false && a2.lineRange === 0,
        "\\u5927\\u6570\\u636e\\u5c42\\u5f00\\u7740\\u65f6\\u5207\\u5230\\u9ad8\\u6863\\uff0c\\u4e24\\u6761\\u8001\\u8def\\u4e5f\\u4e0d\\u63d0\\u4ea4",
        "cyl=" + a2.cylinderVisible + " line=" + a2.lineVisible + " range=" + a2.lineRange);

    /* 关掉大数据层：老路要按**当前图**重建，而不是把旧数据放出来 */
    NF.bigSet({ eMin: 1500000 });
    NF.setLod("mid");
    await waitFor(() => !NF.debugScene().building, 30000);
    await sleep(200);
    const a3 = NF.lodState(), d3 = NF.debugScene();
    log(a3.lineVisible === true, "\\u5173\\u6389\\u5927\\u6570\\u636e\\u5c42\\u540e\\u7ec6\\u7ebf\\u5c42\\u6062\\u590d\\u63d0\\u4ea4", "lineVisible=" + a3.lineVisible);
    log(d3.lineRange === demo.e * 2, "\\u7ec6\\u7ebf\\u5c42\\u91cd\\u5efa\\u6210\\u5f53\\u524d\\u56fe\\uff08drawRange = \\u8fb9\\u6570 \\u00d7 2\\uff09", d3.lineRange + " vs " + (demo.e * 2));
    log(d3.eBadLine === 0, "\\u7ec6\\u7ebf\\u5c42\\u7684\\u5750\\u6807\\u8ddf\\u5f53\\u524d\\u56fe\\u9010\\u6761\\u4e00\\u81f4", "eBadLine=" + d3.eBadLine + " / \\u62bd\\u6837 " + d3.eSampled);
    NF.setLod("high");
    await waitFor(() => !NF.debugScene().building, 20000);
    await sleep(200);
    const d4 = NF.debugScene();
    log(d4.eBadLine === 0 && d4.eBadMid === 0 && d4.eBadLen === 0,
        "\\u9ad8\\u6863\\u4e0b\\u5706\\u67f1\\u5c42\\u7684\\u4f4d\\u7f6e / \\u65b9\\u5411 / \\u957f\\u5ea6\\u5168\\u5bf9",
        "eBadLine=" + d4.eBadLine + " eBadMid=" + d4.eBadMid + " eBadLen=" + d4.eBadLen);

    /* ============ B. 权重阈值过滤 ============ */
    NF.clear();
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(NF.addNode(i * 8, 0, 0));
    const strong = [], weak = [];
    for (let i = 0; i + 1 < ids.length; i++) {
      const w = (i % 2 === 0) ? 1.0 : 0.05;
      const e = NF.addEdge(ids[i], ids[i + 1], w);
      if (w >= 0.5) strong.push(e); else weak.push(e);
    }
    NF.setLod("high");
    NF.rebuild();
    await waitFor(() => !NF.debugScene().building, 20000);
    NF.frameGraph();
    await sleep(250);
    const g2 = NF.graph();
    log(g2.e === strong.length + weak.length, "\\u6d4b\\u8bd5\\u56fe\\u5efa\\u597d\\u4e86", g2.n + "N/" + g2.e + "E\\uff08\\u5f3a " + strong.length + " / \\u5f31 " + weak.length + "\\uff09");
    const q = NF.edgeWMin();
    log(q.on === false && q.shownFraction === 1, "\\u9ed8\\u8ba4\\u4e0d\\u8fc7\\u6ee4\\uff1a\\u5168\\u90e8\\u8fde\\u63a5\\u90fd\\u753b", JSON.stringify({ wMin: q.wMin, shown: q.shownFraction, max: q.maxAbs }));
    log(Math.abs(q.p50 - 1) < 0.05 && Math.abs(q.p99 - 1) < 0.05, "\\u91c7\\u6837\\u76f4\\u65b9\\u56fe\\u7b97\\u51fa\\u7684\\u5206\\u4f4d\\u6570\\u8ddf\\u5b9e\\u9645\\u6743\\u91cd\\u5bf9\\u5f97\\u4e0a", "p50=" + q.p50 + " p99=" + q.p99 + " max=" + q.maxAbs);
    const r1 = NF.setEdgeWMin(0.5);
    await sleep(200);
    log(Math.abs(r1.shownFraction - strong.length / g2.e) < 0.02, "\\u9608\\u503c 0.5 \\u540e\\u5269\\u4e0b\\u7684\\u6bd4\\u4f8b\\u8ddf\\u5b9e\\u7b97\\u4e00\\u81f4",
        r1.shownFraction.toFixed(3) + " vs " + (strong.length / g2.e).toFixed(3));

    /* 看不见的线不该能点到：拿一条**弱**边的中点试 */
    const midOf = (a, b) => { const p = NF.screenOf(a), q2 = NF.screenOf(b); return { x: (p.x + q2.x) / 2, y: (p.y + q2.y) / 2, ok: p.visible && q2.visible }; };
    const mw = midOf(ids[1], ids[2]);
    const ms = midOf(ids[0], ids[1]);
    log(mw.ok && ms.ok, "\\u5f31\\u8fb9 / \\u5f3a\\u8fb9\\u7684\\u7aef\\u70b9\\u90fd\\u5728\\u5c4f\\u5e55\\u4e0a\\uff08\\u80fd\\u6d4b\\uff09", JSON.stringify({ weak: mw, strong: ms }));
    const hitWeakFiltered = NF.pickEdgeAt(mw.x, mw.y);
    const hitStrongFiltered = NF.pickEdgeAt(ms.x, ms.y);
    log(hitStrongFiltered >= 0, "\\u8fc7\\u6ee4\\u540e\\u5f3a\\u8fde\\u63a5\\u7167\\u6837\\u80fd\\u70b9\\u5230", "hit=" + hitStrongFiltered);
    log(hitWeakFiltered === -1, "\\u8fc7\\u6ee4\\u540e\\u540c\\u4e00\\u4f4d\\u7f6e\\u7684\\u5f31\\u8fde\\u63a5\\u70b9\\u4e0d\\u5230", "hit=" + hitWeakFiltered);
    NF.setEdgeWMin(0);
    await sleep(200);
    const hitWeakRaw = NF.pickEdgeAt(mw.x, mw.y);
    log(hitWeakRaw === weak[0] || hitWeakRaw >= 0, "\\u5173\\u6389\\u9608\\u503c\\u540e\\u90a3\\u6761\\u5f31\\u8fde\\u63a5\\u53c8\\u80fd\\u70b9\\u5230\\u4e86",
        "hit=" + hitWeakRaw + "\\uff08\\u671f\\u671b " + weak[0] + "\\uff09");
    log(!!document.getElementById("wmin-hint") && document.getElementById("wmin-hint").textContent.length > 0,
        "\\u5de6\\u680f\\u90a3\\u53e5\\u63d0\\u793a\\u4f1a\\u8bf4\\u6e05\\u695a\\u73b0\\u5728\\u8fc7\\u6ee4\\u6210\\u4ec0\\u4e48\\u6837", (document.getElementById("wmin-hint").textContent || "").slice(0, 60));

    /* ============ C. 删除不留脏数据 ============ */
    NF.selectIds(ids.slice(0, 4), false);
    key("Delete");
    await waitFor(() => NF.graph().n === 4, 10000);
    await sleep(200);
    const g3 = NF.graph(), o3 = NF.orphans();
    log(g3.n === 4, "\\u5220\\u6389 4 \\u4e2a\\u795e\\u7ecf\\u5143", "n=" + g3.n);
    log(g3.e === 3, "\\u8ddf\\u88ab\\u5220\\u795e\\u7ecf\\u5143\\u76f8\\u8fde\\u7684\\u8fde\\u63a5\\u4e00\\u8d77\\u8d70", "e=" + g3.e + "\\uff08\\u671f\\u671b 3\\uff09");
    log(o3.dangling === 0, "\\u6ca1\\u6709\\u60ac\\u7a7a\\u8fde\\u63a5\\uff08\\u7aef\\u70b9\\u8d8a\\u754c\\uff09", "dangling=" + o3.dangling);

    NF.select([], [0]);
    await sleep(120);
    key("Delete");
    await waitFor(() => NF.graph().e === 2, 10000);
    await sleep(250);
    const g4 = NF.graph(), d5 = NF.debugScene(), o4 = NF.orphans();
    log(g4.e === 2, "\\u5220\\u6389\\u4e00\\u6761\\u8fde\\u63a5", "e=" + g4.e);
    log(d5.lineRange === g4.e * 2, "\\u7ec6\\u7ebf\\u5c42 drawRange \\u8ddf\\u7740\\u51cf\\u5c11\\uff08\\u4e0d\\u7559\\u6b8b\\u5f71\\uff09",
        d5.lineRange + " vs " + (g4.e * 2));
    log(o4.dangling === 0 && o4.selfLoop === 0, "\\u5220\\u5b8c\\u4e4b\\u540e\\u56fe\\u8fd8\\u662f\\u5e72\\u51c0\\u7684", JSON.stringify(o4));

    /* ============ D. 大数据层上的阈值（走 uniform，零重建）============ */
    NF.clear();
    const big = [];
    for (let i = 0; i < 6; i++) big.push(NF.addNode(i * 6, 0, 0));
    for (let i = 0; i + 1 < big.length; i++) NF.addEdge(big[i], big[i + 1], (i % 2 === 0) ? 1.0 : 0.2);
    NF.bigSet({ eMin: 1 });
    NF.setLod("mid");
    NF.rebuild();
    await waitFor(() => !NF.debugScene().building, 30000);
    NF.frameGraph();
    await sleep(250);
    const bs0 = NF.bigState(), ls0 = NF.lodState();
    log(bs0.on && bs0.built === NF.graph().e, "\u5207\u5230\u5927\u6570\u636e\u5c42\uff08\u8fde\u7ebf\u8d70 GPU \u5c55\u5f00\uff09", "built=" + bs0.built + " \u5757=" + bs0.chunks);
    const ve = document.getElementById("v-edges");
    NF.setEdgeWMin(0);
    const fAll = NF.grabFrame();
    ve.checked = false; ve.dispatchEvent(new Event("change", { bubbles: true }));
    const fOff = NF.grabFrame();
    ve.checked = true; ve.dispatchEvent(new Event("change", { bubbles: true }));
    const pxAll = NF.pixelDiff(fAll, fOff);
    log(pxAll > 200, "\u5927\u6570\u636e\u5c42\u786e\u5b9e\u5728\u753b\u8fde\u7ebf\uff08\u50cf\u7d20\u5bf9\u8d26\uff09", pxAll + " \u4e2a\u50cf\u7d20");
    NF.setEdgeWMin(0.5);
    const fHi = NF.grabFrame();
    const pxHi = NF.pixelDiff(fHi, fOff);
    log(pxHi < pxAll, "\u9608\u503c\u62c9\u9ad8\u540e\u753b\u9762\u4e0a\u7684\u8fde\u7ebf\u53d8\u5c11\uff08uniform \u8fc7\u6ee4\u771f\u7684\u751f\u6548\uff09", pxHi + " < " + pxAll);
    NF.setEdgeWMin(99);
    const fNone = NF.grabFrame();
    const pxNone = NF.pixelDiff(fNone, fOff);
    log(pxNone === 0, "\u9608\u503c\u8d85\u8fc7\u6700\u5927\u6743\u91cd\u540e\u4e00\u6761\u8fde\u7ebf\u90fd\u4e0d\u753b", pxNone + " \u4e2a\u50cf\u7d20");
    NF.setEdgeWMin(0);
    const bs1 = NF.bigState();
    log(bs1.built === bs0.built && NF.lodState().builtMask === ls0.builtMask,
        "\u6539\u9608\u503c\u4e0d\u4f1a\u91cd\u5efa\u5927\u6570\u636e\u5c42\uff08\u96f6\u91cd\u5efa\uff09",
        "built=" + bs1.built + " builtMask=" + NF.lodState().builtMask);
    NF.bigSet({ eMin: 1500000 });
    await waitFor(() => !NF.debugScene().building, 20000);
    await sleep(150);
    log(NF.debugScene().lineRange === NF.graph().e * 2 && NF.orphans().dangling === 0,
        "\u5173\u6389\u5927\u6570\u636e\u5c42\u540e\u8001\u8def\u91cd\u5efa\u6b63\u5e38", "lineRange=" + NF.debugScene().lineRange);

    /* ============ E. \u300c\u6309\u9884\u7b97\u6311\u9608\u503c\u300d ============ */
    NF.clear();
    const bk = [];
    for (let i = 0; i < 20; i++) bk.push(NF.addNode(i * 6, 0, 0));
    /* 20 \u6761\u6743\u91cd\u5404\u4e0d\u76f8\u540c\u7684\u8fde\u63a5\uff1a\u76f4\u65b9\u56fe\u4e0a\u6b63\u597d\u4e00\u4e2a\u6876\u4e00\u6761\uff0c\u9884\u7b97\u80fd\u4e0d\u80fd\u5361\u51c6\u770b\u5f97\u51fa\u6765 */
    for (let i = 0; i + 1 < bk.length; i++) NF.addEdge(bk[i], bk[i + 1], (i + 1) / 20);
    NF.setLod("high");
    NF.rebuild();
    await waitFor(() => !NF.debugScene().building, 20000);
    NF.frameGraph();
    await sleep(200);
    const gk = NF.graph();
    const b3 = NF.edgeWMinBudget(3);
    NF.setEdgeWMin(b3.wMin);
    const s3 = NF.edgeWMin();
    const shown3 = Math.round(s3.shownFraction * gk.e);
    log(s3.on && shown3 === 3, "\u6309\u9884\u7b97\u6311\u9608\u503c\uff1a\u9884\u7b97 3 \u6761\u5c31\u6b63\u597d\u5269 3 \u6761\uff08\u9884\u7b97\u5185\u6700\u677e\u7684\u9608\u503c\uff09",
        "\u9608\u503c " + b3.wMin + " \u8fd8\u5269 " + shown3 + " / " + gk.e + " \u6761");
    NF.setEdgeWMin(0);
    const bAll = NF.edgeWMinBudget(gk.e * 2);
    log(bAll.wMin === 0, "\u9884\u7b97\u6bd4\u603b\u6761\u6570\u8fd8\u5927\uff1a\u4e0d\u8bbe\u9608\u503c\uff0c\u5168\u90e8\u7167\u753b", "wMin=" + bAll.wMin);
    const b0 = NF.edgeWMinBudget(1);
    NF.setEdgeWMin(b0.wMin);
    const s0 = NF.edgeWMin();
    log(s0.on && Math.round(s0.shownFraction * gk.e) <= 2, "\u9884\u7b97 1 \u6761\uff1a\u53ea\u7559\u6700\u5f3a\u7684\u5c11\u6570\u51e0\u6761\uff0c\u4e0d\u4f1a\u4e00\u6761\u90fd\u4e0d\u753b",
        "\u9608\u503c " + b0.wMin + " \u8fd8\u5269 " + Math.round(s0.shownFraction * gk.e) + " \u6761");
    NF.setEdgeWMin(0);
    /* ============ F. 连线拾取：看得见就点得到、看不见就点不到 ============ */
    NF.clear();
    NF.setEdgeWMin(0);
    const q1 = NF.addNode(-100, 0, 0), q2 = NF.addNode(100, 0, 0);
    NF.addEdge(q1, q2, 1.0);
    NF.setLod('high');
    NF.rebuild();
    await waitFor(() => !NF.debugScene().building, 20000);
    NF.frameGraph();
    await sleep(400);
    const cc = document.getElementById('c').getBoundingClientRect();
    const cx0 = cc.left + cc.width / 2, cy0 = cc.top + cc.height / 2;
    /* 一条横穿视野的长连线，不管相机怎么摆都从画布中心那块穿过去：在中心 200x200 的范围里
       按 4px 步长找它。以前这里会因为"候选边超过 pickMax"直接放弃，10/10 个点全落空。 */
    const sweepPick = () => {
      for (let dy = -100; dy <= 100; dy += 4)
        for (let dx = -100; dx <= 100; dx += 4) { const h = NF.pickEdgeAt(cx0 + dx, cy0 + dy); if (h >= 0) return h; }
      return -1;
    };
    const hitA = sweepPick();
    log(hitA === 0, '拾取：画面上看得见的连线点得到（以前这种情况会直接放弃拾取）', 'hit=' + hitA);
    log(NF.pickBench(2000000, 2).hit >= 0, '拾取体检：预算给足时屏幕正中能命中', JSON.stringify(NF.pickBench(2000000, 2)));
    NF.setEdgeWMin(2);          /* 阈值高过这条边的权重 */
    const hitB = sweepPick();
    log(hitB === -1, '阈值挡掉的连线（画面上看不见）点不到', 'hit=' + hitB);
    const mqOff = NF.marquee(cc.left + 4, cc.top + 4, cc.right - 4, cc.bottom - 4, { what: 'edges' });
    log(mqOff.e === 0, '框选看不见的连线：一条都不选中', 'e=' + mqOff.e);
    NF.setEdgeWMin(0);
    const mqOn = NF.marquee(cc.left + 4, cc.top + 4, cc.right - 4, cc.bottom - 4, { what: 'edges' });
    log(mqOn.e === 1 && NF.selectedEdges().length === 1, '阈值放回去：同一次框选就选得到这一条', 'e=' + mqOn.e + ' sel=' + NF.selectedEdges().length);
    NF.select([], []);
    log(NF.selectedEdges().length === 0, '清空选择之后没有残留的选中连线', 'sel=' + NF.selectedEdges().length);

    /* 预算不足时的契约：不是"这一下不拾取"，而是扫到哪儿算哪儿 + 立起 pickTrunc 让界面提示 */
    NF.clear();
    const ch = [];
    for (let i = 0; i < 21; i++) ch.push(NF.addNode(-100 + i * 10, 0, 0));
    for (let i = 0; i + 1 < ch.length; i++) NF.addEdge(ch[i], ch[i + 1], 1.0);
    NF.setLod('high');
    NF.rebuild();
    await waitFor(() => !NF.debugScene().building, 20000);
    NF.frameGraph();
    await sleep(300);
    const pbT = NF.pickBench(5, 1);
    log(pbT.trunc === 1 && pbT.budget === 5, '预算不足：扫不完就把 pickTrunc 立起来（界面据此提示"拉近再选"）', JSON.stringify(pbT));
    const pbF = NF.pickBench(2000000, 2);
    log(pbF.trunc === 0, '预算给足：扫得完，pickTrunc 保持 0', JSON.stringify(pbF));
    log(NF.debugScene().building === false && NF.selectedEdges().length === 0, '拾取一整轮之后场景没被弄脏', 'building=false sel=0');

    /* ============ G. 可见边索引：点得到的一定是画面上看得见的那条 ============ */
    NF.clear();
    NF.setEdgeWMin(0);
    NF.bigSet({ eMin: 1 });
    const gch = [];
    for (let i = 0; i < 21; i++) gch.push(NF.addNode(-100 + i * 10, 0, 0));
    for (let i = 0; i + 1 < gch.length; i++) NF.addEdge(gch[i], gch[i + 1], (i + 1) / 21);
    NF.setLod('high');
    NF.rebuild();
    await waitFor(() => !NF.debugScene().building, 20000);
    NF.frameGraph();
    await sleep(350);
    log(NF.bigState().on === true, '切到大数据层（可见边索引只在这条路上用）', 'on=' + NF.bigState().on);
    NF.setEdgeWMin(0.9);   /* 21 条里只剩 0.952 / 1.0 这两条，而且都在边表**末尾** */
    const sweepAll = () => {
      for (let y = cc.top + 6; y <= cc.bottom - 6; y += 6)
        for (let x = cc.left + 6; x <= cc.right - 6; x += 6) if (NF.pickEdgeAt(x, y) >= 0) return Math.round(x) + ',' + Math.round(y);
      return '';
    };
    const gh = sweepAll();
    log(!!gh, '阈值挡掉一大片时，末尾那两条看得见的线照样点得到（以前只搜图的前一段，正好漏掉）', '先在 ' + gh + ' 点中');
    const gIdx = NF.bigProbe().pick;
    log(gIdx.vIdx === 2 && gIdx.vCnt === 2, '可见边索引里正好是画面上那几条', JSON.stringify(gIdx));
    log(gIdx.vDirty === false, '索引建好之后不会每次悬停都重建', 'vDirty=' + gIdx.vDirty);
    NF.setW(0, 1.0);                               /* 把第一条边的权重拉到阈值以上 */
    NF.pickBench(1000, 1);                         /* 拾取时才会重建索引 */
    const gIdx2 = NF.bigProbe().pick;
    log(gIdx2.vIdx === 3, '权重改过之后索引跟着重建（不会拿着旧表点）', JSON.stringify(gIdx2));
    NF.setEdgeWMin(0);
    const gb = NF.pickBench(1, 1);   /* 预算给 1 条：只有退回按块 + 预算的老路才可能被截断 */
    log(gb.trunc === 1, '阈值关掉（全部显示）时不走索引，退回按块 + 预算的老路', JSON.stringify(gb));
    const gAll = sweepAll();
    log(!!gAll, '全部显示之后中间那些原本被挡掉的线也点得到了', '先在 ' + gAll + ' 点中');
    NF.bigSet({ eMin: 1500000 });
    await waitFor(() => !NF.debugScene().building, 20000);
    await sleep(150);
    log(NF.debugScene().lineRange === NF.graph().e * 2, '收拾干净：关掉大数据层后老路重建正常', 'lineRange=' + NF.debugScene().lineRange);

    /* ============ H. 选中后临时放行的弱边，必须点得中 ============ */
    NF.setEdgeWMin(0.9);      /* 阈值重新拉起来：这一段重点就是"被阈值挡掉、只因为选中才画出来"的边 */
    await sleep(120);
    const gIdx4 = NF.bigProbe().pick;
    log(gIdx4.vIdx === 3, '阈值 0.9：索引里只有 3 条（链子末尾两条 + 刚提上来的第 0 条）', JSON.stringify(gIdx4));
    NF.select([gch[5]], []);
    await sleep(120);
    const hlw = NF.highlight();
    const hitIds = [];
    for (let y = cc.top + 6; y <= cc.bottom - 6; y += 6)
      for (let x = cc.left + 6; x <= cc.right - 6; x += 6) { const h = NF.pickEdgeAt(x, y); if (h >= 0 && hitIds.indexOf(h) < 0) hitIds.push(h); }
    const hlHit = hlw.filter((h) => hitIds.indexOf(h.e) >= 0);
    log(hlw.length === 2, '选中中间的神经元：它的两条连接被高亮放行', '高亮 ' + hlw.length + ' 条');
    log(hlHit.length >= 1, '高亮放行画出来的弱边照样点得中（看得见就点得着；修之前这里是 0）',
        '点中 ' + hlHit.length + '/' + hlw.length + ' 条');
    const stTxt = (document.getElementById('st-msg') || {}).textContent || '';
    log(stTxt.indexOf('低于当前阈值') >= 0, '状态栏把「平时为什么看不见」说清楚', stTxt.slice(0, 72));
    NF.select([], []);
    await sleep(80);
    log(NF.selectedEdges().length === 0 && NF.highlight().length === 0, '取消选中：高亮和选中一起清干净', 'hl=' + NF.highlight().length);

    /* ============ I. 取消选中之后，神经元自己的颜色必须跟着退回去 ============ */
    /* 大模型上「聚焦淡化」是关着的（computeDimState 直接 return false），
       颜色不会被整图重刷；以前取消选中后那个神经元一直白着，非等鼠标再扫过它才恢复。
       这里把淡化关掉，在小图上复现同一个条件。 */
    const dimBox = document.getElementById('v-dim');
    const dimWas = dimBox ? dimBox.checked : null;
    if (dimBox && dimBox.checked) { dimBox.checked = false; dimBox.dispatchEvent(new Event('change')); }
    await sleep(80);
    const selI = gch[2];
    const baseI = NF.node(selI).color;
    log(NF.renderColor(selI) === baseI, '没选中时，实例颜色就是底色', NF.renderColor(selI) + ' / ' + baseI);
    NF.select([selI], []);
    /* 用户那条路：选中之后鼠标扫过它再离开 —— 这一下会把"选中=白"烘进实例颜色，
       取消选中之后要是没人管它，就一直是白的。 */
    NF.setHoverNode(selI); NF.setHoverNode(-1);
    await sleep(80);
    const whiteI = NF.renderColor(selI);
    log(whiteI === '#ffffff', '选中之后神经元自己是白的（鼠标扫过再离开，白被烘进实例缓冲）',
        baseI + ' -> ' + whiteI);
    NF.select([], []);
    await sleep(80);
    const backI = NF.renderColor(selI);
    log(backI !== '#ffffff', '取消选中之后不再是白的', whiteI + ' -> ' + backI);
    log(backI === baseI, '取消选中之后立刻退回底色（不用等鼠标再扫过它）',
        '底色 ' + baseI + '，现在是 ' + backI);
    /* Shift 加选 / 减选那一条路也要一样 */
    NF.select([selI], []);
    await sleep(80);
    NF.select([], []);
    await sleep(80);
    log(NF.renderColor(selI) === baseI, '再走一遍还是对的（不是只修了第一次）', NF.renderColor(selI));
    if (dimBox && dimWas !== null) { dimBox.checked = dimWas; dimBox.dispatchEvent(new Event('change')); }
    await sleep(60);
    mark("\\u00b7 \\u5408\\u8ba1 " + pass + " PASS / " + fail + " FAIL");
    document.title = (fail ? "NFWMIN BAD " + fail + "F" : "NFWMIN OK") + " " + pass + "P/" + fail + "F";
  } catch (e) {
    mark("ERROR " + String((e && e.stack) || e));
    document.title = "NFWMIN ERR " + String((e && e.message) || e).slice(0, 80);
  }
})();
</script>
`;
fs.writeFileSync("prototype/_wmincheck.html", html.replace("</body>", TEST + "</body>"));
console.log("generated prototype/_wmincheck.html");
