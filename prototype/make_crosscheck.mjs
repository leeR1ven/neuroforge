/* 生成 prototype/_crosscheck.html：`.nforge` v3 的 JS <-> Python 交叉对拍。
   页面的活儿：用同一份 cross_doc.json 编码一份 v3 丢给服务器（给 Python 读），
   再把 Python 写的那份读回来、把解析结果原样丢给服务器（给 Python 对）。
   具体的断言在 tools/verify_cross.py 里，页面只负责搬运。 */
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
    pre.id = "nf-crossout";
    pre.textContent = t;
    pre.setAttribute("style", "position:fixed;left:0;top:0;z-index:99999;margin:0;padding:12px;max-width:46%;max-height:100%;overflow:auto;background:#05070c;color:#bff5c8;font:12px/1.5 Consolas,monospace;white-space:pre-wrap");
    document.body.appendChild(pre);
  };
  /* 把当前这张图整个抓下来（每个神经元的全部字段 + 每条边 + 权重块），交给 Python 逐位对 */
  const snap = (res) => {
    const n = NF.graph().n;
    const pos = [], io = [], thr = [], act = [], bias = [], lock = [], colOn = [], col = [], edges = [];
    for (let i = 0; i < n; i++) {
      const nd = NF.node(i);
      pos.push(nd.x, nd.y, nd.z);
      io.push(nd.io); thr.push(nd.thr); act.push(nd.act); bias.push(nd.bias);
      lock.push(nd.lock); colOn.push(nd.colOn);
      col.push(nd.col[0], nd.col[1], nd.col[2]);
    }
    for (let e = 0; e < NF.graph().e; e++) {
      const ed = NF.edge(e);
      edges.push([ed.src, ed.dst, ed.w, ed.lock]);
    }
    const v2 = NF.serializeV2();
    /* 共享参数组：块的 sg 与"跟我同组的还有谁"，还有去重前 / 去重后的权重数。
       跨语言读回来之后这些必须原样还在——不然"同一个参数"就散了。 */
    const bi = NF.blocksInfo();
    return {
      name: NF.graph().name,
      counts: { neurons: res.n, edges: res.e, chunks: res.chunks, totalChunks: res.totalChunks },
      dropped: res.dropped,
      pos, io, thr, act, bias, lock, colOn, col,
      names: v2.neurons.names, edges, blocks: v2.blocks,
      blocksLoaded: res.blocks, blocksDropped: res.blocksDropped,
      blocksSkipped: res.blocksSkipped, blockBytes: res.blockBytes,
      share: bi.map((b) => [b.id, b.sg, b.sharedWith]),
      /* 权重数组的身份号：同组两块应该同号（真的是同一份数组，不是数值凑巧相等）。
         转置共享（形状不同、元素总数一样）也要满足这一条。 */
      blockArr: bi.map((b) => NF.blockArrId(b.id)),
      blockTotal: NF.blockTotal(), blockTotalAll: NF.blockTotalAll(),
    };
  };
  try {
    if (document.readyState !== "complete") await new Promise(r => addEventListener("load", r));
    await new Promise(r => setTimeout(r, 400));
    const bust = "?v=" + Date.now();

    /* ---- A. 浏览器写（按神经元区间切块），Python 读 ---- */
    const cfg = await (await fetch("cross_cfg.json" + bust)).json();
    const doc = await (await fetch("cross_doc.json" + bust)).json();
    NF.loadV2(doc);
    const g0 = NF.graph();
    out.push("loadV2 -> n=" + g0.n + " e=" + g0.e);
    const u8 = await NF.encodeV3({ chunkNeurons: cfg.chunkJs });
    out.push("A encodeV3 -> " + u8.length + " bytes");
    out.push("A " + await post("cross_from_js.nforge", u8));

    /* ---- B. Python 写，浏览器读 ---- */
    const buf = new Uint8Array(await (await fetch("cross_from_py.nforge" + bust)).arrayBuffer());
    const hdr = NF.inspectFile(buf);
    const res = await NF.loadBuffer(buf);
    out.push("B loadBuffer -> " + JSON.stringify(res));
    const back = snap(res);
    back.header = { chunkNeurons: hdr.chunkNeurons, chunks: hdr.chunks.length };
    out.push("B " + await post("cross_js_readback.json", JSON.stringify(back)));

    /* ---- C. 空间分块：浏览器先按 Z 序重排再切块，Python 读 ---- */
    NF.loadV2(doc);
    const sp = cfg.chunkSpatial;
    const truth = NF.spatialPlan(sp);
    out.push("C spatialPlan -> " + truth.plan.length + " chunks / target=" + sp);
    out.push("C " + await post("cross_spatial_plan.json", JSON.stringify(
      { target: sp, perm: truth.perm, rank: truth.rank, plan: truth.plan })));
    const u8s = await NF.encodeV3({ chunkNeurons: sp, order: "spatial" });
    out.push("C encodeV3(spatial) -> " + u8s.length + " bytes");
    out.push("C " + await post("cross_spatial_js.nforge", u8s));

    /* ---- D. Python 写的空间分块文件，浏览器读 ---- */
    const bufs = new Uint8Array(await (await fetch("cross_from_py_spatial.nforge" + bust)).arrayBuffer());
    const hdrs = NF.inspectFile(bufs);
    const ress = await NF.loadBuffer(bufs);
    const backS = snap(ress);
    backS.header = { chunkNeurons: hdrs.chunkNeurons, chunks: hdrs.chunks.length, order: hdrs.order };
    out.push("D order=" + hdrs.order + " chunks=" + hdrs.chunks.length + " target=" + hdrs.chunkNeurons);
    out.push("D " + await post("cross_spatial_back.json", JSON.stringify(backS)));

    /* ---- E. 同一张图，浏览器写成"整段一个 blob"的旧形式（验证两种形式等价） ---- */
    NF.loadV2(doc);
    const u8w = await NF.encodeV3({ chunkNeurons: cfg.chunkJs, blockParts: false });
    out.push("E encodeV3(whole blocks) -> " + u8w.length + " bytes");
    out.push("E " + await post("cross_from_js_whole.nforge", u8w));

    /* ---- F. Python 写的"整段一个 blob"文件，浏览器读 ---- */
    const bufw = new Uint8Array(await (await fetch("cross_from_py_whole.nforge" + bust)).arrayBuffer());
    const hdrw = NF.inspectFile(bufw);
    const resw = await NF.loadBuffer(bufw);
    const backW = snap(resw);
    backW.header = { chunkNeurons: hdrw.chunkNeurons, chunks: hdrw.chunks.length,
                     blocksCodec: hdrw.blocks && hdrw.blocks.codec };
    /* 跟 B（分段形式）解出来的块必须一模一样 */
    backW.sameAsParts = JSON.stringify(backW.blocks) === JSON.stringify(back.blocks);
    out.push("F codec=" + (hdrw.blocks && hdrw.blocks.codec) + " blocks=" + resw.blocks
      + " sameAsParts=" + backW.sameAsParts);
    out.push("F " + await post("cross_whole_back.json", JSON.stringify(backW)));
    document.title = "NFCROSS OK";
  } catch (e) {
    const msg = String((e && e.stack) || e);
    out.push("ERROR " + msg);
    document.title = "NFCROSS ERR";
    try { await post("cross_js_readback.json", JSON.stringify({ error: msg })); } catch (_) {}
  }
  show(out.join("\\n"));
})();
</script>
`;
fs.writeFileSync("prototype/_crosscheck.html", html.replace("</body>", TEST + "</body>"));
console.log("generated prototype/_crosscheck.html");
