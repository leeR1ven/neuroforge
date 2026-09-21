/* 生成 prototype/_opcheck.html：把 _opdemo.nforge（含卷积这类算子节点）载进来，
   走**真实编译路径**生成 PyTorch 产物，把产物交给 _dump/ 让 Python 跑对拍。
   用法： node prototype/make_opcheck.mjs
   前置： py -3 tools/gen_op_demo.py 先生成 _opdemo.nforge 与 _opdemo_ref.json */
import fs from "node:fs";
const SRC = "prototype/\u795e\u7ecf\u5143\u7f16\u8f91\u5668\u539f\u578b.html";
const html = fs.readFileSync(SRC, "utf8");
if (!html.includes("</body>")) throw new Error("no </body>");
const TEST = `
<script>
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (name, body) => fetch("/__dump?name=" + name, { method: "POST", body });
  /* NF.compile().bin 给的是 Uint8Array（产物清单统一口径，见 main.js）；老契约是 Blob。
     三种都接住，免得下一回再换类型时，这一页又报「没有 arrayBuffer」看着像编译坏了。 */
  const binU8 = async (b) => (b instanceof Uint8Array) ? b
    : (b instanceof ArrayBuffer) ? new Uint8Array(b)
    : new Uint8Array(await b.arrayBuffer());
  const NL = String.fromCharCode(10);
  const log = [];
  const pre = document.createElement("pre");
  pre.id = "nf-opout";
  pre.setAttribute("style", "position:fixed;left:0;top:0;z-index:99999;margin:0;padding:12px;max-width:48%;max-height:100%;overflow:auto;background:#05070c;color:#bff5c8;font:12px/1.5 Consolas,monospace;white-space:pre-wrap");
  document.body.appendChild(pre);
  const mark = (t) => { log.push("\u00b7 " + t); pre.textContent = log.join(NL); };
  try {
    if (document.readyState !== "complete") await new Promise((r) => addEventListener("load", r));
    await sleep(400);
    const res = await fetch("_opdemo.nforge?v=" + Date.now());
    if (!res.ok) throw new Error("读不到 _opdemo.nforge（HTTP " + res.status + "）——先跑 py -3 tools/gen_op_demo.py");
    const buf = new Uint8Array(await res.arrayBuffer());
    const hdr = NF.inspectFile(buf);
    mark("读到 _opdemo.nforge：" + buf.length + " 字节 / 神经元 " + hdr.counts.neurons
      + " / 连接 " + hdr.counts.edges + " / 算子节点 " + (hdr.counts.opNodes | 0)
      + " / 算子参数 " + (hdr.counts.opParams | 0) + " B");
    await NF.loadBuffer(buf);
    const g = NF.graph();
    const st = NF.opsStats();
    mark("载入后：N=" + g.n + " E=" + g.e + " / 算子 " + st.count + " 个（张量 " + st.tensors
      + " 个，元素 " + st.elements + "，字节 " + st.bytes + "，带落点 " + st.landed + "）");
    for (const o of NF.opsInfo()) {
      mark("   #" + o.id + " " + o.op + " " + o.name + " out=" + o.out + " land=" + o.land
        + " 参数[" + o.params.map((p) => p.name + p.shape).join(" ") + "]");
    }
    const r = NF.compile("pytorch", { forceBin: true });
    mark("编译：errors=" + r.errors.length + " warnings=" + r.warnings.length + " N=" + r.N
      + " E=" + r.E + " waves=" + r.waves + " blocks=" + r.blocks);
    if (r.errors.length) throw new Error("编译报错：" + JSON.stringify(r.errors.slice(0, 3)));
    if (!r.bin) throw new Error("没有二进制产物（model.bin）");
    await post("op_net.py", r.code);
    await post("op_model.bin", await binU8(r.bin));
    await post("op_meta.json", JSON.stringify({
      N: r.N, E: r.E, waves: r.waves, blocks: r.blocks, blockWeights: r.blockWeights,
      inputs: r.inputs, outputs: r.outputs, errors: r.errors, warnings: r.warnings,
      ops: NF.opsInfo().map((o) => ({ id: o.id, op: o.op, name: o.name, out: o.out,
        land: o.land, params: o.params })),
    }));
    /* ---- 3D：算子板子真的画出来了 / 选得中 / 模拟时按波次点亮 ---- */
    const ovs = NF.opViewStats();
    mark("算子板子：ops=" + ovs.ops + " drawn=" + ovs.drawn + " inScene=" + ovs.inScene + " maxView=" + ovs.maxView);
    if (!(ovs.ops > 0 && ovs.drawn === ovs.ops && ovs.inScene === ovs.ops)) throw new Error("算子板子没画全");
    const opInfos = NF.opsInfo();
    for (const o of opInfos) {
      const v = NF.opView(o.id);
      if (!v || !v.hasMesh || !v.inScene || !(v.sx > 0) || !(v.sy > 0) || !isFinite(v.cx) || !isFinite(v.cy) || !isFinite(v.cz)) {
        throw new Error("算子 #" + o.id + " 的板子数据不对：" + JSON.stringify(v));
      }
    }
    const mainOp = opInfos.filter((o) => o.op === "Conv")[0] || opInfos[0];
    const mv = NF.opView(mainOp.id);
    mark("   #" + mainOp.id + " " + mainOp.op + " 板子：中心 (" + mv.cx.toFixed(1) + "," + mv.cy.toFixed(1) + "," +
      mv.cz.toFixed(1) + ") 尺寸 " + mv.sx.toFixed(1) + "×" + mv.sy.toFixed(1) + " 贴图 " +
      (mv.tex ? mv.tex.w + "×" + mv.tex.h : "无") + " 色 " + mv.color);
    if (!mv.tex) throw new Error("卷积算子的板子应该有参数热力图");
    NF.selectOps([mainOp.id]);
    const ovs2 = NF.opViewStats();
    if (!(ovs2.halo === true && ovs2.sel.length === 1 && ovs2.sel[0] === mainOp.id)) {
      throw new Error("选中算子之后边框没亮：" + JSON.stringify(ovs2));
    }
    NF.setHoverOp(mainOp.id);
    if (NF.opViewStats().hover !== mainOp.id) throw new Error("悬停没记住");
    NF.setHoverOp(-1);
    /* 拾取：把相机摆到板子正前方，再用屏幕坐标点一下 */
    const camZ = mv.cz + Math.max(40, mv.sy * 6);
    NF.setCamera(mv.cx, mv.cy, camZ, mv.cx, mv.cy, mv.cz);
    const sp = NF.screenOfPoint(mv.cx, mv.cy, mv.cz);
    const pk = sp ? NF.pickOpAt(sp.x, sp.y) : -1;
    mark("   拾取：屏幕点 (" + (sp ? Math.round(sp.x) + "," + Math.round(sp.y) : "-") + ") -> 算子 #" + pk);
    if (pk < 0) throw new Error("算子板子拾取不中（射线什么都没碰到）");
    if (pk !== mainOp.id) {
      const pv = NF.opView(pk);
      const d1 = Math.hypot(pv.cx - mv.cx, pv.cy - mv.cy, pv.cz - camZ);
      const d2 = Math.hypot(mv.cx - mv.cx, mv.cy - mv.cy, mv.cz - camZ);
      if (!(d1 < d2)) throw new Error("拾取到的算子不在前面：#" + pk + " 比 #" + mainOp.id + " 更远");
      mark("   拾取：正前方还挡着别的算子板子（#" + pk + "），它确实更近——射线顺序对");
    }
    NF.selectOps([]);
    /* 模拟激活：卷积这类算子没有标量数值，只亮到「输入都到齐」那一波 */
    const allIns = NF.ioLists().ins;
    const few = NF.simCompute(allIns.slice(0, 8), {});
    if (few.error) throw new Error("这版图模拟算不动：" + few.error);
    const fewOps = (few.opByWave || []).reduce((a, w) => a + w.length, 0);
    mark("   模拟激活：只给 8 / " + allIns.length + " 个输入接口 -> 算子点亮 " + fewOps + " 次（输入没到齐就不点亮）");
    if (fewOps !== 0) throw new Error("只喂了一小部分输入，算子不该点亮（实际 " + fewOps + " 次）");
    const sc = NF.simCompute(allIns, {});
    if (sc.error) throw new Error("这版图模拟算不动：" + sc.error);
    const owaves = sc.opByWave || [];
    const litOps = owaves.reduce((a, w) => a + w.length, 0);
    const plan = owaves.map((w, k) => k + ":" + w.length).filter((x) => x.split(":")[1] !== "0").join(" ");
    mark("   模拟激活：全部 " + allIns.length + " 个输入接口 -> 神经元 " + sc.byWave.length + " 波 / 算子点亮 " + litOps + " 次（" + plan + "）");
    if (!(litOps > 0)) throw new Error("算子节点在模拟里一次都没点亮");
    const firstWave = owaves.findIndex((w) => w.length > 0);
    if (!(firstWave > 0)) throw new Error("第一波算子应该排在被激活的神经元之后（这里 " + firstWave + "）");
    NF.simClear();
    mark("产物已交给 Python：op_net.py / op_model.bin / op_meta.json");
    /* ---- 往返：把同一张图再编码一份 .nforge（带算子区）交给 Python 读 ----
       这一段专门查『JS 写、Python 读』这个方向：算子参数区 / 落点 / 输入索引
       只要有一个字排错，Python 读出来的就是别的东西，而且不会有任何异常。 */
    const u8b = await NF.encodeV3({ chunkNeurons: 4096 });
    mark("JS 再编码一份 v3：" + u8b.length + " 字节（含算子区）");
    await post("op_from_js.nforge", u8b);
    /* 再把自己写的那份读回来编译一次：JS 写 -> JS 读也过一遍，数值还能再对一次 */
    await NF.loadBuffer(u8b);
    const r2 = NF.compile("pytorch", { forceBin: true });
    if (r2.errors.length || !r2.bin) throw new Error("往返后编译失败：" + JSON.stringify(r2.errors.slice(0, 3)));
    await post("op_net2.py", r2.code);
    await post("op_model2.bin", await binU8(r2.bin));
    mark("往返编译：N=" + r2.N + " E=" + r2.E + " waves=" + r2.waves);
    const ok = r.errors.length === 0 && !!r.bin && st.count > 0 && ovs.inScene === ovs.ops;
    mark(ok ? "RESULT OK" : "RESULT BAD");
    document.title = ok ? ("NFOP OK ops=" + st.count + " plates=" + ovs.inScene + " N=" + r.N + " E=" + r.E + " waves=" + r.waves)
                        : "NFOP BAD";
  } catch (e) {
    log.push("ERROR " + String((e && e.stack) || e));
    document.title = "NFOP ERR " + String((e && e.message) || e).slice(0, 90);
  }
  pre.textContent = log.join(NL);
})();
<\/script>
`;
fs.writeFileSync("prototype/_opcheck.html", html.replace("</body>", TEST + "</body>"));
console.log("generated prototype/_opcheck.html");