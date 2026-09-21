/* 生成 prototype/_streamcheck.html：验 .nforge v3 的流式载入。
   样本 = py -3 tools/gen_stream_demo.py 生成的 prototype/_streamdemo_raw.nforge
   （24 块 / 49152 神经元 / 139264 连接 / 带权重块），刻意让大量边跨块。 */
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
    pre.id = "nf-streamout";
    pre.textContent = t;
    pre.setAttribute("style", "position:fixed;left:0;top:0;z-index:99999;margin:0;padding:12px;max-width:52%;max-height:100%;overflow:auto;background:#05070c;color:#bff5c8;font:12px/1.5 Consolas,monospace;white-space:pre-wrap");
    document.body.appendChild(pre);
  };
  let fails = 0, passes = 0;
  const ok = (cond, name, detail) => {
    if (cond) passes++; else fails++;
    out.push((cond ? "PASS" : "FAIL") + " | " + name + " | " + (detail === undefined ? "" : String(detail)));
    return cond;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const NL = String.fromCharCode(10);
  const num = (n) => n.toLocaleString("en-US");
  let toasts = [];
  const toastText = () => toasts.join(" ;; ");
  /* 相机摆到这条线的中段往回看。注意 OrbitControls 的 maxDistance 是 2600，取景只能在
     目标点 2600 以内——这是「拉远看全图」的现实约束，测试就按这个约束来摆：目标 x=17000、
     相机 x=14600，于是身前那一串块在视锥里，身后的不在。 */
  const CAM = { x: 14600, y: 60, z: 0, tx: 17000, ty: 0, tz: 0 };
  const lookDownAxis = () => NF.setCam(CAM.x, CAM.y, CAM.z, CAM.tx, CAM.ty, CAM.tz);
  try {
    if (document.readyState !== "complete") await new Promise((r) => addEventListener("load", r));
    /* 等画布尺寸真的定下来再开工。
       「挑块」是按投影像素算的，而投影用的 vpHeight 是 resize() 里设的（初值 600）——
       死等 300ms 在机器慢的时候可能不够，这一条就偶尔从 3 块掉到 2 块（实测撞到过一次）。
       所以这里改成「等两帧、量画布高度、连续两次一样才算定」，最多等 3 秒。 */
    {
      const cv0 = document.querySelector("canvas");
      let last = -1;
      for (let i = 0; i < 90; i++) {
        await raf();
        const h2 = cv0 ? cv0.clientHeight : 0;
        if (h2 > 0 && h2 === last) break;
        last = h2;
      }
    }
    new MutationObserver((ms) => {
      for (const m of ms) for (const nd of m.addedNodes)
        if (nd.nodeType === 1 && String(nd.className).indexOf("toast") >= 0) toasts.push(nd.textContent);
    }).observe(document.getElementById("toast"), { childList: true });

    const res = await fetch("_streamdemo_raw.nforge?v=" + Date.now());
    if (!res.ok) throw new Error("读不到 _streamdemo_raw.nforge（HTTP " + res.status + "）——先跑 py -3 tools/gen_stream_demo.py");
    const buf = new Uint8Array(await res.arrayBuffer());
    const fileBytes = buf.length;
    const headLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(8, true);
    const H = NF.inspectFile(buf);
    const per = H.chunkNeurons, NCH = H.chunks.length;
    out.push("样本 " + num(fileBytes) + " B / " + NCH + " 块 / " + num(H.counts.neurons) + " 神经元 / "
      + num(H.counts.edges) + " 连接 / 每块 " + num(per) + " 神经元 / 权重块 "
      + ((H.blocks && H.blocks.count) || 0) + " 个");

    /* ---------- 1. 打开 = 只读文件头 ---------- */
    let st = await NF.streamOpen(buf, "streamdemo.nforge");
    ok(st.on === true, "打开后进入流式模式", JSON.stringify({ on: st.on, auto: st.auto }));
    ok(st.chunks === NCH && NCH === 24, "索引表里的块数对上了", st.chunks + " 块");
    ok(st.resident === 0, "打开时一块都没解压", "resident=" + st.resident);
    ok(st.n === 0 && st.e === 0, "打开时场景里一个神经元都没有", st.n + " / " + st.e);
    ok(st.readBytes === 16 + headLen, "读进来的正好是文件头", st.readBytes + " B = 16 + " + headLen);
    ok(st.readBytes * 100 < fileBytes, "只读了整个文件的百分之几（不是整份读进来）",
      (100 * st.readBytes / fileBytes).toFixed(2) + "%　" + num(st.readBytes) + " / " + num(fileBytes) + " B");
    ok(st.totalN === H.counts.neurons && st.totalE === H.counts.edges, "摘要里的总量跟文件头一致",
      num(st.totalN) + " / " + num(st.totalE));
    ok(st.fileBytes === fileBytes, "数据源知道文件有多大", num(st.fileBytes) + " B");
    ok(NF.graph().name === H.name, "工程名取自文件头", NF.graph().name);
    ok(st.saveBlocked === true, "半载入时保存被拦着（免得存下残缺的图）", st.saveBlocked);
    const bx0 = NF.streamBoxes();
    ok(bx0.visible === true && bx0.unloaded === NCH, "未驻留的块全画成了线框盒", JSON.stringify(bx0));
    ok(bx0.verts === NCH * 12 * 2, "线框盒顶点数 = 块数 x 12 条棱 x 2 个端点", bx0.verts);

    NF.streamAuto(false);   /* 先关掉自动，下面每一步都要可预期的数字 */

    /* ---------- 2. 手动载入第一块：追加语义 / 映射 / 挂起 ---------- */
    st = await NF.streamLoad([0]);
    ok(st.resident === 1, "载入 1 块后 resident=1", st.resident);
    ok(st.n === per, "神经元数正好是一块", num(st.n) + " = " + num(per));
    ok(st.e === per, "块内 " + num(per) + " 条边立刻接上，跨块的挂起", num(st.e));
    ok(NF.streamLiveN(0) === 0, "fileId 0 -> liveId 0", NF.streamLiveN(0));
    ok(NF.streamLiveN(per - 1) === per - 1, "块内最后一个 fileId 也对得上", NF.streamLiveN(per - 1));
    ok(NF.streamLiveN(per) === -1, "没载入的块 -> -1", NF.streamLiveN(per));
    ok(st.parked === 2 * per && st.droppedEdges === 2 * per,
      "跨块的边（->下一块 " + num(per) + " + ->后面第 3 块 " + num(per) + "）挂起了",
      "parked=" + num(st.parked) + " dropped=" + num(st.droppedEdges));
    ok(NF.streamBoxes().unloaded === NCH - 1, "线框盒少了一个", NF.streamBoxes().unloaded);
    const cs0 = NF.chunkState();
    ok(cs0.n.built === st.n && cs0.n.chunks >= 1, "场景里真的建出了这些神经元的实例",
      "built=" + num(cs0.n.built) + " / chunks=" + cs0.n.chunks);

    /* ---------- 3. 挂起的边在对端块载入时补上 ---------- */
    st = await NF.streamLoad([1]);
    ok(st.resident === 2, "再载一块", st.resident);
    ok(st.e === 3 * per, "第二块自己 " + num(per) + " 条 + 补回第一块挂在这儿的 " + num(per) + " 条",
      num(st.e) + " = 3 x " + num(per));
    ok(st.droppedEdges === 3 * per && st.droppedEdges === st.parked,
      "挂起数对得上：补回一条就少一条", "dropped=" + num(st.droppedEdges) + " parked=" + num(st.parked));

    /* ---------- 4. 只往后追加：老 liveId 一个都不动 ---------- */
    const before = { a: NF.streamLiveN(0), b: NF.streamLiveN(per), c: NF.streamLiveN(2 * per) };
    st = await NF.streamLoad([5]);
    ok(st.resident === 3 && st.n === 3 * per, "跳过中间几块直接载第 5 块", st.resident + " 块 / " + num(st.n) + " 神经元");
    ok(NF.streamLiveN(0) === before.a && NF.streamLiveN(per) === before.b,
      "已经分配出去的 liveId 一个都没动（追加语义）",
      "0 -> " + NF.streamLiveN(0) + "，块1 头 -> " + NF.streamLiveN(per));
    ok(NF.streamLiveN(5 * per) === 2 * per, "第 5 块的 fileId 落在 live 尾部", NF.streamLiveN(5 * per) + " = 2 x " + num(per));
    ok(before.c === -1 && NF.streamLiveN(2 * per) === -1, "中间没载入的块还是 -1", NF.streamLiveN(2 * per));
    ok(NF.streamBoxes().unloaded === NCH - 3, "线框盒又少了一个", NF.streamBoxes().unloaded);

    /* ---------- 5. 距离策略：投影太小的块不值得解压 ---------- */
    NF.streamReset();
    ok(NF.streamState().resident === 0 && NF.graph().n === 0, "「只看摘要」把载入的块全放了",
      JSON.stringify({ resident: NF.streamState().resident, n: NF.graph().n }));
    ok(NF.streamBoxes().unloaded === NCH, "又回到 " + NCH + " 个线框盒", NF.streamBoxes().unloaded);
    lookDownAxis();
    const pLow = NF.streamPick();       /* 阈值 1 px：视锥里够得着的全都要 */
    /* 相机的远平面是 6000，视锥其实是个截锥：比这更远的块落在远平面之外，不算「看得见」。
       所以高阈值只能在这个范围内继续往下筛。 */
    const lens = [], seq = [], cut = { th: 0, p: null };
    for (const th of [40, 80, 160, 320, 640, 1280, 2560]) {
      NF.streamMinPx(th);
      const p = NF.streamPick();
      lens.push(p.length); seq.push(th + "->" + p.length);
      if (cut.p === null && p.length > 0 && p.length < pLow.length) { cut.th = th; cut.p = p; }
    }
    NF.streamMinPx(26);
    /* 按块包围盒中心到相机的距离，算出「哪一块最近」，用来对账挑选顺序 */
    const nearOf = (ids) => {
      let best = -1, bd = Infinity;
      for (let t = 0; t < ids.length; t++) {
        const k = ids[t], b = H.chunks[k].bbox;
        const d = Math.hypot(b[0] + (b[3] - b[0]) / 2 - CAM.x,
                             b[1] + (b[4] - b[1]) / 2 - CAM.y,
                             b[2] + (b[5] - b[2]) / 2 - CAM.z);
        if (d < bd) { bd = d; best = k; }
      }
      return best;
    };
    /* 挑中几块跟画布大小直接相关（投影尺寸按画布算），所以把画布尺寸一起报出来：
       这一条要是偶尔从 3 掉到 2，先看是不是画布尺寸变了，别当成挑选算法坏了。 */
    const cv0 = document.querySelector("canvas");
    ok(pLow.length >= 3 && pLow.length < NCH, "阈值 1px 时视锥里的块被挑中，视锥外的没被挑中",
      pLow.length + " / " + NCH + "　" + JSON.stringify(pLow) + "　画布 " + (cv0 ? cv0.clientWidth + "x" + cv0.clientHeight : "?"));
    ok(cut.p !== null, "把细节阈值一档档调大，值得解压的块就一档档变少", seq.join("　"));
    ok(lens.every((v, i) => i === 0 || v <= lens[i - 1]), "阈值越大挑中的块只会越少，不会变多",
      JSON.stringify(lens));
    ok(cut.p && cut.p.every((k) => pLow.indexOf(k) >= 0), "调大阈值只会把块挑掉，不会挑出新的",
      JSON.stringify(cut.p) + " 是 " + JSON.stringify(pLow) + " 的子集");
    ok(cut.p && cut.p[0] === nearOf(pLow), "剩下的还是按投影从大到小排（离相机最近的那块排最前）",
      "阈值 " + cut.th + "px：pick[0]=" + (cut.p ? cut.p[0] : "-") + "，离相机最近的块=" + nearOf(pLow));

    /* ---------- 6. 自动 tick 只解压看得见的那几块 ---------- */
    const pickBefore = NF.streamPick();
    NF.streamAuto(true);
    await NF.streamTickNow();
    const s1 = NF.streamState();
    NF.streamAuto(false);
    ok(s1.resident >= 1, "自动 tick 至少解压了一块", s1.resident);
    ok(s1.resident <= pickBefore.length, "解压的块不超过「现在挑中的」那些", s1.resident + " <= " + pickBefore.length);
    ok(s1.resident < NCH, "没有把整个模型拉进内存（这才是流式载入的意义）", s1.resident + " < " + NCH);
    ok(NF.streamLiveN((NCH - 1) * per) === -1, "远端那一块确实没被载入", NF.streamLiveN((NCH - 1) * per));
    ok(s1.readBytes < fileBytes * 0.5, "读进来的字节仍然只是全文件的一小部分",
      num(s1.readBytes) + " / " + num(fileBytes) + " B");

    /* ---------- 7. 全部载入 == 整份载入（逐字段对账） ---------- */
    /* FNV-1a：跟 tools/verify_stream.py 那份是同一个算法（32 位溢出 + 无符号十六进制） */
    const fnv = (arr) => {
      let a = 2166136261;
      for (let k = 0; k < arr.length; k++) {
        const s = arr[k];
        for (let i = 0; i < s.length; i++) { a ^= s.charCodeAt(i); a = Math.imul(a, 16777619); }
        a ^= 10; a = Math.imul(a, 16777619);
      }
      return (a >>> 0).toString(16);
    };
    const digest = () => {
      const g = NF.graph();
      const nh = [];
      for (let i = 0; i < g.n; i++) {
        const d = NF.node(i);
        nh.push(d.x + "," + d.y + "," + d.z + "," + d.io + "," + d.act + "," + (+d.bias.toFixed(6)) + ","
          + (+d.thr.toFixed(4)) + "," + d.lock + "," + d.colOn + "," + d.color + "," + NF.nameOf(i));
      }
      const eh = [];
      for (let e = 0; e < g.e; e++) {
        const d = NF.edge(e);
        eh.push(d.src + ">" + d.dst + ":" + (+d.w.toFixed(6)) + ":" + d.lock);
      }
      eh.sort();
      return { n: g.n, e: g.e, name: g.name, nh: fnv(nh), eh: fnv(eh) };
    };
    /* 边是按 src 排序后切进块的，所以整份载入和流式载入的边顺序不会一样。
       下面把边整成有序多重集再比，节点则要求逐位一致。 */
    await NF.loadBuffer(buf);
    NF.rebuild();
    const A = digest();
    const bwA = NF.blockTotal();
    const blkA = NF.blocksInfo().length;

    st = await NF.streamOpen(buf, "streamdemo.nforge");
    NF.streamAuto(false);
    await NF.streamLoadAll();
    NF.rebuild();
    const B = digest();
    const bwB = NF.blockTotal();
    const blkB = NF.blocksInfo().length;

    ok(A.n === H.counts.neurons && B.n === A.n, "两种载入方式得到的神经元数一样",
      num(A.n) + " 字节数说明 " + num(H.counts.neurons));
    ok(A.e === H.counts.edges && B.e === A.e, "两种载入方式得到的连接数一样并且等于文件头", num(A.e));
    ok(A.name === B.name, "工程名一样", A.name);
    ok(A.nh === B.nh, "每个神经元的每个字段都逐位一致", A.nh + " vs " + B.nh);
    ok(A.eh === B.eh, "边的多重集完全一致（src/dst/权重/锁定）", A.eh + " vs " + B.eh);
    ok(bwA === H.counts.blockWeights && bwB === bwA, "权重块的权重数两边一样",
      num(bwA) + " vs " + num(bwB) + "（文件头 " + num(H.counts.blockWeights) + "）");
    const NBLK = (H.blocks && H.blocks.count) || 0;
    ok(blkA === NBLK && blkB === NBLK, "权重块的块数一样（两条载入路径都读到了全部块）",
      blkA + " / " + blkB + " / 文件头 " + NBLK);
    ok(NF.nameOf(0) === "块0_头" && NF.nameOf(H.counts.neurons - 1) === "out_末",
      "按文件 id 存的名字对到了正确的 live id 上", NF.nameOf(0) + " / " + NF.nameOf(H.counts.neurons - 1));
    const stAll = NF.streamState();
    ok(stAll.parked === 0 && stAll.droppedEdges === 0, "全部载入后没有还挂着的边",
      "parked=" + stAll.parked + " dropped=" + stAll.droppedEdges);
    ok(stAll.resident === NCH && stAll.boxes === 0, "块全部驻留，线框盒全收掉",
      stAll.resident + " / " + NCH + "，boxes=" + stAll.boxes);
    ok(stAll.readBytes === fileBytes, "全部载入后读的字节数正好等于整个文件",
      num(stAll.readBytes) + " = " + num(fileBytes));
    ok(stAll.saveBlocked === false, "全部载入后保存不再被拦", stAll.saveBlocked);
    ok(NF.streamBoxes().unloaded === 0 && NF.streamBoxes().visible === false, "线框盒全部收掉",
      JSON.stringify(NF.streamBoxes()));

    /* 逐块摘要：浏览器解出来的第 k 块，跟 Python 的 StreamReader 只读第 k 块那段字节
       解出来的东西，必须一模一样。格式化方式两边都写死（%.6f / FNV-1a），才比得了。 */
    const invLive = new Int32Array(B.n).fill(-1);
    for (let k = 0; k < NCH; k++) {
      const c = H.chunks[k], n0 = c.n0, base = NF.streamLiveN(n0);
      if (base < 0) continue;
      for (let i = 0; i < c.n1 - n0; i++) invLive[base + i] = n0 + i;
    }
    const ef = {};
    for (let e = 0; e < B.e; e++) {
      const d = NF.edge(e);
      const fs = invLive[d.src], fd = invLive[d.dst];
      if (fs < 0 || fd < 0) continue;
      const k = Math.floor(fs / per);   /* 文件里的块区间是等宽的 */
      (ef[k] = ef[k] || []).push(fs + ">" + fd + ":" + d.w.toFixed(6) + ":" + d.lock);
    }
    /* 整份载入的边，按文件 id 再记一份参照：驱逐之后剩下的边必须能在这里找到 */
    const refEdges = [], refEdgeText = new Set();
    for (let e = 0; e < B.e; e++) {
      const d = NF.edge(e);
      const fs = invLive[d.src], fd = invLive[d.dst];
      if (fs < 0 || fd < 0) continue;
      const t = fs + ">" + fd + ":" + d.w.toFixed(6) + ":" + d.lock;
      refEdges.push([fs, fd, t]); refEdgeText.add(t);
    }
    const to6 = (v) => v.toFixed(6);
    const chunkDigests = {};
    for (let k = 0; k < NCH; k++) {
      const c = H.chunks[k], nh = [];
      for (let i = c.n0; i < c.n1; i++) {
        const d = NF.node(NF.streamLiveN(i));
        nh.push(to6(d.x) + "," + to6(d.y) + "," + to6(d.z) + "," + d.io + "," + d.act
          + "," + to6(d.bias) + "," + to6(d.thr) + "," + d.lock + "," + d.colOn
          + "," + to6(d.col[0]) + "," + to6(d.col[1]) + "," + to6(d.col[2]));
      }
      const eh = (ef[k] || []).slice().sort();
      chunkDigests[k] = { n: nh.length, e: eh.length, nh: fnv(nh), eh: fnv(eh) };
    }
    const allN = [], allE = [];
    for (let k = 0; k < NCH; k++) { allN.push(chunkDigests[k].nh); allE.push(chunkDigests[k].eh); }
    ok(allN.every((h) => h.length > 0), "每一块都算出了摘要", allN.length + " 块");
    ok(allE.every((h) => h.length > 0), "每一块的边摘要也都不空", allE.length + " 块");

    /* ---------- 11. 驱逐：上限之内可以一直往前飞 ---------- */
    /* 每块 per 个神经元，预算先给 4 块的量。 */
    const MB = 4 * per;
    NF.streamEvictOn(true);
    ok(NF.streamMemMax(MB) === MB, "探针设得上限", NF.streamMemMax(MB));

    /* 11a. 计划：预算之内不驱逐，超了才给名单，而且视野里的块不能进名单 */
    NF.streamReset();
    NF.streamAuto(false);
    NF.streamMemMax(H.counts.neurons + per);   /* 预算比整个模型还大 */
    await NF.streamLoadAll();
    lookDownAxis();
    ok(NF.streamPlan(per) === null, "驻留量还在预算之内：不给驱逐计划",
      num(NF.graph().n) + " <= " + num(H.counts.neurons + per));
    NF.streamMemMax(MB);
    const pl = NF.streamPlan(per);
    ok(pl !== null && pl.drop.length > 0, "超预算了：给出一份要丢的块名单",
      pl ? ("丢 " + pl.drop.length + " 块 / 留 " + pl.keep.length + " 块") : "null");
    ok(pl && pl.keep.length >= 1, "名单里至少留下一块（不会把东西全丢光）", pl ? pl.keep.length : "-");
    ok(pl && pl.freed >= per, "丢这些块至少腾得出一块的地方", pl ? num(pl.freed) : "-");
    ok(pl && pl.keep.every((k) => pl.drop.indexOf(k) < 0), "keep 和 drop 不重叠",
      pl ? (pl.keep.length + " / " + pl.drop.length) : "-");
    ok(pl && pl.drop.every((k) => NF.streamLiveN(H.chunks[k].n0) >= 0), "drop 名单里的块现在都还驻留着",
      pl ? pl.drop.length + " 块" : "-");
    /* 相机在 x=14600 朝 +x 看。留 400 的余量，判定「肯定在视野中央」的块。
       注意：远平面现在是跟着视距自适应的（不再是写死的 6000），所以"看得见"和"装得下"
       是两件事——预算只有 4 块的量，而眼前够大的块比这多。 */
    const seenByCam = (k) => { const b = H.chunks[k].bbox; return b[3] > CAM.x + 400 && b[0] < CAM.x + 5600; };
    const seen = [];
    for (let k = 0; k < NCH; k++) if (NF.streamLiveN(H.chunks[k].n0) >= 0 && seenByCam(k)) seen.push(k);
    ok(seen.length >= 3, "相机视野正中确实有好几块驻留着", JSON.stringify(seen));
    /* 新契约（上限优先）：装不下时连看得见的块也按远近丢，而且丢的是最远的那一批；
       最近的那一块永远留到最后。 */
    const bx = (k) => H.chunks[k].bbox[3];
    const nearestSeen = seen.slice().sort((a, b2) => bx(a) - bx(b2))[0];
    ok(pl && pl.dropVisible > 0 && pl.visible > pl.keep.length,
      "预算装不下眼前的块时：上限优先，看得见的也按远近丢（并且记账）",
      "看得见 " + (pl ? pl.visible : "-") + " 块，其中被丢 " + (pl ? pl.dropVisible : "-") + " 块");
    ok(pl && pl.keep.indexOf(nearestSeen) >= 0,
      "最近的那一块永远留到最后（不会被丢）",
      "最近 " + nearestSeen + " 在 keep=" + (pl ? pl.keep.indexOf(nearestSeen) >= 0 : "-"));
    /* 上限够装下眼前的块时：老契约仍然成立——视野里的块一块都不丢。
       预算要留出滞回那部分（一次至少腾 20%），所以按 visible / 0.8 给。 */
    NF.streamMemMax(Math.ceil(pl.visible / 0.8 + 1) * per);
    const plRoom = NF.streamPlan(per);
    ok(plRoom === null || plRoom.dropVisible === 0,
      "上限够的时候，视野里的块一块都不会进 drop 名单",
      plRoom ? ("看得见 " + plRoom.visible + "，被丢 " + plRoom.dropVisible) : "null");
    NF.streamMemMax(MB);

    /* 11b. 真的丢一次，然后逐块对账：留下来的内容必须跟整份载入一模一样 */
    const ev1 = NF.streamEvictKeep(pl.keep);
    ok(ev1 !== null && ev1.evicted > 0, "驱逐执行了",
      ev1 ? ("驱逐 " + ev1.evicted + " 块 / 第 " + ev1.evictRuns + " 次 / " + ev1.evictMs.toFixed(1) + " ms") : "null");
    ok(ev1 && ev1.n <= ev1.memMax, "驱逐后驻留神经元落回上限之内", num(ev1.n) + " <= " + num(ev1.memMax));
    ok(ev1 && ev1.resident < NCH, "确实有块被搬走了", ev1.resident + " < " + NCH);
    ok(ev1 && ev1.resident + ev1.evicted === NCH, "记账对得上：还驻留的 + 被驱逐的 = 一共载入过的",
      ev1.resident + " + " + ev1.evicted + " = " + NCH);
    ok(ev1 && NF.graph().e < B.e, "连接数也跟着降下来了", num(NF.graph().e) + " < " + num(B.e));
    ok(ev1 && ev1.droppedEdges === ev1.parked, "端点被搬走的边都记在挂起账上",
      ev1.droppedEdges + " = " + ev1.parked);
    ok(ev1 && ev1.boxes === ev1.evicted, "被驱逐的块重新画回线框盒", ev1.boxes + " = " + ev1.evicted + " 个盒");
    let badRef = 0;
    for (const bi of NF.blocksInfo()) {
      const ids = NF.blockIds(bi.id);
      for (const v of ids.src.concat(ids.dst)) if (v >= NF.graph().n) badRef++;
    }
    ok(badRef === 0, "权重块里的行 / 列 id 驱逐后都还是有效地址（没有指到不存在的人）",
      NF.blocksInfo().length + " 个块，越界 " + badRef + " 个");

    /* 逐块摘要：留下来的每一块，神经元逐位一致；边只能是整份载入的子集 */
    const liveDig = () => {
      const g = NF.graph();
      const inv = new Int32Array(g.n).fill(-1);
      for (let k = 0; k < NCH; k++) {
        const c = H.chunks[k], base = NF.streamLiveN(c.n0);
        if (base < 0) continue;
        for (let i = 0; i < c.n1 - c.n0; i++) inv[base + i] = c.n0 + i;
      }
      const efx = {}, edges = [];
      for (let e = 0; e < g.e; e++) {
        const d = NF.edge(e);
        const fs = inv[d.src], fd = inv[d.dst];
        if (fs < 0 || fd < 0) { edges.push(null); continue; }
        const t = fs + ">" + fd + ":" + d.w.toFixed(6) + ":" + d.lock;
        edges.push(t);
        (efx[Math.floor(fs / per)] = efx[Math.floor(fs / per)] || []).push(t);
      }
      const pc = {};
      for (let k = 0; k < NCH; k++) {
        const c = H.chunks[k], base = NF.streamLiveN(c.n0);
        if (base < 0) continue;
        const nh = [];
        for (let i = c.n0; i < c.n1; i++) {
          const d = NF.node(NF.streamLiveN(i));
          nh.push(to6(d.x) + "," + to6(d.y) + "," + to6(d.z) + "," + d.io + "," + d.act
            + "," + to6(d.bias) + "," + to6(d.thr) + "," + d.lock + "," + d.colOn
            + "," + to6(d.col[0]) + "," + to6(d.col[1]) + "," + to6(d.col[2]));
        }
        pc[k] = { n: nh.length, e: (efx[k] || []).length, nh: fnv(nh), eh: fnv((efx[k] || []).slice().sort()) };
      }
      return { pc: pc, edges: edges };
    };
    const L1 = liveDig();
    const badN = [], badE = [];
    for (const k in L1.pc) {
      if (L1.pc[k].nh !== chunkDigests[k].nh) badN.push(k);
      if (L1.pc[k].e > chunkDigests[k].e) badE.push(k);
    }
    ok(badN.length === 0, "留下来的每一块，神经元的每个字段都跟整份载入逐位一致",
      badN.length ? ("对不上 " + JSON.stringify(badN)) : (Object.keys(L1.pc).length + " 块逐位一致"));
    ok(badE.length === 0, "留下来的块，边数不超过整份载入时那一块的边数（丢的是跨出去的那些）",
      badE.length ? JSON.stringify(badE) : "OK");
    let strayE = 0;
    for (const t of L1.edges) if (t !== null && !refEdgeText.has(t)) strayE++;
    ok(strayE === 0, "留下来的每条边都能在整份载入里找到（没有凭空造出来的边）", strayE + " 条对不上");
    const liveText = new Set();
    for (const t of L1.edges) if (t !== null) liveText.add(t);
    let missE = 0;
    for (const r of refEdges) {
      if (NF.streamLiveN(r[0]) < 0 || NF.streamLiveN(r[1]) < 0) continue;
      if (!liveText.has(r[2])) missE++;
    }
    ok(missE === 0, "两端都还驻留的边一条都没丢", missE + " 条丢了");
    ok(NF.blocksInfo().length === 0 || NF.blockTotal() <= bwB,
      "权重块的权重总数没有因为驱逐而变多",
      NF.blocksInfo().length + " 个块 / " + num(NF.blockTotal()) + " <= " + num(bwB));

    /* 11c. 钉住：选中的神经元所在的块不会被丢 */
    NF.streamReset();
    NF.streamAuto(false);
    NF.streamMemMax(MB);
    await NF.streamLoadAll();
    lookDownAxis();
    const p0 = NF.streamPlan(per);
    ok(p0 !== null && p0.drop.length > 0, "（钉子用例前置）有一批块在待丢名单里", p0 ? p0.drop.length + " 块" : "-");
    const victim = p0.drop[p0.drop.length - 1];
    const vfid = H.chunks[victim].n0 + 5;
    const vlive = NF.streamLiveN(vfid);
    ok(vlive >= 0, "从待丢名单里挑一块，取其内的一个神经元", "块 " + victim + " -> live " + vlive);
    NF.select([vlive], []);
    const p1 = NF.streamPlan(per);
    ok(p1 !== null && p1.drop.indexOf(victim) < 0, "选中之后，这块从待丢名单里消失了（被钉住）",
      "块 " + victim + " 在 drop 里吗：" + (p1 ? (p1.drop.indexOf(victim) >= 0) : "-"));
    NF.streamEvictKeep(p1.keep);
    ok(NF.streamLiveN(vfid) >= 0, "驱逐之后这块还在场上（连带那个神经元）", "live " + NF.streamLiveN(vfid));
    const L3 = liveDig();
    ok(L3.pc[victim] && L3.pc[victim].nh === chunkDigests[victim].nh,
      "被钉住的那一块驱逐后逐位不变",
      "块 " + victim + "：" + (L3.pc[victim] ? L3.pc[victim].nh : "不见了"));

    /* 11d. 漫游：相机一路往前飞，驻留量必须一直被压在预算以内，
           而且不会撞到 MAX_N 那个硬上限——这才是驱逐真正要解决的问题 */
    NF.streamReset();
    NF.streamMemMax(MB);
    NF.streamEvictOn(true);
    NF.streamAuto(true);
    lookDownAxis();
    toasts = [];
    const read0 = NF.streamState().readBytes;
    let peak = 0, over = 0, evSeen = 0, stall = 0;
    const stops = [1, 4, 7, 10, 13, 16, 19, 22, 19, 16, 13, 10, 7, 4, 1];
    for (const k of stops) {
      const b = H.chunks[k].bbox, cx = (b[0] + b[3]) / 2;
      NF.setCam(cx - 900, 60, 0, cx + 200, 0, 0);
      const eV = NF.streamState().evicted, nB = NF.graph().n;
      await NF.streamTickNow();
      const g = NF.graph();
      if (g.n > peak) peak = g.n;
      if (g.n > MB) over++;
      if (NF.streamState().evicted > eV) evSeen++;
      /* 预算塞满、而视野里的块又全都还驻留着：这一帧真的载不进东西。
         这是预算真正撞穿了，不是 bug，所以只计数不断言为 0 */
      if (g.n === nB && NF.streamPick().length > 0) stall++;
    }
    NF.streamAuto(false);
    const roam = NF.streamState();
    ok(peak <= MB && over === 0, "漫游全程驻留神经元一次都没超过上限",
      "峰值 " + num(peak) + " <= " + num(MB) + "，越界 " + over + " 次；预算撞满导致这一帧载不进的有 " + stall + " 站");
    ok(evSeen > 0 && roam.evicted > 0, "漫游过程中真的驱逐过（不然上限一满就再也载不进新块了）",
      "有 " + evSeen + " 站发生了驱逐，累计 " + roam.evicted + " 块 / " + roam.evictRuns + " 次");
    ok(roam.readBytes > read0, "一路读进来的字节一直在涨（真的在一段段往新区域走）",
      num(read0) + " -> " + num(roam.readBytes));
    ok(toastText().indexOf("容量上限") < 0, "全程没有撞到 MAX_N 的硬上限", toastText() || "（没有提示）");
    ok(NF.streamBoxes().unloaded > 0, "视野外 / 被丢掉的块还是画成线框盒", NF.streamBoxes().unloaded + " 个");

    /* ---------- 8. 保存守卫（走真实菜单路径） ---------- */
    NF.streamReset();
    NF.streamAuto(false);
    toasts = [];
    document.querySelector("[data-cmd=save]").click();
    await sleep(120);
    ok(toastText().indexOf("还没全部载入") >= 0, "半载入时点「保存工程」会被拦住并说明原因", toastText());
    await NF.streamLoadAll();
    toasts = [];
    document.querySelector("[data-cmd=save]").click();
    await sleep(1500);
    ok(toastText().indexOf("工程已保存") >= 0, "全部载入后点保存就走通了", toastText().slice(0, 120));

    /* ---------- 9. 坏文件不能把状态搞乱 ---------- */
    const menuEl = document.querySelector("[data-cmd=open-stream]");
    ok(!!menuEl, "「文件」菜单里有「流式载入…」这一项",
      menuEl ? menuEl.textContent.trim() : "找不到菜单项");

    const junk = new Uint8Array(64);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) & 255;
    let threw = "";
    try { await NF.streamOpen(junk, "junk.bin"); } catch (e) { threw = String((e && e.message) || e); }
    ok(threw.length > 0, "魔数不对的文件直接拒绝", threw);

    const hl = headLen;
    const hj = JSON.parse(new TextDecoder().decode(buf.subarray(16, 16 + hl)));
    hj.chunks[0].n1 = hj.chunks[0].n1 + 1;      /* 让区间不再首尾相接 */
    const enc = new TextEncoder().encode(JSON.stringify(hj));
    if (enc.length > hl) throw new Error("改过的头比原来长了，没法塞回去");
    const padded = new Uint8Array(hl); padded.fill(32); padded.set(enc, 0);
    const bad = buf.slice(); bad.set(padded, 16);
    let threw2 = "";
    try { await NF.streamOpen(bad, "bad-index.nforge"); } catch (e) { threw2 = String((e && e.message) || e); }
    ok(threw2.indexOf("索引表不自洽") >= 0, "索引表不相接的文件也被挡在门口", threw2);

    /* ---------- 9b. 权重块按段读：只读相机附近的那几段 ---------- */
    const NP = NF.blockPartCount(buf);
    const bmB = H.blocks || {};
    ok(NP > 1 && NP === bmB.count, "权重块是按段存的，段数 = 块数",
      NP + " 段 / " + bmB.count + " 块 / " + bmB.codec);
    const pms = bmB.parts || [];
    let pNoBox = 0;
    for (const p of pms) if (!p.bbox || p.bbox.length !== 6) pNoBox++;
    ok(pNoBox === 0, "每一段都带自己的包围盒（挑段一个字节都不用解压）",
      pms.length ? JSON.stringify(pms[0].bbox) : "没有段");
    let pAcc = 0, pGap = 0;
    for (const p of pms) { if (p.off !== pAcc) pGap++; pAcc += p.len; }
    ok(pGap === 0 && pAcc === bmB.len, "各段首尾相接，各段长度之和 = 区块长度",
      pAcc + " / " + bmB.len);

    await NF.streamOpen(buf, "streamdemo.nforge");
    NF.streamAuto(false);
    const mid = Math.floor(NCH / 2);
    await NF.streamLoad([mid - 1, mid, mid + 1]);
    const rd0 = NF.streamState().readBytes;
    const rb1 = await NF.streamBlocks();
    const rd1 = NF.streamState().readBytes;
    ok(rb1.tried === 3 && rb1.skipped === NP - 3, "只驻留 3 块时，只有这 3 块对应的权重段被读",
      "试读 " + rb1.tried + " 段 / 跳过 " + rb1.skipped + " 段 / 共 " + NP + " 段");
    ok(rd1 - rd0 === rb1.bytes && rb1.bytes > 0 && rb1.bytes * 4 < bmB.len,
      "从盘上真正读进来的只有那几段（远小于整段）",
      (rd1 - rd0) + " B < 整段 " + bmB.len + " B（段均 " + Math.round(bmB.len / NP) + " B）");
    ok(rb1.loaded === 3 && NF.blocksInfo().length === 3, "三段解出来正好三块，落进了场景",
      rb1.loaded + " 块 / 场景里 " + NF.blocksInfo().length + " 块");
    const rb2 = await NF.streamBlocks();
    ok(rb2.loaded === 0 && rb2.tried === 0, "再点一次不会重复载入（读过的段有账本）",
      "loaded=" + rb2.loaded + " tried=" + rb2.tried + " 场景里 " + NF.blocksInfo().length + " 块");

    /* 驱逐：块跟着端点走，那几段退回「没读过」，走近了还能读回来，而且不会翻倍 */
    NF.streamEvictKeep([mid]);
    ok(NF.blocksInfo().length === 1, "驱逐之后只剩还驻留那块的权重块",
      NF.blocksInfo().length + " 块");
    await NF.streamLoad([mid - 1]);
    const rb3 = await NF.streamBlocks();
    ok(rb3.tried === 1 && rb3.loaded === 1 && NF.blocksInfo().length === 2,
      "被驱逐那段的权重块能重新读回来，而且没有重复建块",
      "tried=" + rb3.tried + " loaded=" + rb3.loaded + " 场景里 " + NF.blocksInfo().length + " 块");

    await NF.streamLoadAll();
    ok(NF.blocksInfo().length === NP && NF.blockTotal() === H.counts.blockWeights,
      "全部载入后：权重块数 = 段数，权重总数 = 文件头",
      NF.blocksInfo().length + " / " + NP + "，权重 " + num(NF.blockTotal()) + " / "
      + num(H.counts.blockWeights));
    const blkSel = { parts: NP, len: bmB.len, codec: bmB.codec, tried: rb1.tried,
                     skipped: rb1.skipped, bytes: rb1.bytes, loaded: rb1.loaded,
                     refetch: { tried: rb2.tried, loaded: rb2.loaded },
                     afterEvict: { tried: rb3.tried, loaded: rb3.loaded },
                     allBlocks: NF.blocksInfo().length, allWeights: NF.blockTotal() };

    /* ---------- 10. 退出流式 ---------- */
    await NF.streamOpen(buf, "streamdemo.nforge");
    NF.streamAuto(false);
    await NF.streamLoad([0]);
    /* 面板和菜单项是用户真正摸得到的东西，顺手也验一下 */
    const secOn = document.getElementById("sec-stream");
    ok(!!secOn && secOn.style.display !== "none", "打开流式工程后左栏的流式面板露出来",
      secOn ? String(secOn.style.display) : "找不到面板");
    const stmPx = document.getElementById("stm-px");
    ok(!!stmPx && parseFloat(stmPx.value) === NF.streamState().minPx, "面板上的细节阈值跟着当前值走",
      stmPx ? stmPx.value : "找不到输入框");
    const stmMem = document.getElementById("stm-mem");
    ok(!!stmMem && parseInt(stmMem.value, 10) === NF.streamState().memMax, "面板上的驻留上限跟着当前值走",
      stmMem ? stmMem.value : "找不到输入框");
    const stmEvo = document.getElementById("stm-evict-on");
    ok(!!stmEvo && stmEvo.checked === NF.streamState().evictOn, "面板上的驱逐开关跟着当前值走",
      stmEvo ? String(stmEvo.checked) : "找不到开关");
    const stmEvi = document.getElementById("stm-evict");
    ok(!!stmEvi && stmEvi.textContent.length > 0, "面板上显示了已驱逐的块数",
      stmEvi ? stmEvi.textContent : "找不到计数");
    /* 面板上的控件真的能改到内部状态（光有控件没绑定事件是最常见的漏洞） */
    const mem0 = NF.streamState().memMax, ev0 = NF.streamState().evictOn;
    stmMem.value = "6000"; stmMem.dispatchEvent(new Event("change"));
    ok(NF.streamState().memMax === 6000, "改面板上的上限真的会改到内部状态",
      mem0 + " -> " + NF.streamState().memMax);
    stmEvo.checked = false; stmEvo.dispatchEvent(new Event("change"));
    ok(NF.streamState().evictOn === false, "关掉面板上的开关真的会关掉驱逐",
      ev0 + " -> " + NF.streamState().evictOn);
    stmEvo.checked = true; stmEvo.dispatchEvent(new Event("change"));
    stmMem.value = String(mem0); stmMem.dispatchEvent(new Event("change"));
    ok(NF.streamState().memMax === mem0 && NF.streamState().evictOn === true, "改回去也一样（两个控件都是双向的）",
      NF.streamState().memMax + " / " + NF.streamState().evictOn);
    NF.streamOff();
    const off = NF.streamState();
    ok(off.on === false && off.resident === 0, "streamOff 之后不再是流式模式", JSON.stringify({ on: off.on }));
    ok(NF.streamBoxes().visible === false, "线框盒也收掉了", JSON.stringify(NF.streamBoxes()));
    ok(NF.graph().n === per, "已经解压进内存的神经元留在场景里（streamOff 不负责丢数据）", num(NF.graph().n));
    const sec = document.getElementById("sec-stream");
    ok(!!sec && sec.style.display === "none", "左栏的流式面板跟着收起来",
      sec ? String(sec.style.display) : "找不到面板");

    const info = { passes, fails, out, state: NF.streamState(), sample: "_streamdemo_raw.nforge",
      chunkNeurons: per, chunks: NCH, chunkDigests: chunkDigests, blockSel: blkSel };
    await post("streamcheck.json", JSON.stringify(info));
    out.push("");
    out.push(fails ? ("FAILS " + fails) : ("== " + passes + " PASS / 0 FAIL =="));
    document.title = (fails ? "NFSTREAM BAD " + fails + "F " : "NFSTREAM OK ") + passes + "P/" + fails + "F"
      + " | 块 " + NCH + " | 打开只读 " + num(16 + headLen) + " B / " + num(fileBytes) + " B";
  } catch (e) {
    const msg = String((e && e.stack) || e);
    out.push("ERROR " + msg);
    document.title = "NFSTREAM ERR " + String((e && e.message) || e).slice(0, 70);
    try { await post("streamcheck.json", JSON.stringify({ error: msg, out })); } catch (_) {}
  }
  show(out.join(NL));
})();
<\/script>
`;
fs.writeFileSync("prototype/_streamcheck.html", html.replace("</body>", TEST + "</body>"));
console.log("generated prototype/_streamcheck.html");
