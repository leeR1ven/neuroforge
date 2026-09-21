/* 生成 prototype/_importcheck.html：把一份 .nforge 走**真实界面路径**载进来。
   路径是「文件 → 分块载入...」那条：showChunks 打开面板 -> 点载入。
   用法：_importcheck.html?f=_blockdemo_raw.nforge（f 相对 prototype/，默认就是这个）。 */
import fs from "node:fs";
const SRC = "prototype/\u795e\u7ecf\u5143\u7f16\u8f91\u5668\u539f\u578b.html";
const html = fs.readFileSync(SRC, "utf8");
const TEST = `
<script>
(async () => {
  const out = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  /* 输出框先挂上去、边跑边刷新：万一卡在某个 await 上（后台标签页里
     requestAnimationFrame 一帧都不跑），也能一眼看出停在哪一步 */
  const pre = document.createElement("pre");
  pre.id = "nf-importout";
  pre.setAttribute("style", "position:fixed;left:0;top:0;z-index:99999;margin:0;padding:12px;max-width:46%;max-height:100%;overflow:auto;background:#05070c;color:#bff5c8;font:12px/1.5 Consolas,monospace;white-space:pre-wrap");
  document.body.appendChild(pre);
  const NL = String.fromCharCode(10);
  const flush = () => { pre.textContent = out.join(NL); };
  const mark = (t) => { out.push("\u00b7 " + t); flush(); };
  /* 提示条只活 2.6 秒，读晚了就没了——所以从一开头就盯着它，把每条都记下来 */
  new MutationObserver((ms) => {
    for (const m of ms) {
      for (const nd of m.addedNodes) {
        if (nd.nodeType === 1 && nd.className.indexOf("toast") >= 0) mark("提示：" + nd.textContent);
      }
    }
  }).observe(document.getElementById("toast"), { childList: true });
  const shot = () => new URLSearchParams(location.search).get("shot") === "1";
  try {
    mark("脚本起点 readyState=" + document.readyState);
    if (document.readyState !== "complete") await new Promise(r => addEventListener("load", r));
    await sleep(400);
    const f = new URLSearchParams(location.search).get("f") || "_blockdemo_raw.nforge";
    const res = await fetch(f + "?v=" + Date.now());
    if (!res.ok) throw new Error("读不到 " + f + "（HTTP " + res.status
      + "）——先跑 py -3 tools/gen_blk_demo.py 生成样本");
    const buf = new Uint8Array(await res.arrayBuffer());
    mark("读到 " + f + "：" + buf.length + " 字节");
    const hdr = NF.inspectFile(buf);
    mark("分块 " + hdr.chunks.length + " 块 / 神经元 " + hdr.counts.neurons + " / 连接 "
      + hdr.counts.edges + " / 压缩 " + hdr.chunks.filter(c => c.codec === "deflate").length + " 块");
    NF.showChunks(buf, f);
    await sleep(200);
    const panel = NF.chunkPanel();
    mark("面板打开：" + JSON.stringify(panel));
    const btn = document.getElementById("ck-load");
    mark("按钮：" + btn.textContent.trim() + " / disabled=" + btn.disabled);
    btn.click();
    mark("点了「载入」，等场景建好");
    /* 载入是一帧一帧推的（rAF）。后台标签页里 rAF 一帧都不跑，所以这里轮询等状态
       真正到位，而不是傻等固定帧数——否则会拿旧图当成"载入完成"，报一个假失败 */
    let waited = 0;
    while (waited < 60000 && NF.graph().n !== hdr.counts.neurons) {
      await sleep(250); waited += 250;
      if (waited === 15000) mark("还在载入，已经等了 15 秒…");
    }
    mark("载入推进用了 " + waited + " ms");
    const g = NF.graph();
    mark("载入后：" + JSON.stringify(g));
    const sc = NF.debugScene();
    mark("场景：神经元实例 " + sc.neuronCount + "/" + sc.n + "，连线实例 " + sc.edgeCount + "/" + sc.e
      + "，位置错 " + sc.nBadPos + "，中点错 " + sc.eBadMid);
    /* 权重块：Python 导入器写出来的块区必须真的被读进来、并且真的挂到场景里 */
    const bstat = NF.blockViewStats();
    const wantBlk = (hdr.blocks && hdr.blocks.count) || 0;
    mark("权重块：文件头 " + wantBlk + " 个 / 读进来 " + bstat.blocks + " 个 / 画了 " + bstat.drawn
      + " 个 / 场景里 " + bstat.inScene + " 个");
    const blkOk = bstat.blocks === wantBlk && bstat.drawn === wantBlk && bstat.inScene === wantBlk;
    let texOk = true;
    if (blkOk) {
      for (const b of NF.blocksInfo()) {
        const v = NF.blockView(b.id);
        if (!v || !v.tex || v.tex.w < 1 || v.tex.h < 1 || !v.inScene) { texOk = false; break; }
        mark("  块 #" + b.id + " " + v.k + "x" + v.n + " 板 " + v.sx.toFixed(1) + "x"
          + v.sy.toFixed(1) + " 贴图 " + v.tex.w + "x" + v.tex.h);
      }
    }
    /* 共享参数组（权值共享）：文件里同一个 sg 的块只存了一份权重，读进来必须是"同一个参数"——
       拿数组身份号逐块对一遍，光比数值是查不出"各拷了一份"的 */
    const gs = NF.blockGroups();
    const one = NF.blockTotal(), all = NF.blockTotalAll();
    let shareOk = true;
    if (gs.length) {
      const infos = NF.blocksInfo();
      for (const grp of gs) {
        const ids = infos.filter((b) => b.sg === grp.sg).map((b) => b.id);
        const a0 = NF.blockArrId(ids[0]);
        const same = ids.length === grp.count && ids.every((x) => NF.blockArrId(x) === a0);
        if (!same || grp.count < 2) shareOk = false;
        mark("  共享组 #" + grp.sg + "：" + grp.count + " 块 " + grp.k + "x" + grp.n + " "
          + (same ? "读成了同一份数组" : "读成了各一份（不对）"));
      }
      if (one >= all) shareOk = false;
    }
    mark("权重数：去重 " + one + " / 不去重 " + all
      + (gs.length ? "（共享参数组省下 " + (all - one) + " 个）" : "（没有共享组）"));
    const ok = g.n === hdr.counts.neurons && g.e === hdr.counts.edges
      && sc.neuronCount === sc.n && sc.edgeCount === sc.e && sc.nBadPos === 0 && sc.eBadMid === 0
      && blkOk && texOk && shareOk;
    mark(ok ? "RESULT OK" : "RESULT BAD");
    document.title = ok ? ("NFIMPORT OK n=" + g.n + " e=" + g.e + " blk=" + bstat.drawn + "/" + wantBlk
                           + " sg=" + gs.length)
                        : "NFIMPORT BAD";
    /* ?shot=1：把面板关掉、把相机对准模型，只留画面，方便截图看效果 */
    if (shot()) {
      document.getElementById("ckclose").click();
      const btns = document.querySelectorAll("#viewbar button");
      for (let bi = 0; bi < btns.length; bi++) {
        if (btns[bi].textContent.indexOf("聚焦") >= 0) btns[bi].click();
      }
      await sleep(900);
    }
  } catch (e) {
    out.push("ERROR " + String((e && e.stack) || e));
    document.title = "NFIMPORT ERR " + String((e && e.message) || e).slice(0, 90);
  }
  flush();
  if (shot()) pre.remove();
})();
</script>
`;
fs.writeFileSync("prototype/_importcheck.html", html.replace("</body>", TEST + "</body>"));
console.log("generated prototype/_importcheck.html");
