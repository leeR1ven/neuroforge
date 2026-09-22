import fs from 'node:fs';
/* 手册版本现取，别写死：从 ai_manual.js 里把 AI_MANUAL_VERSION 抠出来。 */
const AI_MANUAL_VERSION = (/AI_MANUAL_VERSION\s*=\s*'([^']+)'/
  .exec(fs.readFileSync('prototype/src/ai_manual.js', 'utf8')) || [])[1];
if (!AI_MANUAL_VERSION) throw new Error('读不到 AI_MANUAL_VERSION');

const SRC = 'prototype/神经元编辑器原型.html';
const html = fs.readFileSync(SRC, 'utf8');
/* 防呆：这一页是从 build.mjs 生成的单文件原型里切出来的。bundle 比它新，说明有人改了
   src 却没重新构建 —— 切出来的自测页跑的还是旧代码，会得出「改了也没用」的假结论，
   而且报的 FAIL 全是旧代码的（这一轮真踩过）。宁可当场失败，也别让人对着假结果查半天。 */
const _bundle = 'prototype/dist/bundle.js';
if (fs.existsSync(_bundle) && fs.statSync(_bundle).mtimeMs > fs.statSync(SRC).mtimeMs) {
  throw new Error('prototype/dist/bundle.js 比 ' + SRC + ' 新：先跑 node prototype/build.mjs（重新打包 + 刷新全部校验页）');
}
if (!html.includes('</body>')) throw new Error('no </body>');

/* ---------- 1) 逻辑自测页 ---------- */
const TEST = `
<script>
(async () => {
  const out = [];
  /* 每记一条就把「跑到第几条」写进窗口标题：自测要是卡死了，从外面看标题就知道卡在哪一步。
     标题格式刻意写成 NFTEST# 开头，不会跟最后那句 NFTEST <n>P/<n>F 撞车。 */
  const log = (ok, name, detail) => {
    out.push((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (detail == null ? '' : detail));
    try { document.title = 'NFTEST#' + out.length + ' ' + String(name).slice(0, 40); } catch (e) {}
  };
  const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  /* 截图不能只看"字节数够不够"——底色统一了，PNG 自然就小。
     真的把它解码出来，数一数除底色以外还有多少像素，才算"这图里有东西"。 */
  const shotInk = (url) => new Promise((res) => {
    if (typeof url !== 'string' || url.indexOf('data:image') !== 0) return res({ ok: false, w: 0, h: 0, ink: 0 });
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = im.width; cv.height = im.height;
      const g = cv.getContext('2d');
      g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - 8) + Math.abs(d[i + 1] - 11) + Math.abs(d[i + 2] - 16) > 6) ink++;
      }
      res({ ok: ink > 0, w: im.width, h: im.height, ink: ink });
    };
    im.onerror = () => res({ ok: false, w: 0, h: 0, ink: 0 });
    im.src = url;
  });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const seg = (px, py, ax, ay, bx, by) => {
    const ux = bx - ax, uy = by - ay, wx = px - ax, wy = py - ay;
    const uu = ux * ux + uy * uy;
    let t = uu < 1e-6 ? 0 : (wx * ux + wy * uy) / uu;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - ux * t, dy = wy - uy * t;
    return Math.sqrt(dx * dx + dy * dy);
  };
  /* 自测要动设置里的 Key（验填 / 验清），但用户机器上可能真的存着一个能用的 Key。
     壳子里先等「开机读配置」跑完（那是异步的），再把 Key 整段记下来，跑完原样写回去。
     上一次就是自测把用户的 Key 抹掉的 —— 这次不许再发生。 */
  let KEEP19 = { key: "", visKey: "" };
  try {
    if (document.readyState !== 'complete') await new Promise(r => addEventListener('load', r));
    await raf();
    const NF = window.NF;
    log(!!NF, 'NF 脚本接口已挂载', NF ? Object.keys(NF).length + ' 个接口' : 'undefined');
    if (!NF) throw new Error('window.NF 未挂载');
    const g0 = NF.graph();
    log(g0.n > 0 && g0.e > 0, '默认图已加载', g0.n + ' 神经元 / ' + g0.e + ' 连接');
    /* 开机不再问一句（2026-09 把默认值从 ask 改成 auto）。自测页跑在**全新档案**上，
       这里读到的就是没被任何设置动过的默认值。 */
    log(NF.autorestore() === 'auto', '开机默认直接接回上次工程，不再弹一条横幅问一句', 'mode=' + NF.autorestore());
    log(!document.getElementById('nfbanner') || document.getElementById('nfbanner').style.display === 'none',
        '自测页开机时画面上没有挂着挡路的横幅', (function () { const b = document.getElementById('nfbanner'); return b ? String(b.style.display) : '没有这个元素'; })());
    /* 开场快照：把本机存着的 Key 记下来（只记内容，不打印） */
    if (NF.inShell()) { try { await NF.aiCfgBoot(); } catch (e) {} }
    try { const j0 = JSON.parse(localStorage.getItem('nf.ai') || '{}'); KEEP19 = { key: String(j0.key || ""), visKey: String(j0.visKey || "") }; } catch (e) {}
    if (KEEP19.key) log(true, '开场快照：本机已经存着 ' + KEEP19.key.length + ' 位的 Key，跑完会原样放回去', '不打印内容');
    log(NF.aiState().bakKey === KEEP19.key.length, '开场快照：备份那一格里的 Key 位数跟现役那份一致（两份不会各走各的）', '备份 ' + NF.aiState().bakKey + ' 位');
    /* 撤销检查点的「裁判模式」：不信「登记」，每一拍照旧整列比一遍，并统计「登记说没动、实际却动了」
       的漏报。整场自测都开着跑，等于把「有没有写入点漏打了 histEdgeDirty 钩子」从头到尾验一遍
       （收尾那条断言 miss === 0）。慢一点，但这是唯一能当场抓住「撤销静默回错格」的办法。 */
    try { log(NF.histVerify(true) === true, '撤销裁判模式已打开（整场自测每一拍都整列复比）'); }
    catch (e) { log(false, '打开撤销裁判模式', (e && e.message) || String(e)); }

    /* ---- 1. 入边 / 出边高亮 ---- */
    const inCnt = [], outCnt = [];
    for (let e = 0; e < g0.e; e++) { const ed = NF.edge(e); inCnt[ed.dst] = (inCnt[ed.dst] || 0) + 1; outCnt[ed.src] = (outCnt[ed.src] || 0) + 1; }
    let node = -1;
    for (let i = 0; i < g0.n; i++) if ((inCnt[i] || 0) > 0 && (outCnt[i] || 0) > 0) { node = i; break; }
    log(node >= 0, '找到同时有入边和出边的神经元', '#' + node);
    NF.select([node], []);
    await raf();
    const hl = NF.highlight();
    const hlIn = hl.filter(x => x.in), hlOut = hl.filter(x => x.out);
    const bad = hl.filter(x => x.in && NF.edge(x.e).dst !== node).length + hl.filter(x => x.out && NF.edge(x.e).src !== node).length;
    log(bad === 0, '高亮分类无误（入边->dst / 出边->src）', '错分 ' + bad + ' 条');
    log(hlIn.length === (inCnt[node] || 0), '入边高亮完整', hlIn.length + '/' + (inCnt[node] || 0));
    log(hlOut.length === (outCnt[node] || 0), '出边高亮完整', hlOut.length + '/' + (outCnt[node] || 0));
    log(hl.length === hlIn.length + hlOut.length, '每条关联边只归一类', hl.length + ' 条关联边');

    /* 多选时的并集 */
    const others = [];
    for (let i = 0; i < g0.n && others.length < 3; i++) if (i !== node && (inCnt[i] || 0) > 0 && (outCnt[i] || 0) > 0) others.push(i);
    const sel3 = [node].concat(others);
    const wantE = new Set();
    for (let e = 0; e < g0.e; e++) { const ed = NF.edge(e); if (sel3.indexOf(ed.dst) >= 0 || sel3.indexOf(ed.src) >= 0) wantE.add(e); }
    NF.select(sel3, []);
    await raf();
    const hl3 = NF.highlight();
    let okU = hl3.length === wantE.size;
    for (const x of hl3) if (!wantE.has(x.e)) okU = false;
    log(okU, '多选神经元时高亮取并集', '高亮 ' + hl3.length + ' / 期望 ' + wantE.size + '（选中 ' + sel3.length + ' 个）');
    let st = NF.stats();
    log(st.selNodes === sel3.length, '选中计数正确', 'selNodes=' + st.selNodes);
    log(!!st.dim, '选中后淡化生效', 'dim=' + st.dim);

    /* ---- 2. 淡化开关 ---- */
    const cb = document.getElementById('v-dim');
    cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
    await raf();
    log(!NF.stats().dim, '关闭淡化开关生效', 'dim=' + NF.stats().dim);
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
    await raf();
    log(!!NF.stats().dim, '重新开启淡化生效', 'dim=' + NF.stats().dim);
    NF.select([node], []);

    /* ---- 3. 屏幕空间连线拾取 ---- */
    let total = 0, exact = 0, worst = 0;
    for (let e = 0; e < g0.e; e++) {
      const ed = NF.edge(e);
      const a = NF.screenOf(ed.src), b = NF.screenOf(ed.dst);
      if (!a.visible || !b.visible) continue;
      total++;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const t0 = performance.now();
      const hit = NF.pickEdgeAt(mx, my);
      const dt = performance.now() - t0;
      if (dt > worst) worst = dt;
      if (hit === e) exact++;
    }
    log(total > 0 && exact === total, '连线中点命中自身', exact + '/' + total + '，最慢 ' + worst.toFixed(2) + ' ms');

    /* 容差必须是 7 像素：故意偏 5px，返回值到查询点的距离不得超过 7px */
    let worstDist = 0, miss = 0, checked = 0;
    for (let e = 0; e < g0.e; e++) {
      const ed = NF.edge(e);
      const a = NF.screenOf(ed.src), b = NF.screenOf(ed.dst);
      if (!a.visible || !b.visible) continue;
      checked++;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + 5;
      const hit = NF.pickEdgeAt(mx, my);
      if (hit < 0) { miss++; continue; }
      const h = NF.edge(hit);
      const ha = NF.screenOf(h.src), hb = NF.screenOf(h.dst);
      const d = seg(mx, my, ha.x, ha.y, hb.x, hb.y);
      if (d > worstDist) worstDist = d;
    }
    log(miss === 0 && worstDist <= 7.0001, '拾取结果始终落在 7px 容差内', '最远 ' + worstDist.toFixed(2) + ' px，落空 ' + miss + '/' + checked);

    /* 远离图区必须落空 */
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i < g0.n; i++) { const p = NF.screenOf(i); if (!p.visible) continue; if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    const rect = document.querySelector('canvas').getBoundingClientRect();
    const qx = Math.max(rect.left + 2, minX - 60), qy = Math.max(rect.top + 2, minY - 60);
    log(NF.pickEdgeAt(qx, qy) < 0, '远离图区不误选', '(' + Math.round(qx) + ',' + Math.round(qy) + ')');

    /* ---- 4. 按坐标放置：排模式 ---- */
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, axis: 0, axis2: 1, plane: false, rowLen: 8, count: 0, rowStart: 0 });
    await raf();
    let base = NF.graph().n;
    for (let k = 0; k < 5; k++) NF.place();
    await raf();
    const got = [];
    for (let i = base; i < NF.graph().n; i++) { const n = NF.node(i); got.push([n.x, n.y, n.z]); }
    log(JSON.stringify(got) === JSON.stringify([[0,0,0],[10,0,0],[20,0,0],[30,0,0],[40,0,0]]), '排模式沿 X 每步 10', JSON.stringify(got));
    let pl = NF.placement();
    log(pl.x === 50 && pl.count === 5, '步进状态推进正确', 'x=' + pl.x + ' count=' + pl.count);
    log(NF.graph().n === base + 5, '神经元计数同步', base + ' -> ' + NF.graph().n);

    /* ---- 5. 切轴与负步进 ---- */
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 5, axis: 2, axis2: 1, plane: false, rowLen: 8, count: 0, rowStart: 0 });
    base = NF.graph().n;
    NF.place(); NF.place(); NF.place();
    const gotZ = [];
    for (let i = base; i < NF.graph().n; i++) { const n = NF.node(i); gotZ.push([n.x, n.y, n.z]); }
    log(JSON.stringify(gotZ) === JSON.stringify([[0,0,0],[0,0,5],[0,0,10]]), '主步进轴切到 Z', JSON.stringify(gotZ));

    NF.setPlacement({ x: 0, y: 100, z: 0, step: -10, axis: 1, axis2: 0, plane: false, rowLen: 8, count: 0, rowStart: 100 });
    base = NF.graph().n;
    NF.place(); NF.place(); NF.place();
    const gotN = [];
    for (let i = base; i < NF.graph().n; i++) { const n = NF.node(i); gotN.push([n.x, n.y, n.z]); }
    log(JSON.stringify(gotN) === JSON.stringify([[0,100,0],[0,90,0],[0,80,0]]), '负步进方向正确', JSON.stringify(gotN));

    /* ---- 6. 面模式 ---- */
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, axis: 0, axis2: 1, plane: true, rowLen: 3, count: 0, rowStart: 0 });
    base = NF.graph().n;
    for (let k = 0; k < 6; k++) NF.place();
    const gotP = [];
    for (let i = base; i < NF.graph().n; i++) { const n = NF.node(i); gotP.push([n.x, n.y, n.z]); }
    log(JSON.stringify(gotP) === JSON.stringify([[0,0,0],[10,0,0],[20,0,0],[0,10,0],[10,10,0],[20,10,0]]), '面模式每行 3 个后换轴', JSON.stringify(gotP));

    /* 面模式：主轴 Z、第二轴 X */
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 1, axis: 2, axis2: 0, plane: true, rowLen: 2, count: 0, rowStart: 0 });
    base = NF.graph().n;
    for (let k = 0; k < 4; k++) NF.place();
    const gotP2 = [];
    for (let i = base; i < NF.graph().n; i++) { const n = NF.node(i); gotP2.push([n.x, n.y, n.z]); }
    log(JSON.stringify(gotP2) === JSON.stringify([[0,0,0],[0,0,1],[1,0,0],[1,0,1]]), '面模式可换任意双轴（主轴 Z / 次轴 X）', JSON.stringify(gotP2));

    /* ---- 7. 界面联动 ---- */
    const infoTxt = document.getElementById('pl-info').textContent.replace(/\\s+/g, ' ').trim();
    log(infoTxt.indexOf('已放') >= 0 && infoTxt.indexOf('面模式') >= 0, '放置面板同步显示状态', infoTxt);
    NF.setPlacement({ x: 7, y: -3, z: 2, step: 10, axis: 0, axis2: 1, plane: false, rowLen: 8, count: 0, rowStart: 7 });
    await raf();
    const info2 = document.getElementById('pl-info').textContent.replace(/\\s+/g, ' ');
    log(info2.indexOf('(7, -3, 2)') >= 0, '面板回显设定坐标', info2.trim());

    /* ---- 8. 连线选中 ---- */
    NF.select([], [0]);
    log(NF.stats().selEdges === 1, '可选中单条连线', 'selEdges=' + NF.stats().selEdges);
    NF.select([], [0, 1, 2]);
    log(NF.stats().selEdges === 3, '可多选连线', 'selEdges=' + NF.stats().selEdges);
    NF.select([], []);
    log(NF.stats().selEdges === 0, '可清空连线选中');

    /* ---- 9. 接口：外界信号 <-> 软件 ---- */
    NF.clear();
    await raf();
    const A0 = NF.addNode(0, 0, 0), A1 = NF.addNode(0, 10, 0);
    const B2 = NF.addNode(20, 5, 0), C3 = NF.addNode(40, 5, 0), D4 = NF.addNode(60, 5, 0);
    NF.addEdge(A0, B2, 0.3); NF.addEdge(A1, B2, 0.3);
    NF.addEdge(B2, C3, 3.0); NF.addEdge(C3, D4, 1.0);
    NF.setIO([A0, A1], 1); NF.setIO([D4], 2);
    await raf();
    let L = NF.ioLists();
    log(L.ins.length === 2 && L.outs.length === 1, "接口列表正确", "输入 " + JSON.stringify(L.ins) + " 输出 " + JSON.stringify(L.outs));
    let ir = NF.ir();
    log(!!ir && ir.inputs.length === 2 && ir.outputs.length === 1, "编译 IR 用接口决定输入/输出张量",
        "inputs=" + JSON.stringify(ir && ir.inputs) + " outputs=" + JSON.stringify(ir && ir.outputs));
    log(!!ir && ir.orphanEdges === 0 && ir.badDstEdges === 0, "IR 完整性：每条边都能找到合法的张量位置",
        "orphan=" + (ir && ir.orphanEdges) + " badDst=" + (ir && ir.badDstEdges));
    NF.setIO([B2], 3);
    L = NF.ioLists();
    log(L.both.length === 1 && L.both[0] === B2, "可标记双向接口", JSON.stringify(L.both));
    ir = NF.ir();
    log(ir.inputs.indexOf(B2) >= 0 && ir.outputs.indexOf(B2) >= 0, "双向接口同时出现在输入与输出张量里");
    log(ir.orphanEdges === 0 && ir.badDstEdges === 0, "双向接口下 IR 依然完整",
        "orphan=" + ir.orphanEdges + " badDst=" + ir.badDstEdges);
    NF.setIO([B2], 0);
    log(NF.ioLists().both.length === 0, "可取消接口");
    log(NF.node(B2).io === 0, "取消后节点标记归零", "io=" + NF.node(B2).io);

    /* ---- 10. 模拟激活：阈值门槛 ---- */
    const single = NF.simCompute([A0], {});
    log(single.activated === 1, "只给一个信号源时推不动后面的神经元（未达阈值）",
        "激活 " + single.activated + " 个，被挡住 " + single.blocked + " 个");
    const dual = NF.simCompute([A0, A1], {});
    log(dual.activated === 5, "多个信号源一起注入即可级联激活",
        "激活 " + dual.activated + " 个，顺序 " + JSON.stringify(dual.order));
    log(dual.byWave[0].length === 2 && dual.byWave[1].length === 1 && dual.byWave[2].length === 1 && dual.byWave[3].length === 1,
        "按拓扑波次分批激活", "每波 " + JSON.stringify(dual.byWave.map(function (a) { return a.length; })));
    let orderOk = true;
    for (let e = 0; e < NF.graph().e; e++) {
      const ed = NF.edge(e);
      const ws = dual.waveOf[ed.src], wd = dual.waveOf[ed.dst];
      if (ws >= 0 && wd >= 0 && wd <= ws) orderOk = false;
    }
    log(orderOk, "激活顺序符合拓扑（下游波次严格晚于上游）", JSON.stringify(dual.waveOf));
    log(dual.val[B2] > 0 && Math.abs(dual.val[B2] - 0.6) < 1e-5, "激活值等于加权和经激活函数的结果",
        "B2=" + dual.val[B2].toFixed(4) + "（0.3 + 0.3 = 0.6，ReLU）");
    NF.setThr([B2], 0.9);
    const hiThr = NF.simCompute([A0, A1], {});
    log(hiThr.activated === 2, "把阈值调高后同一个网络不再级联", "激活 " + hiThr.activated + " 个");
    NF.setThr([B2], 0.5);
    const back = NF.simCompute([A0, A1], {});
    log(back.activated === 5, "阈值调回去后级联恢复", "激活 " + back.activated + " 个");

    /* ---- 11. 模拟激活：播放与清除 ---- */
    NF.simRun([A0, A1]);
    log(NF.simState().total === 5, "提示里记录了本轮将点亮的总数", "total=" + NF.simState().total);
    await raf(); await raf();
    const simMid = NF.simState();
    log(simMid.active && simMid.playing && simMid.wave >= 0 && simMid.wave <= simMid.maxWave,
        "模拟激活开始逐波播放", JSON.stringify(simMid));
    /* B2 在第 2 波点亮，它不是信号源（信号源会被选中、渲染色是白色），正好用来验证脉冲上色 */
    const baseB2 = NF.renderColor(B2);
    let sawLit = null, peak = -1;
    for (let i = 0; i < 300 && sawLit === null; i++) {
      await raf();
      const c = NF.renderColor(B2);
      if (c !== baseB2) { sawLit = c; }
      if (NF.simState().reached > peak) peak = NF.simState().reached;
    }
    log(sawLit !== null, "被点亮的神经元在脉冲期间真的换了颜色", "B2 " + baseB2 + " -> " + sawLit);
    log(peak > 0 && peak < 5, "已点亮数随波次递增，而不是一次全亮", "峰值 reached=" + peak + " / 总数 5");
    let faded = false;
    for (let i = 0; i < 900 && !faded; i++) { await raf(); if (NF.renderColor(B2) === baseB2) faded = true; }
    log(faded, "脉冲淡出后自动恢复原色，不会一直亮着", "B2 = " + NF.renderColor(B2));
    let cleared = false;
    for (let i = 0; i < 900 && !cleared; i++) { await raf(); if (!NF.simState().active) cleared = true; }
    log(cleared, "全部脉冲结束后自动收工", JSON.stringify(NF.simState()));
    NF.simRun([A0, A1]);
    await sleep(60);
    log(NF.simState().active, "收工后可以再次播放");
    NF.simClear();
    log(!NF.simState().active, "也可以中途清除模拟激活");
    let clean = true;
    for (let i = 0; i < 5 && clean; i++) { await raf(); if (NF.renderColor(B2) !== baseB2) clean = false; }
    log(clean, "中途清除后立刻恢复原色", "B2 = " + NF.renderColor(B2));

    /* ---- 12. 颜色 ---- */
    NF.clear();
    const c1 = NF.addNode(0, 0, 0), c2 = NF.addNode(10, 0, 0), c3 = NF.addNode(20, 0, 0);
    log(NF.node(c1).color === "#818cf8", "普通神经元默认色", NF.node(c1).color);
    log(NF.node(c1).colOn === 0, "普通神经元默认不使用自定义颜色");
    NF.setIO([c2], 1);
    NF.setIO([c3], 3);
    await raf();
    log(NF.node(c2).color === "#22d3ee", "接口色自动生效", NF.node(c2).color);
    log(NF.node(c3).color === "#a3e635", "双向接口有独立颜色", NF.node(c3).color);
    log(NF.node(c3).colOn === 0, "接口节点默认不使用自定义颜色");
    log(NF.node(c3).io === 3, "双向接口标记已写入", "io=" + NF.node(c3).io);
    NF.setColor([c1], "#ff0000");
    log(NF.node(c1).color === "#ff0000" && NF.node(c1).colOn === 1, "可单个改颜色", NF.node(c1).color);
    NF.setColor([c2], "#ff0000");
    log(NF.node(c2).color === "#ff0000", "自定义颜色优先于接口色", NF.node(c2).color);
    NF.setColor([c3], "#336699");
    log(NF.node(c3).color === "#336699", "非饱和色也能原样往返（色彩空间一致）", NF.node(c3).color);
    NF.rainbow([c1, c2, c3]);
    const cs = [NF.node(c1).color, NF.node(c2).color, NF.node(c3).color];
    log(new Set(cs).size === 3, "按顺序自动配色给出互不相同的颜色", JSON.stringify(cs));

    /* ---- 12b. 按坐标放置时直接标颜色 ---- */
    NF.clear();
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, axis: 0, axis2: 1, plane: false, rowLen: 8, count: 0, rowStart: 0,
                    colOn: true, color: "#ff8800" });
    NF.place();
    const pc = NF.graph().n - 1;
    log(NF.node(pc).colOn === 1 && NF.node(pc).color === "#ff8800",
        "放置面板的颜色会标到新放的神经元上", NF.node(pc).color);
    NF.setPlacement({ colOn: false });
    NF.place();
    const pc2 = NF.graph().n - 1;
    log(NF.node(pc2).colOn === 0 && NF.node(pc2).color === "#818cf8",
        "关掉勾选后新放的神经元回到默认色", NF.node(pc2).color);

    /* ---- 13. 拖动坐标实时生效 ---- */
    NF.clear();
    const p1 = NF.addNode(0, 0, 0);
    NF.select([p1], []);
    await raf();
    let pxEl = document.querySelector("[data-act=px]");
    log(!!pxEl, "属性面板出现 X 坐标输入框");
    if (pxEl) {
      pxEl.focus();
      pxEl.value = "123";
      pxEl.dispatchEvent(new Event("input", { bubbles: true }));
      log(NF.node(p1).x === 123, "输入过程中（未松手、未失焦）坐标已实时生效", "x=" + NF.node(p1).x);
      log(document.querySelector("[data-act=px]") === pxEl, "拖动过程中输入框没有被重建（否则拖动会中断）");
      const badge = document.getElementById("posbadge");
      log(!!badge && badge.style.display === "block" && badge.textContent.indexOf("123") >= 0,
          "视口实时显示拖动位置", badge ? badge.textContent : "(无)");
      pxEl.value = "77";
      pxEl.dispatchEvent(new Event("input", { bubbles: true }));
      log(NF.node(p1).x === 77, "继续拖动继续跟随", "x=" + NF.node(p1).x);
      pxEl.dispatchEvent(new Event("change", { bubbles: true }));
      log(NF.node(p1).x === 77, "松手提交后坐标保持", "x=" + NF.node(p1).x);
      const pyEl = document.querySelector("[data-act=py]");
      pyEl.value = "55";
      pyEl.dispatchEvent(new Event("input", { bubbles: true }));
      log(NF.node(p1).y === 55 && NF.node(p1).x === 77, "Y 轴同样实时生效", "(" + NF.node(p1).x + ", " + NF.node(p1).y + ")");
      pyEl.dispatchEvent(new Event("change", { bubbles: true }));
    }

    /* ---- 14. 连线权重实时生效 ---- */
    const q1 = NF.addNode(100, 0, 0), q2 = NF.addNode(120, 0, 0);
    const qe = NF.addEdge(q1, q2, 0.5);
    NF.select([], [qe]);
    await raf();
    const wEl = document.querySelector("[data-act=w]");
    const diag = "q1=" + q1 + " q2=" + q2 + " qe=" + qe + " n=" + NF.graph().n + " e=" + NF.graph().e +
                 " selEdges=" + NF.stats().selEdges + " live=" + JSON.stringify(NF.live()) +
                 " inspectorLen=" + document.getElementById("inspector").innerHTML.length +
                 " head=" + document.getElementById("inspector").textContent.slice(0, 40);
    log(!!wEl, "连线属性面板出现权重输入框", diag);
    if (wEl) {
      wEl.focus(); wEl.value = "1.25";
      wEl.dispatchEvent(new Event("input", { bubbles: true }));
      log(NF.edge(qe).w === 1.25, "拖动权重时实时生效", "w=" + NF.edge(qe).w);
      wEl.dispatchEvent(new Event("change", { bubbles: true }));
    }

    /* ---- 15. 演示网络的接口默认值 ---- */
    NF.clear();
    await raf();
    document.querySelector("[data-cmd=demo]").click();
    await raf();
    const dL = NF.ioLists();
    log(dL.ins.length === 3 && dL.outs.length === 2, "示例网络的接口数量正确",
        "输入接口 " + dL.ins.length + " / 输出接口 " + dL.outs.length);
    const dIr = NF.ir();
    log(!!dIr && dIr.orphanEdges === 0 && dIr.badDstEdges === 0, "示例网络 IR 完整",
        "N=" + (dIr && dIr.N) + " E=" + (dIr && dIr.E) + " 波次=" + (dIr && dIr.waves));
    out.push('SCALE-BEGIN');
    /* ---- 9. 规模：1 万神经元 ---- */
    document.getElementById('gen-n').value = '10000';
    document.getElementById('gen-l').value = '60';
    document.getElementById('gen-f').value = '4';
    document.getElementById('gen-go').click();
    await sleep(120);
    { const b = document.getElementById('nfask');
      if (b && getComputedStyle(b).display !== 'none') document.getElementById('nfask-yes').click(); }
    await sleep(900);
    await raf();
    const gs = NF.graph();
    log(gs.n >= 9000, '批量生成 1 万神经元', gs.n + ' 神经元 / ' + gs.e + ' 连接');
    let t0 = performance.now();
    NF.select([Math.floor(gs.n / 2)], []);
    const dtSel = performance.now() - t0;
    log(dtSel < 120, '选中并高亮出入边（1 万神经元）', dtSel.toFixed(2) + ' ms');
    const hlS = NF.highlight();
    const mid = Math.floor(gs.n / 2);
    const badS = hlS.filter(x => (x.in && NF.edge(x.e).dst !== mid) || (x.out && NF.edge(x.e).src !== mid)).length;
    log(badS === 0 && hlS.length > 0, '大图高亮分类仍正确', '错分 ' + badS + '，高亮 ' + hlS.length + ' 条');
    log(!!NF.stats().dim, '4 万连接仍在淡化阈值内', 'dim=' + NF.stats().dim + '（阈值 150000）');
    t0 = performance.now();
    let hits = 0;
    for (let k = 0; k < 400; k++) if (NF.pickEdgeAt(600 + (k % 40) * 10, 300 + ((k / 40) | 0) * 10) >= 0) hits++;
    const dtPick = (performance.now() - t0) / 400;
    log(dtPick < 15, '连线拾取单次耗时（4 万连接）', dtPick.toFixed(3) + ' ms，命中 ' + hits + '/400');

    /* ---- 10. 超阈值：应自动跳过淡化 ---- */
    document.getElementById('gen-n').value = '30000';
    document.getElementById('gen-l').value = '50';
    document.getElementById('gen-f').value = '8';
    document.getElementById('gen-go').click();
    await sleep(120);
    { const b = document.getElementById('nfask');
      if (b && getComputedStyle(b).display !== 'none') document.getElementById('nfask-yes').click(); }
    await sleep(1500);
    await raf();
    const gb = NF.graph();
    log(gb.e > 150000, '生成 15 万以上连接的压力图', gb.n + ' 神经元 / ' + gb.e + ' 连接');
    t0 = performance.now();
    NF.select([Math.floor(gb.n / 2)], []);
    const dtBig = performance.now() - t0;
    log(!NF.stats().dim, '超阈值自动跳过淡化', 'dim=' + NF.stats().dim);
    log(dtBig < 60, '超阈值大图选中耗时', dtBig.toFixed(2) + ' ms');
    log(NF.highlight().length >= 0, '超阈值大图高亮可用', NF.highlight().length + ' 条');
    out.push('SCALE-END');

    /* ---- 11. LOD：远看模糊、近看细节 ---- */
    NF.setLod('high');
    await raf();
    let ls = NF.lodState();
    log(ls.tier === 'high' && ls.cylinderVisible && !ls.lineVisible && !ls.pointVisible,
        '高细节：画完整圆柱连线', JSON.stringify(ls));
    log(ls.lineRange === gb.e * 2, '细线段层与连接数同步（每条 2 个顶点）',
        'drawRange=' + ls.lineRange + ' / 期望 ' + (gb.e * 2));
    NF.setLod('mid');
    await raf();
    ls = NF.lodState();
    log(ls.tier === 'mid' && !ls.cylinderVisible && ls.lineVisible && !ls.pointVisible,
        '中细节：换成细线段连线，圆柱层关掉', JSON.stringify(ls));
    NF.setLod('low');
    await raf();
    ls = NF.lodState();
    log(ls.tier === 'low' && !ls.cylinderVisible && !ls.lineVisible && ls.pointVisible && ls.farLineVisible,
        '简细节：换成抽样点云 + 抽样线段', JSON.stringify(ls));
    log(ls.clouds > 0 && ls.clouds <= 90000, '简档点数被预算卡住，与图规模解耦',
        ls.clouds + ' 点（预算 90000，图 ' + gb.n + ' 神经元）');
    log(ls.lines > 0 && ls.lines <= 200064, '简档线段数被预算卡住，与图规模解耦',
        ls.lines + ' 线（预算 200000，图 ' + gb.e + ' 连接）');
    log(NF.graph().n === gb.n && NF.graph().e === gb.e, '切换细节层次不影响数据本身',
        NF.graph().n + ' / ' + NF.graph().e);
    const tLow = performance.now();
    NF.setLod('low');                       /* 再切一次，测重建耗时 */
    const dtFar = performance.now() - tLow;
    log(dtFar < 900, '简档重建耗时（' + gb.n + ' 神经元 / ' + gb.e + ' 连接）', dtFar.toFixed(1) + ' ms');
    NF.setLod('auto');
    await raf();
    log(['high', 'mid', 'low'].indexOf(NF.lodState().tier) >= 0, '自动档按距离选出了合法档位',
        JSON.stringify(NF.lodState().tier));
    /* 回归：档位词写错一个（medium / simple）曾经会静默落进一个谁都不匹配的档位，
       三层可见性全判 false —— 连线整层消失，界面还看不出来。 */
    NF.setLod('medium');
    await raf();
    const lsAlias = NF.lodState();
    log(lsAlias.tier === 'mid' && lsAlias.lineVisible,
        '档位别名 medium 等价于 mid（不会再变成连线全关）',
        'tier=' + lsAlias.tier + ' lineVisible=' + lsAlias.lineVisible);
    NF.setLod('simple');
    await raf();
    log(NF.lodState().tier === 'low' && NF.lodState().pointVisible,
        '档位别名 simple 等价于 low', JSON.stringify(NF.lodState().tier));
    NF.setLod('实在不认识的档位名');
    await raf();
    log(['high', 'mid', 'low'].indexOf(NF.lodState().tier) >= 0,
        '认不出来的档位名兜底成合法档位', JSON.stringify(NF.lodState().tier));
    NF.setLod('auto');
    await raf();

    /* ---- 12. 关闭连接显示时各档都跟着关 ---- */
    const cbE = document.getElementById('v-edges');
    cbE.checked = false; cbE.dispatchEvent(new Event('change', { bubbles: true }));
    await raf();
    ls = NF.lodState();
    log(!ls.cylinderVisible && !ls.lineVisible && !ls.farLineVisible, '关掉「显示连接」后三档都不画连线', JSON.stringify(ls));
    cbE.checked = true; cbE.dispatchEvent(new Event('change', { bubbles: true }));
    await raf();
    NF.setLod('auto');

    /* ---- 13. 界面语言 ---- */
    log(NF.lang() === 'zh', '启动默认是中文界面');
    const tSel = document.getElementById('t-select');
    log(tSel.textContent.indexOf('选择') >= 0, '中文下按钮是中文', tSel.textContent.trim());
    NF.setLang('en');
    await raf();
    log(NF.lang() === 'en' && document.documentElement.lang === 'en', '切到英文后状态更新');
    log(tSel.textContent.indexOf('Select') >= 0, '按钮文案跟着切', JSON.stringify(tSel.textContent.trim()));
    log(document.querySelector('#v-wsize').parentNode.textContent.indexOf('connection strength') >= 0,
        '新增的视觉缩放开关翻了英文', document.querySelector('#v-wsize').parentNode.textContent.trim());
    log(document.querySelector('[data-i18n="h-bulk"]').textContent.indexOf('Quick fill') >= 0,
        '快捷铺设说明整句替换成英文', document.querySelector('[data-i18n="h-bulk"]').textContent.slice(0, 40) + '…');
    log(document.querySelector('[data-i18n="h-simlimit"]').textContent.indexOf('no limit') >= 0,
        '模拟激活波数上限的说明也翻了英文');
    const introEn = document.querySelector('[data-i18n="h-intro"]').textContent;
    log(introEn.indexOf('colour is enough') >= 0 && !/[一-鿿]/.test(introEn),
        '带行内标签的整句整体替换，不会翻出半截句子', introEn.slice(0, 48) + '…');
    log(document.querySelector('#left h3').textContent === 'Tool', '左栏标题切到英文',
        document.querySelector('#left h3').textContent);
    log(document.querySelector('option[value="low"]').textContent.indexOf('Low') >= 0, '下拉选项切到英文',
        document.querySelector('option[value="low"]').textContent);
    /* 动态生成的面板也要跟着切 */
    NF.select([0], []);
    await raf();
    const insEn = document.getElementById('inspector').textContent;
    log(insEn.indexOf('Neuron #') >= 0, '动态重建的属性面板切到英文', insEn.slice(0, 40) + '…');
    NF.setLang('zh');
    await raf();
    log(NF.lang() === 'zh' && document.documentElement.lang === 'zh-CN', '可以切回中文');
    log(tSel.textContent.indexOf('选择') >= 0, '切回中文后按钮复原', tSel.textContent.trim());
    log(document.querySelector('[data-i18n="h-intro"]').textContent.indexOf('不分类型') >= 0,
        '整句替换的元素也能复原');
    NF.select([], []);
    await raf();

    /* ==================== .nforge v3 分块容器 ==================== */
    const sortEdges = (arr) => arr.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
    const snap = () => {
      const g = NF.graph();
      const nodes = [], edges = [];
      for (let i = 0; i < g.n; i++) {
        const nd = NF.node(i);
        nodes.push([nd.x, nd.y, nd.z, nd.io, nd.act, nd.bias, nd.thr, nd.colOn,
                    nd.col[0], nd.col[1], nd.col[2], NF.nameOf(i)]);
      }
      for (let e = 0; e < g.e; e++) { const ed = NF.edge(e); edges.push([ed.src, ed.dst, ed.w]); }
      return { n: g.n, e: g.e, name: g.name, nodes, edges: sortEdges(edges) };
    };
    const diff = (a, b, tol) => {
      if (a.n !== b.n || a.e !== b.e) return '规模不一致 ' + a.n + '/' + a.e + ' vs ' + b.n + '/' + b.e;
      if (a.name !== b.name) return '工程名不一致';
      for (let i = 0; i < a.n; i++) {
        const x = a.nodes[i], y = b.nodes[i];
        for (let k = 0; k < x.length; k++) {
          if (typeof x[k] === 'string') { if (x[k] !== y[k]) return '节点 ' + i + ' 名称 ' + x[k] + ' != ' + y[k]; continue; }
          if (!(Math.abs(x[k] - y[k]) <= tol)) return '节点 ' + i + ' 字段 ' + k + ' 差 ' + Math.abs(x[k] - y[k]);
        }
      }
      for (let e = 0; e < a.e; e++) {
        const x = a.edges[e], y = b.edges[e];
        if (x[0] !== y[0] || x[1] !== y[1] || !(Math.abs(x[2] - y[2]) <= tol)) return '边 ' + e + ' 不一致';
      }
      return '';
    };

    /* 搭一张字段齐全的小图：位置 / 权重 / 阈值 / 偏置 / 颜色 / 名称 / 接口 / 冻结 */
    NF.clear();
    const tids = [];
    for (let k = 0; k < 6; k++) {
      for (let j = 0; j < 8; j++) {
        tids.push(NF.addNode(k * 20 - 50, j * 12 - 42, ((k * 8 + j) % 5) * 7 - 14));
      }
    }
    let neBuilt = 0;
    for (let k = 0; k + 1 < 6; k++) {
      for (let j = 0; j < 8; j++) {
        const s0 = tids[k * 8 + j], d0 = tids[(k + 1) * 8 + ((j * 3 + 1) % 8)];
        if (NF.addEdge(s0, d0, (j % 3 === 0 ? -1 : 1) * (0.125 * (j + 1))) >= 0) neBuilt++;
      }
    }
    NF.setIO(tids.slice(0, 8), 1);
    NF.setIO(tids.slice(40, 48), 2);
    NF.setIO([tids[9]], 3);
    NF.setColor(tids.slice(9, 20), '#ff8800');
    NF.setThr(tids.slice(4, 12), 1.75);
    NF.setBias(tids, -0.375);
    NF.setLock(tids.slice(0, 3), 1);
    NF.setEdgeLock([0, 2, 5], 1);
    NF.setName(tids[5], '入口-5');
    NF.setName(tids[17], 'middle/x');
    const A = snap();
    log(A.n === 48 && A.e === neBuilt, '构造出字段齐全的测试图（48 神经元）', A.n + ' 神经元 / ' + A.e + ' 连接');

    log(NF.canZip(), '块体压缩可用（CompressionStream）', NF.canZip() ? 'deflate' : '不可用，退回未压缩');
    const buf = await NF.encodeV3();
    log(NF.detectFile(buf), '编码结果带 NFORGE3 文件头');
    const idx = NF.inspectFile(buf);
    log(idx.version === 3 && idx.format === 'neuroforge-project', '文件头里的版本是 3', 'v' + idx.version);
    log(idx.counts.neurons === A.n && idx.counts.edges === A.e, '索引表的规模跟图一致',
        idx.counts.neurons + ' 神经元 / ' + idx.counts.edges + ' 连接');

    /* 导出入口：浏览器里必须走「逐个下载」，桌面壳里才走「先问一次文件夹」 */
    log(typeof NF.exportFiles === 'function', '导出入口在（编译对话框的「下载」走它）', typeof NF.exportFiles);
    log(NF.inShell() === !!window.__TAURI__, 'inShell() 跟真实环境一致（同一份自测在浏览器和桌面壳里都能跑）', 'inShell=' + NF.inShell() + ' __TAURI__=' + !!window.__TAURI__);

    /* 索引表必须严丝合缝：区间首尾相接、无缺口、正好覆盖全图 */
    let contiguous = true, prevN = 0, prevE = 0, nCov = 0, eCov = 0;
    for (const c of idx.chunks) {
      if (c.n0 !== prevN || c.e0 !== prevE) contiguous = false;
      nCov += c.n1 - c.n0; eCov += c.e1 - c.e0;
      prevN = c.n1; prevE = c.e1;
    }
    log(contiguous && prevN === A.n && prevE === A.e, '块的区间首尾相接、正好覆盖全图',
        idx.chunks.length + ' 块，覆盖 ' + nCov + ' 神经元 / ' + eCov + ' 连接');

    /* 包围盒必须真的框住这一段神经元 */
    let badBB = 0;
    for (const c of idx.chunks) {
      const bb = c.bbox;
      for (let i = c.n0; i < c.n1; i++) {
        const nd = NF.node(i);
        if (nd.x < bb[0] - 1e-3 || nd.x > bb[3] + 1e-3 || nd.y < bb[1] - 1e-3 ||
            nd.y > bb[4] + 1e-3 || nd.z < bb[2] - 1e-3 || nd.z > bb[5] + 1e-3) badBB++;
      }
    }
    log(badBB === 0, '每块的包围盒都框住了自己那段神经元', badBB + ' 个越界');
    let bodyBytes = 0;
    for (const c of idx.chunks) bodyBytes += c.len;
    log(bodyBytes < buf.length && bodyBytes > 0, '块体字节数小于文件总长（前面是文件头）',
        bodyBytes + ' / ' + buf.length);
    log(buf.length < JSON.stringify(NF.serializeV2()).length,
        'v3 容器比同图的 v2 JSON 小', buf.length + ' B vs ' + JSON.stringify(NF.serializeV2()).length + ' B');

    /* 全量读回来：f32 存 f32，不该有任何精度损失 */
    const r1 = await NF.loadBuffer(buf);
    log(r1.n === A.n && r1.e === A.e, '全量载入的规模一致', r1.n + ' / ' + r1.e);
    const d1 = diff(A, snap(), 1e-9);
    log(d1 === '', 'v3 全量往返：位置/权重/阈值/偏置/颜色/接口/冻结/名称逐字段一致', d1);

    /* 分块：把每块做小，验证"只载入一部分" */
    const buf2 = await NF.encodeV3({ chunkNeurons: 8 });
    const idx2 = NF.inspectFile(buf2);
    log(idx2.chunks.length === 6, 'chunkNeurons=8 时正好切成 6 块', idx2.chunks.length + ' 块');
    /* 第 1 块的出边落在第 2 块里，第 2 块的出边落在没载入的第 3 块里：
       一次就能同时验证"块内连接保留"和"跨块连接丢弃" */
    const want = [1, 2];
    let expN = 0, expE = 0;
    for (const k of want) { const c = idx2.chunks[k]; expN += c.n1 - c.n0; expE += c.e1 - c.e0; }
    const rp = await NF.loadBuffer(buf2, want);
    log(rp.n === expN, '部分载入只拿到选中块的神经元', rp.n + ' / 期望 ' + expN);
    log(rp.e + rp.dropped === expE, '部分载入：留下的连接 + 跨块丢弃 = 选中块的边',
        rp.e + ' + ' + rp.dropped + ' = ' + expE);
    log(rp.e > 0, '部分载入确实留下了块内连接', rp.e + ' 条');
    log(rp.dropped > 0, '跨块连接被丢弃并计数（没有假装完整）', rp.dropped + ' 条');
    let dangling = 0;
    const gg = NF.graph();
    for (let e = 0; e < gg.e; e++) { const ed = NF.edge(e); if (ed.src >= gg.n || ed.dst >= gg.n) dangling++; }
    log(dangling === 0, '部分载入后没有指向不存在神经元的悬空连接', dangling + ' 条');
    const nd0 = NF.node(0), nd8 = NF.node(8);
    log(Math.abs(nd0.x - A.nodes[8][0]) < 1e-6 && Math.abs(nd0.y - A.nodes[8][1]) < 1e-6 &&
        Math.abs(nd0.z - A.nodes[8][2]) < 1e-6,
        '重排后第 0 个神经元 == 原第 8 个（第 1 块的首个）');
    log(Math.abs(nd8.x - A.nodes[16][0]) < 1e-6, '重排后第 8 个神经元 == 原第 16 个（第 2 块的首个）');
    log(NF.nameOf(0) === '' && NF.nameOf(1) === '', '被丢掉的块里的名称没有串到别的神经元上');

    /* 旧版 JSON 与 v3 承载同一份数据（v2 把浮点截到三位小数）
       先把完整图读回来，否则下面拿到的是刚载入的那两块 */
    await NF.loadBuffer(buf);
    const doc = NF.serializeV2();
    NF.clear();
    NF.loadV2(doc);
    const d2 = diff(A, snap(), 1e-3);
    log(d2 === '', 'v2 JSON 往返：字段一致（三位小数容差）', d2);

    /* 坏文件必须明确报错，而不是静默载入半张图 */
    /* 注意：对话存档那一区接在文件最末尾，剪掉几十个字节只会剪到它——那种情况图本身是完好的，
       软件会照常载入并在对话里留一句「对话没读回来，文件可能被截断」（那头在 sesscheck 里验）。
       这里要验的是「数据区被剪掉必须报错」，所以剪掉半份文件。 */
    let threwTrunc = false;
    try { await NF.loadBuffer(buf.slice(0, Math.floor(buf.length / 2))); }
    catch (err) { threwTrunc = true; }
    log(threwTrunc, '被截断的 v3 文件会明确报错，不会静默载入半张图');
    let threwMagic = false;
    const badBuf = buf.slice(); badBuf[2] = 0;
    try { NF.inspectFile(badBuf); } catch (err) { threwMagic = true; }
    log(threwMagic, '文件头被改坏时会报错');

    NF.clear();
    const eBuf = await NF.encodeV3();
    const eRes = await NF.loadBuffer(eBuf);
    log(eRes.n === 0 && eRes.e === 0, '空工程也能完整往返', eRes.n + ' / ' + eRes.e);

    /* 带权重块的文件，载入到一个比它小的工程里。
       块里的两端 id 是文件里的新编号，所以建块时用的 G.n 必须是新图的大小；
       顺序反了就会被误判成「块起点 id 越界」——这是真踩过的坑。 */
    NF.clear();
    NF.addNode(0, 0, 0); NF.addNode(20, 0, 0); NF.addNode(40, 0, 0);
    NF.addBlock([0, 1], [1, 2], [1.5, -0.25, 0.75, 2.0]);
    const blkBuf = await NF.encodeV3();
    NF.clear();                        /* 目标工程比文件小 */
    let lres = null, blkErr = '';
    try { lres = await NF.loadBuffer(blkBuf); } catch (err) { blkErr = String(err.message || err); }
    log(!!lres && lres.n === 3 && lres.e === 0 && lres.blocks === 1,
        '带权重块的文件能载入到更小的工程里（不会误判块 id 越界）',
        blkErr || (lres.n + ' 神经元 / ' + lres.blocks + ' 块'));
    log(!!lres && NF.blocksInfo().length === 1 && NF.blocksInfo()[0].k === 2 && NF.blocksInfo()[0].n === 2,
        '载入后块本身是对的（2x2）',
        JSON.stringify(NF.blocksInfo()));

    /* ---- 14. 视觉缩放：按权重看粗细 / 按强度看大小 ---- */
    NF.clear();
    await raf();
    const sv0 = NF.addNode(0, 0, 0), sv1 = NF.addNode(10, 0, 0), sv2 = NF.addNode(20, 0, 0);
    const sv3 = NF.addNode(30, 0, 0), sv4 = NF.addNode(40, 0, 0);
    const sA = NF.addEdge(sv0, sv1, 0.1), sB = NF.addEdge(sv0, sv2, 0.1), sC = NF.addEdge(sv0, sv3, 0.1);
    const sD = NF.addEdge(sv1, sv3, 5.0);
    const rBefore = NF.radiusOf(sv1), wBefore = NF.edgeWidthOf(sA);
    const vs = NF.viewScale({ size: true, width: true });
    await raf();
    log(vs.size && vs.width, '两个视觉缩放开关都能打开', JSON.stringify(vs).slice(0, 60));
    log(NF.radiusOf(sv1) > NF.radiusOf(sv4) + 1e-6, '按强度看大小：连接多的更大，孤立的仍然最小',
        'r(' + NF.radiusOf(sv1).toFixed(2) + ') > r(' + NF.radiusOf(sv4).toFixed(2) + ')');
    log(NF.strengthOf(sv1) > NF.strengthOf(sv2) && NF.strengthOf(sv4) === 0,
        '强度 = 连接数一半 + 权重和一半，孤立点是 0',
        NF.strengthOf(sv1).toFixed(3) + ' / ' + NF.strengthOf(sv2).toFixed(3) + ' / ' + NF.strengthOf(sv4).toFixed(3));
    log(NF.edgeWidthOf(sD) > NF.edgeWidthOf(sA), '按权重看粗细：权重大的连线明显更粗',
        'w=5 -> ' + NF.edgeWidthOf(sD).toFixed(3) + ' ; w=0.1 -> ' + NF.edgeWidthOf(sA).toFixed(3));
    log(NF.edgeWidthOf(sD) / NF.edgeWidthOf(sA) > 2, '粗细差别是量级上的，不是只差一点点',
        (NF.edgeWidthOf(sD) / NF.edgeWidthOf(sA)).toFixed(2) + ' 倍');
    log(NF.debugScene().nBadScale === 0, '实例缓冲里的半径真的跟着强度变了（不是只有查询接口变了）',
        'nBadScale=' + NF.debugScene().nBadScale);
    log(NF.debugScene().nBadPos === 0, '放大缩小不影响位置');
    NF.viewScale({ size: false, width: false });
    await raf();
    log(Math.abs(NF.radiusOf(sv1) - rBefore) < 1e-9 && Math.abs(NF.edgeWidthOf(sA) - wBefore) < 1e-9,
        '关掉开关后半径与粗细逐位回到默认值',
        NF.radiusOf(sv1).toFixed(4) + ' / ' + NF.edgeWidthOf(sA).toFixed(4));
    log(NF.debugScene().nBadScale === 0, '关掉后实例缓冲同样是一致的');

    /* ---- 14b. 对比度滑杆：强度 / 权重挨得近时，调大就能分开 ---- */
    NF.clear();
    await raf();
    const chub = NF.addNode(0, 0, 0);
    const cleaf = [];
    for (let i = 0; i < 20; i++) cleaf.push(NF.addNode(0, (i + 1) * 10, 0));
    for (let i = 0; i < 20; i++) NF.addEdge(chub, cleaf[i], 1.0 + i * 0.01);
    NF.addEdge(cleaf[0], cleaf[1], 30);
    NF.viewScale({ size: true, width: true, sizeGain: 1, widthGain: 1 });
    await raf();
    const sizeGap = (g) => { NF.viewScale({ sizeGain: g }); return NF.radiusOf(cleaf[19]) - NF.radiusOf(cleaf[2]); };
    const widthGap = (g) => { NF.viewScale({ widthGain: g }); return NF.edgeWidthOf(19) - NF.edgeWidthOf(0); };
    const sg1 = sizeGap(1), sg8 = sizeGap(8), sgHalf = sizeGap(0.5);
    log(sg8 > sg1 * 3, '强度差不多的神经元：对比度调大后大小真的分开了（这是"看不出区别"的主因）',
        '半径差 ' + sg1.toFixed(4) + ' -> ' + sg8.toFixed(4));
    log(sgHalf < sg1 * 0.6, '对比度调到 0.5 倍，差距也跟着缩小（两头都管得住）',
        '半径差 ' + sg1.toFixed(4) + ' -> ' + sgHalf.toFixed(4));
    /* 两端钉住：倍数拉到最大，半径也必须严格随强度递增——不能被夹成一个常数
       （线性放大就会：中位数以下全部夹到同一个最小值，等于把"看不出区别"挪到下半区） */
    NF.viewScale({ sizeGain: 8 });
    /* cleaf[1] 是那条 30 权重边的终点（最强），所以从 2 开始取 */
    const mono = [2, 5, 10, 19].map((k) => NF.radiusOf(cleaf[k]));
    let inc = true;
    for (let k = 1; k < mono.length; k++) if (!(mono[k] > mono[k - 1] + 1e-9)) inc = false;
    log(inc, '对比度拉到 8 倍，半径仍然严格随强度递增（没被夹成一堆相同的最小值）',
        mono.map((v) => v.toFixed(4)).join(' < '));
    const wg1 = widthGap(1), wg8 = widthGap(8), wgHalf = widthGap(0.5);
    log(wg8 > wg1 * 3, '权重差不多的连线：对比度调大后粗细也分得开',
        '粗细差 ' + wg1.toFixed(4) + ' -> ' + wg8.toFixed(4));
    log(wgHalf < wg1 * 0.6, '粗细对比度调到 0.5 倍，差距缩小到一半',
        '粗细差 ' + wg1.toFixed(4) + ' -> ' + wgHalf.toFixed(4));
    log(NF.debugScene().nBadScale === 0, '调完对比度，实例缓冲里的半径是一致的');
    /* 滑杆走界面：拖（input）就当场生效，不用松手；关掉开关时是灰的 */
    const sgEl = document.getElementById('v-sgain');
    NF.viewScale({ sizeGain: 1 });
    const r19Before = NF.radiusOf(cleaf[19]);
    sgEl.value = '4';
    sgEl.dispatchEvent(new Event('input', { bubbles: true }));
    await raf();
    log(NF.viewScale().sizeGain === 4 && NF.radiusOf(cleaf[19]) > r19Before + 1e-6,
        '拖「大小对比度」滑杆当场见效（不用先松手）',
        '×' + NF.viewScale().sizeGain.toFixed(1) + '，r=' + NF.radiusOf(cleaf[19]).toFixed(2));
    log(NF.debugScene().nBadScale === 0, '拖滑杆时写进实例缓冲的半径也对得上');
    const sBox = document.getElementById('v-wsize');
    sBox.checked = false;
    sBox.dispatchEvent(new Event('change', { bubbles: true }));
    await raf();
    log(document.getElementById('r-wsize').classList.contains('off') && sgEl.disabled,
        '关掉开关后滑杆变灰、拖不动（免得拖了没反应）');
    NF.viewScale({ size: false, width: false, sizeGain: 1, widthGain: 1 });
    await raf();

    /* ---- 14c. 默认一样大 + 作用范围 + "画面上真的变了" ----
       这一节盯住三个踩过的坑：
         1. 接口神经元以前固定按 ×1.41 画，两个开关都关着也大小不一；
         2. 开关翻过去以后实例数据写进了 CPU 数组却没标脏上传，画面冻在旧数据上，
            看起来就是"只有鼠标碰过的那个神经元才变大小"；
         3. 有框选时开关应该只作用于选中的那些，没框选才作用于全部。 */
    NF.clear();
    await raf();
    const dv0 = NF.addNode(-70, -50, 0), dv1 = NF.addNode(-40, -50, 0);
    const dvhub = NF.addNode(40, 0, 0);
    const dvleaf = [];
    for (let i = 0; i < 8; i++) dvleaf.push(NF.addNode(60 + i * 12, 40, 0));
    for (let i = 0; i < 8; i++) NF.addEdge(dvhub, dvleaf[i], 1.0 + i * 0.08);
    NF.setIO([dv0], 1); NF.setIO([dv1], 2);
    NF.select([], []);
    await raf();
    let dvMin = Infinity, dvMax = 0;
    for (let i = 0; i < NF.graph().n; i++) { const r = NF.radiusOf(i); if (r < dvMin) dvMin = r; if (r > dvMax) dvMax = r; }
    log(dvMax === dvMin, '默认所有神经元一样大（接口也只靠颜色区分，不再偷偷画大）', dvMin + ' ~ ' + dvMax);
    log(NF.renderColor(dv0) !== NF.renderColor(dv1), '输入 / 输出接口的颜色确实不一样',
        NF.renderColor(dv0) + ' / ' + NF.renderColor(dv1));
    /* 亮度像素数：整张图的"墨水量"，用来判断画面是不是真的重画过 */
    const inkOf = (buf) => { let n = 0; for (let i = 0; i < buf.length; i += 4) if (buf[i] + buf[i + 1] + buf[i + 2] > 90) n++; return n; };

    const pxOff = NF.grabFrame();
    NF.viewScale({ size: true, width: true });
    await raf();
    const rHubAll = NF.radiusOf(dvhub), rLeafAll = NF.radiusOf(dvleaf[0]);
    log(rHubAll > NF.radiusOf(dv0) + 1e-6, '不框选：开关作用于全部（枢纽变大、孤立点变小）',
        'r ' + rHubAll.toFixed(3) + ' / ' + NF.radiusOf(dv0).toFixed(3));
    log(NF.edgeWidthOf(0) < 0.09 && NF.edgeWidthOf(7) > 0.2, '不框选：所有连线粗细一起按权重排开',
        NF.edgeWidthOf(0).toFixed(3) + ' ~ ' + NF.edgeWidthOf(7).toFixed(3));
    const pxOn = NF.grabFrame();
    log(NF.pixelDiff(pxOff, pxOn) > 100, '开了开关画面当场就变——一个神经元都不用去碰（这是以前坏掉的那条）',
        '像素差 ' + NF.pixelDiff(pxOn, pxOff));

    /* 框选三个叶子：只有它们按强度，其余回到默认大小 */
    NF.select([dvleaf[0], dvleaf[1], dvleaf[2]], []);
    await raf();
    log(NF.radiusOf(dvhub) === 1.45 && NF.radiusOf(dv0) === 1.45,
        '框选后：没被框选的神经元回到默认大小', NF.radiusOf(dvhub).toFixed(3) + ' / ' + NF.radiusOf(dv0).toFixed(3));
    log(Math.abs(NF.radiusOf(dvleaf[0]) - rLeafAll) < 1e-9, '框选后：被框选的神经元保持按强度的大小',
        NF.radiusOf(dvleaf[0]).toFixed(3));
    NF.select([], []);
    await raf();
    log(NF.radiusOf(dvhub) === rHubAll, '取消框选：作用范围自动回到全部', NF.radiusOf(dvhub).toFixed(3));

    /* 粗细同理：框选两条，只有这两条走「按权重」，其余回到默认公式 */
    NF.select([], [0, 1]);
    await raf();
    const def5 = 0.055 + Math.min(Math.abs(NF.edge(5).w), 4) * 0.045;
    log(Math.abs(NF.edgeWidthOf(5) - def5) < 1e-9 && Math.abs(NF.edgeWidthOf(0) - 0.045) < 1e-9,
        '框选连线后：只有被选中的连线按权重（其余回到默认粗细）',
        '选中 ' + NF.edgeWidthOf(0).toFixed(3) + '，未选中 ' + NF.edgeWidthOf(5).toFixed(3) + '（默认 ' + def5.toFixed(3) + '）');

    /* 只框神经元、一条连线都没框：粗细仍旧按全图排开（粗细只认"框选的连线"） */
    NF.select([dvhub, dvleaf[0], dvleaf[1]], []);
    await raf();
    log(NF.edgeWidthOf(0) < 0.09 && Math.abs(NF.edgeWidthOf(5) - def5) > 1e-9,
        '只框神经元、没框连线时：粗细仍旧按全图排开',
        '权重最小那条 ' + NF.edgeWidthOf(0).toFixed(3) + '，第 5 条 ' + NF.edgeWidthOf(5).toFixed(3) +
        '（回到默认会是 ' + def5.toFixed(3) + '）');
    NF.select([dvhub, dvleaf[0], dvleaf[1]], [0]);

    /* 关键回归：写进实例缓冲的数据必须真的上屏。
       判据是"增量改完的画面"和"从头重建一遍的画面"完全一致——
       只要有一次上传漏了，两边的亮像素数就对不上。 */
    const ink1 = inkOf(NF.grabFrame());
    NF.rebuild();
    await raf();
    const ink2 = inkOf(NF.grabFrame());
    log(Math.abs(ink1 - ink2) <= Math.max(4, ink2 * 0.01),
        '增量更新后的画面 == 从头重建的画面（实例数据真的传到了 GPU）', ink1 + ' vs ' + ink2);
    log(NF.debugScene().nBadScale === 0, '实例缓冲里的半径与查询接口逐位一致');

    /* 简档（远看）下点云的点也要能按强度分大小 */
    NF.select([], []);
    NF.viewScale({ size: false, width: false });   /* 先关掉，下面才好比较"开 / 关" */
    await raf();
    NF.setLod('low');
    await sleep(300); await raf();
    const lowOff = NF.grabFrame();
    NF.viewScale({ size: true });
    await raf(); await sleep(200);
    const lowOn = NF.grabFrame();
    log(NF.lodState().tier === 'low' && NF.pixelDiff(lowOff, lowOn) > 5,
        '简档（远看）下，点云的点也按连接强度分大小', '像素差 ' + NF.pixelDiff(lowOn, lowOff));
    NF.setLod('auto');
    NF.viewScale({ size: false, width: false, sizeGain: 1, widthGain: 1 });
    await raf();
    log(NF.pixelDiff(pxOff, NF.grabFrame()) < 8, '关掉开关 + 取消框选：画面逐像素回到默认',
        '像素差 ' + NF.pixelDiff(pxOff, NF.grabFrame()));

    /* ---- 14d. 框选连线：不点单条，一次框一片 ----
       盯住的坑：框选以前只遍历神经元，连线一条都框不到，只能用鼠标一条条点。
       对账用的是独立的「按像素采样」判据（主程序走 Liang-Barsky 参数裁剪，两套算法不同源）。 */
    NF.clear();
    await raf();
    const mNodes = [];
    for (let mr = 0; mr < 6; mr++) for (let mc = 0; mc < 6; mc++) mNodes.push(NF.addNode((mc - 2.5) * 45, (mr - 2.5) * 45, 0));
    let mE = 0;
    for (let mk = 0; mk < 240; mk++) {
      const a = (mk * 7) % mNodes.length, b = (mk * 13 + 5) % mNodes.length;
      if (a !== b && NF.addEdge(mNodes[a], mNodes[b], (mk % 9) * 0.3 - 1.2) >= 0) mE++;
    }
    await raf();
    log(mE > 20, '先搭一张够密的测试图', NF.graph().n + ' 神经元 / ' + mE + ' 连接');

    const mrc = document.querySelector('canvas').getBoundingClientRect();
    const mrx0 = mrc.left + mrc.width * 0.38, mrx1 = mrc.left + mrc.width * 0.62;
    const mry0 = mrc.top + mrc.height * 0.38, mry1 = mrc.top + mrc.height * 0.62;
    /* 一小（正中）一大（几乎整屏）两个框：小框里一个神经元都没有，
       所以「只框连线不碰神经元」这件事在小框上才测得干净；大框里两样都有。 */
    const mFull = { x0: mrc.left + mrc.width * 0.1, x1: mrc.left + mrc.width * 0.9,
                    y0: mrc.top + mrc.height * 0.1, y1: mrc.top + mrc.height * 0.9 };
    const inBox = (x, y, pad) => x >= mrx0 - pad && x <= mrx1 + pad && y >= mry0 - pad && y <= mry1 + pad;
    const sampleHit = (a, b, pad) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const steps = Math.max(2, Math.ceil(Math.sqrt(dx * dx + dy * dy)));
      for (let k = 0; k <= steps; k++) { const t = k / steps; if (inBox(a.x + dx * t, a.y + dy * t, pad)) return true; }
      return false;
    };
    const mSegs = [];
    for (let e = 0; e < NF.graph().e; e++) { const eo = NF.edge(e); mSegs.push([NF.screenOf(eo.src), NF.screenOf(eo.dst)]); }

    NF.select([], []);
    await raf();
    const mGot = NF.marquee(mrx0, mry0, mrx1, mry1, { what: 'edges' });
    await raf();
    log(mGot.e > 0 && NF.stats().selEdges === mGot.e, '空白处拖拽就能框到连线（Alt+拖拽 = 只框连线）',
        '框到 ' + mGot.e + ' 条 / 图上 ' + NF.graph().e + ' 条');
    log(mGot.n === 0 && NF.stats().selNodes === 0, '只框连线时一个神经元都不选', 'selNodes=' + NF.stats().selNodes);

    const mSel = new Set(NF.selectedEdges());
    let mCmp = 0, mBad = 0, mCross = 0, mCrossHit = 0;
    for (let e = 0; e < mSegs.length; e++) {
      const a = mSegs[e][0], b = mSegs[e][1];
      if (!a.visible || !b.visible) continue;
      const hit = sampleHit(a, b, 0), near = sampleHit(a, b, 1.5);
      if (hit !== near) continue;   /* 贴着框边、两种判据本来就可能不一致的样本不参与对账 */
      mCmp++;
      if (hit !== mSel.has(e)) mBad++;
      if (hit && !inBox(a.x, a.y, 0) && !inBox(b.x, b.y, 0)) { mCross++; if (mSel.has(e)) mCrossHit++; }
    }
    log(mCmp > 0 && mBad === 0, '命中集合跟独立采样判据逐条一致', mCmp + ' 条可判定，对不上 ' + mBad + ' 条');
    log(mCross > 0 && mCrossHit === mCross, '两端都在框外、却从框里横穿过去的长连接也被框到（只判端点会全漏）',
        mCross + ' 条横穿的，框到 ' + mCrossHit + ' 条');

    let mOut = -1;
    for (let e = 0; e < NF.graph().e; e++) if (!mSel.has(e)) { mOut = e; break; }
    const mAllE = [];
    for (let e = 0; e < NF.graph().e; e++) mAllE.push(e);
    NF.select([], mAllE);
    await raf();
    NF.marquee(mrx0, mry0, mrx1, mry1, { what: 'edges' });
    await raf();
    log(NF.stats().selEdges === mGot.e, '不按 Shift 的框选是「替换」：上一次的连线选择被清掉',
        '全选 ' + mAllE.length + ' 条 -> 框选后 ' + NF.stats().selEdges + ' 条');
    NF.select([], mOut >= 0 ? [mOut] : []);
    await raf();
    const mAdd = NF.marquee(mrx0, mry0, mrx1, mry1, { what: 'edges', additive: true });
    await raf();
    log(mOut >= 0 && NF.stats().selEdges === mAdd.e + 1, 'Shift+框选是叠加：新命中的并进已有选择，重复的不算两遍',
        '已有 1 条 + 本次命中 ' + mAdd.e + ' 条 = ' + NF.stats().selEdges + ' 条');

    NF.select([3, 4], []);
    await raf();
    NF.marquee(mrx0, mry0, mrx1, mry1, { what: 'edges' });
    await raf();
    log(NF.stats().selNodes === 2 && NF.stats().selEdges === mGot.e, '只框连线不会动已有的神经元选择',
        'selNodes=' + NF.stats().selNodes + ' selEdges=' + NF.stats().selEdges);

    let mWantN = 0;
    for (let i = 0; i < NF.graph().n; i++) {
      const p = NF.screenOf(i);
      if (p.visible && p.x >= mFull.x0 && p.x <= mFull.x1 && p.y >= mFull.y0 && p.y <= mFull.y1) mWantN++;
    }
    log(mWantN > 0 && mWantN < NF.graph().n, '整块大框里确实有神经元（不然下一条等于没测）', mWantN + ' 个');
    NF.marquee(mFull.x0, mFull.y0, mFull.x1, mFull.y1, { what: 'nodes' });
    await raf();
    log(NF.stats().selEdges === mGot.e && NF.stats().selNodes === mWantN, '只框神经元也不会动已有的连线选择',
        'selNodes=' + NF.stats().selNodes + '（框里 ' + mWantN + ' 个）、selEdges 仍是 ' + NF.stats().selEdges);

    NF.select([], []);
    await raf();
    const mBoth = NF.marquee(mFull.x0, mFull.y0, mFull.x1, mFull.y1);
    await raf();
    log(mBoth.n === mWantN && mBoth.e > 0 && NF.stats().selNodes === mBoth.n && NF.stats().selEdges === mBoth.e,
        '默认框选：神经元和连线一起选中', mBoth.n + ' 神经元 + ' + mBoth.e + ' 条连线');

    /* 真的走一遍鼠标：Alt+点击 = 只选一条连线。这条路径在 pointerdown/pointerup 里，
       NF.marquee 覆盖不到，所以直接派发 PointerEvent。挑一条「中点离所有神经元最远」的边，
       免得普通点击被神经元截胡。 */
    const mcv = document.querySelector('canvas');
    let mClickE = -1, mClickPt = null, mClickNear = -1;
    for (let e = 0; e < NF.graph().e; e++) {
      const eo = NF.edge(e); const a = NF.screenOf(eo.src), b = NF.screenOf(eo.dst);
      if (!a.visible || !b.visible) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      let near = 1e9;
      for (let i = 0; i < NF.graph().n; i++) {
        const p = NF.screenOf(i);
        if (!p.visible) continue;
        const d = Math.sqrt((p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my));
        if (d < near) near = d;
      }
      if (near > mClickNear) { mClickNear = near; mClickE = e; mClickPt = { x: mx, y: my }; }
    }
    const press = (x, y, opts) => {
      const o = Object.assign({ bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }, opts || {});
      mcv.dispatchEvent(new PointerEvent('pointerdown', o));
      mcv.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { buttons: 0 })));
    };
    log(mClickPt && mClickNear > 10, '找到一条中点远离所有神经元的连线用来点', '中点离最近神经元 ' + mClickNear.toFixed(1) + ' px');
    NF.select([], []);
    await raf();
    press(mClickPt.x, mClickPt.y, { altKey: true });
    await raf();
    const mOne = NF.selectedEdges();
    log(mOne.length === 1 && NF.stats().selNodes === 0, 'Alt+点击一条连线：只选中这一条（一个神经元都不选）',
        '选中 ' + JSON.stringify(mOne));
    if (mOne.length === 1) {
      const eo = NF.edge(mOne[0]); const a = NF.screenOf(eo.src), b = NF.screenOf(eo.dst);
      const d = seg(mClickPt.x, mClickPt.y, a.x, a.y, b.x, b.y);
      log(d <= 7.0001, '选中的确实是鼠标底下那条（7px 容差内）', '离点击点 ' + d.toFixed(2) + ' px');
    }
    NF.select([], []);
    await raf();
    press(mClickPt.x, mClickPt.y, {});
    await raf();
    log(NF.selectedEdges().length === 1, '普通点击连线照旧是选一条（没被 Alt 那套带坏）',
        '选中 ' + NF.selectedEdges().length + ' 条');

    /* ---- 15. 快捷铺设：一列 / 一面 / 一方 ---- */
    NF.clear();
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, colOn: false, blink: false });
    const bulkBase = NF.graph().n;
    const bCount = NF.bulkPlace(4, 3, 2);
    await raf();
    log(bCount === 24 && NF.graph().n === bulkBase + 24, '铺一方 = 数量 X × 数量 Y × 数量 Z 个',
        bCount + ' 个，图里 ' + NF.graph().n);
    const bAt = (a, b, c) => { const nd = NF.node(bulkBase + ((c * 3 + b) * 4 + a)); return [nd.x, nd.y, nd.z]; };
    log(JSON.stringify(bAt(0, 0, 0)) === '[0,0,0]' && JSON.stringify(bAt(3, 2, 1)) === '[30,20,10]',
        '整片坐标严格按「步进单位」张开', JSON.stringify(bAt(0, 0, 0)) + ' … ' + JSON.stringify(bAt(3, 2, 1)));
    log(NF.placement().x === 40, '铺完原点顺移到这一片之后，不会和下一片重叠', 'x=' + NF.placement().x);
    NF.clear();
    NF.setPlacement({ x: 5, y: 5, z: 5, step: 2, colOn: false, blink: false });
    log(NF.bulkPlace(3, 1, 1) === 3 && NF.node(2).x === 9 && NF.node(2).y === 5,
        '铺一列：沿 X 轴等距排开', NF.node(0).x + ',' + NF.node(1).x + ',' + NF.node(2).x);
    NF.clear();
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 5, colOn: false, blink: false });
    log(NF.bulkPlace(2, 3, 1) === 6 && NF.node(5).y === 10 && NF.node(5).x === 5,
        '铺一面：X × Y 一张平面', NF.graph().n + ' 个');
    NF.clear();
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, colOn: false, blink: true });
    NF.bulkPlace(4, 1, 1);
    let forwardChain = NF.graph().n === 4 && NF.graph().e === 3;
    for (let e = 0; e < NF.graph().e; e++) { const ed = NF.edge(e); if (ed.src >= ed.dst) forwardChain = false; }
    log(forwardChain, '勾了「连成链」就沿格子顺序连出一条 DAG 链',
        NF.graph().n + ' 神经元 / ' + NF.graph().e + ' 连接');
    NF.clear();
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, colOn: false, blink: false });
    log(NF.bulkPlace(3000, 3000, 3) === 0 && NF.graph().n === 0,
        '一片超过 20 万个时直接拒绝，一个都不铺', 'n=' + NF.graph().n);

    /* ---- 16. 批量连接：链 / 分层 / 随机 / 删除 ---- */
    NF.clear();
    const g16 = [];
    for (let c = 0; c < 3; c++) for (let b = 0; b < 3; b++) for (let a = 0; a < 3; a++) g16.push(NF.addNode(a * 10, b * 10, c * 10));
    const rc = NF.batchConnect('chain', { nodes: g16, axis: 1 });
    await raf();
    log(rc.added === g16.length - 1, '按轴串联成链：边数 = 神经元数 - 1', rc.added + ' 条');
    let backE = 0;
    for (let e = 0; e < NF.graph().e; e++) { const ed = NF.edge(e); if (NF.node(ed.src).y > NF.node(ed.dst).y) backE++; }
    log(backE === 0, '链上没有沿轴回头的边（保证无环）', backE + ' 条反向边');

    NF.clear();
    const g17 = [];
    for (let c = 0; c < 3; c++) for (let b = 0; b < 4; b++) g17.push(NF.addNode(b * 10, c * 10, 0));
    const rl = NF.batchConnect('layer', { nodes: g17, axis: 1, tol: 10, fan: 2 });
    await raf();
    log(rl.added === 16, '按轴分层连接：3 层各 4 个，每层只连下一层最近 2 个', rl.added + ' 条');
    let onlyNext = true;
    for (let e = 0; e < NF.graph().e; e++) {
      const ed = NF.edge(e);
      if (NF.node(ed.dst).y - NF.node(ed.src).y !== 10) onlyNext = false;
    }
    log(onlyNext, '分层连接只连相邻的下一层，不跳层也不回头');
    const rl2 = NF.batchConnect('layer', { nodes: g17, axis: 1, tol: 10, fan: 2 });
    await raf();
    log(rl2.added === 0 && rl2.skipped === rl.added, '再点一次不会连出第二条重复边',
        'added=' + rl2.added + ' skipped=' + rl2.skipped);
    const rcut = NF.batchConnect('cut', { nodes: g17 });
    await raf();
    log(rcut.cut === rl.added && NF.graph().e === 0, '「删除选中之间的连接」把刚连的一次清干净',
        '删了 ' + rcut.cut + ' 条');

    NF.clear();
    const g18 = [];
    for (let k = 0; k < 40; k++) g18.push(NF.addNode((k % 8) * 10, Math.floor(k / 8) * 10, 0));
    const rr = NF.batchConnect('random', { nodes: g18, fan: 3, maxDist: 15 });
    await raf();
    log(rr.added > 0 && rr.added <= g18.length * 3, '按距离随机连接：每个点最多连出 fan 条',
        rr.added + ' 条');
    let selfLoop = 0, tooFar = 0;
    const outCnt16 = {};
    for (let e = 0; e < NF.graph().e; e++) {
      const ed = NF.edge(e);
      if (ed.src === ed.dst) selfLoop++;
      const na = NF.node(ed.src), nb2 = NF.node(ed.dst);
      if (Math.hypot(na.x - nb2.x, na.y - nb2.y, na.z - nb2.z) > 15 + 1e-6) tooFar++;
      outCnt16[ed.src] = (outCnt16[ed.src] || 0) + 1;
    }
    log(selfLoop === 0 && tooFar === 0, '随机连接不会自环，也不会超出最大距离',
        '自环 ' + selfLoop + ' / 越界 ' + tooFar);
    let outMax = 0;
    for (const k2 in outCnt16) if (outCnt16[k2] > outMax) outMax = outCnt16[k2];
    log(outMax <= 3, '每个神经元的出边数不超过设定值', '最大 ' + outMax);
    const many16 = [];
    for (let k = 0; k < 4200; k++) many16.push(0);
    const rToo = NF.batchConnect('random', { nodes: many16, fan: 2 });
    log(!!rToo.err, '超过 4000 个时明确拒绝并说明，而不是让浏览器假死', rToo.err || '(没有报错)');

    /* ---- 17. 模拟激活：波数上限 ---- */
    NF.simClear();
    NF.clear();
    let prev17 = NF.addNode(0, 0, 0);
    NF.setThr([prev17], 0.5);
    for (let k = 1; k < 8; k++) { const nn17 = NF.addNode(k * 10, 0, 0); NF.addEdge(prev17, nn17, 2.0); prev17 = nn17; }
    const full17 = NF.simCompute([0], {});
    log(full17.activated === 8 && full17.maxWave === 7, '不设上限时整条 8 层链都能点亮',
        full17.activated + ' 个 / 最远第 ' + (full17.maxWave + 1) + ' 波');
    const lim17 = NF.simCompute([0], { waveLimit: 3 });
    log(lim17.maxWave === 2 && lim17.activated === 3, '波数上限在计算阶段就截断（不白算后面的）',
        'maxWave=' + lim17.maxWave + ' activated=' + lim17.activated);
    log(lim17.byWave.length === 3, 'byWave 也只到上限那一波', lim17.byWave.length + ' 波');
    NF.simLimit(3);
    log(NF.simState().waveLimit === 3, '脚本 / 界面接口能改波数上限');
    NF.simRun([0]);
    await sleep(520);
    const st17 = NF.simState();
    log(st17.maxWave <= 2, '播放阶段也只走到上限', 'wave=' + st17.wave + ' maxWave=' + st17.maxWave);
    log(st17.reached <= 3, '点亮数不超过上限内的神经元数', 'reached=' + st17.reached);
    NF.simLimit(0);
    NF.simClear();
    log(NF.simState().waveLimit === 0, '上限可以改回 0（不限）');
    /* 空波不该占额度：种子在第 3 层时，前两波是空的 */
    NF.clear();
    const a17 = NF.addNode(0, 0, 0), b17 = NF.addNode(10, 0, 0), c17 = NF.addNode(20, 0, 0), d17 = NF.addNode(30, 0, 0);
    NF.addEdge(a17, b17, 2.0); NF.addEdge(b17, c17, 2.0); NF.addEdge(c17, d17, 2.0);
    const gap17 = NF.simCompute([c17], { waveLimit: 2 });
    log(gap17.activated === 2 && gap17.maxWave === 3, '波数从「第一波真的点亮」开始数，空波不占额度',
        'activated=' + gap17.activated + ' maxWave=' + gap17.maxWave);

    /* ---- 撤销 / 重做：每次只退一步，重做原路返回 ---- */
    NF.clear();
    const hn0 = NF.graph().n;
    NF.snapshot(); NF.addNode(1, 0, 0);
    const hn1 = NF.graph().n;
    NF.snapshot(); NF.addNode(2, 0, 0);
    const hn2 = NF.graph().n;
    NF.snapshot(); NF.addNode(3, 0, 0);
    const hn3 = NF.graph().n;
    NF.undo(); const hu1 = NF.graph().n;
    NF.undo(); const hu2 = NF.graph().n;
    NF.undo(); const hu3 = NF.graph().n;
    NF.undo(); const hu4 = NF.graph().n;
    log(hu1 === hn2 && hu2 === hn1 && hu3 === hn0 && hu4 === hn0,
        '撤销是一步一步退的（不会一次退两步）',
        hn3 + ' → ' + [hu1, hu2, hu3, hu4].join(' → ') + '（期望 ' + [hn2, hn1, hn0, hn0].join(' → ') + '）');
    NF.redo(); const hr1 = NF.graph().n;
    NF.redo(); const hr2 = NF.graph().n;
    NF.redo(); const hr3 = NF.graph().n;
    NF.redo(); const hr4 = NF.graph().n;
    log(hr1 === hn1 && hr2 === hn2 && hr3 === hn3 && hr4 === hn3,
        '重做原路返回', [hu4, hr1, hr2, hr3, hr4].join(' → '));
    /* 改动之后再撤销，redo 的尾巴必须被丢掉 */
    NF.undo(); NF.undo();
    const hb1 = NF.graph().n;
    NF.snapshot(); NF.addNode(9, 0, 0);
    const hb2 = NF.graph().n;
    NF.redo();
    log(hb2 === hb1 + 1 && NF.graph().n === hb2, '改动之后重做失效（redo 尾巴被丢掉）',
        hb1 + ' → ' + hb2 + ' → ' + NF.graph().n);
    /* ---- 重做之后立刻撤销：必须真的退一步 ----
       以前这里是**空操作**（还把光标退了一格）：重做把当前状态正好放在 stack[head] 上，
       撤销却先 captureState 再覆盖 stack[head]、再 restore 同一个 stack[head] —— 原地踏步。
       用户看到「已撤销」但画面没变，再按一次撤销就一口气退两步。 */
    NF.clear();
    const rIds = [];
    NF.snapshot(); rIds.push(NF.addNode(0, 0, 0));
    NF.snapshot(); rIds.push(NF.addNode(10, 0, 0));
    NF.snapshot(); NF.addEdge(rIds[0], rIds[1], 0.5);
    const rN2 = NF.graph().n;
    NF.snapshot(); NF.addNode(20, 0, 0);
    const rN3 = NF.graph().n;
    NF.undo(); const rU1 = NF.graph().n;
    NF.redo(); const rR1 = NF.graph().n;
    NF.undo(); const rU2 = NF.graph().n;
    log(rU1 === rN2 && rR1 === rN3, '撤销 / 重做各退进一步（基准）', [rN3, rU1, rR1].join(' → '));
    log(rU2 === rN2, '重做之后再撤销必须真的退回去（以前这里是空操作）', rU2 + '（期望 ' + rN2 + '）');
    NF.redo();
    log(NF.graph().n === rN3, '上面那次撤销没把重做的尾巴弄丢（还能重做回去）', String(NF.graph().n));
    NF.undo(); const rD1 = NF.graph().n;
    NF.undo(); const rD2 = NF.graph().n;
    log(rD1 === rN2 && rD2 === rN2 - 1, '连按撤销是一格一格地退（不是一次退两步）', [rN3, rD1, rD2].join(' → '));
    /* 权重那条路也一样：改 - 撤 - 重 - 撤 必须回到原值 */
    NF.clear();
    const rwIds = [];
    NF.snapshot(); rwIds.push(NF.addNode(0, 0, 0));
    NF.snapshot(); rwIds.push(NF.addNode(10, 0, 0));
    NF.snapshot(); NF.addEdge(rwIds[0], rwIds[1], 0.5);
    const wp0 = NF.edge(0).w;
    NF.snapshot(); NF.setW(0, 0.75);
    NF.undo(); const wpA = NF.edge(0).w;
    NF.redo(); const wpB = NF.edge(0).w;
    NF.undo(); const wpC = NF.edge(0).w;
    log(wpA === wp0 && wpB === 0.75 && wpC === wp0, '改权重 - 撤销 - 重做 - 撤销，最后必须回到原值',
        [wp0, wpA, wpB, wpC].join(' → '));

    /* ---- 18. 两侧界面：分区折叠 / 放置面板跟随工具 / 模拟激活设置搬到右栏 ---- */
    NF.simClear();
    NF.clear();
    const n18 = NF.addNode(0, 0, 0);
    NF.addNode(10, 0, 0);
    NF.select([], []);
    await raf();

    const viewH3 = document.getElementById('sec-view').querySelector('h3');
    viewH3.click();
    await raf();
    log(document.getElementById('sec-view').classList.contains('collapsed') &&
        getComputedStyle(document.getElementById('sec-view').querySelector('.body')).display === 'none',
        '点分区标题能把整块收起', document.getElementById('sec-view').className);
    viewH3.click();
    await raf();
    log(!document.getElementById('sec-view').classList.contains('collapsed') &&
        getComputedStyle(document.getElementById('sec-view').querySelector('.body')).display !== 'none',
        '再点一次能展开');

    const secPlace = document.getElementById('sec-place');
    const secNeuron = document.getElementById('sec-neuron');
    const secGen = document.getElementById('sec-gen');
    const hidden18 = (el) => !el || getComputedStyle(el).display === 'none';
    log(!!secPlace && !!secNeuron && !!secGen, '「神经元 / 按坐标放置 / 批量生成」各自是独立分区');
    log(hidden18(secPlace) && hidden18(secNeuron) && hidden18(secGen),
        '没点「放置神经元」时放置相关的三类不占地方',
        '隐藏状态 ' + [secNeuron, secPlace, secGen].map(hidden18).join(','));
    document.getElementById('t-add').click();
    await raf();
    log(!hidden18(secNeuron) && !hidden18(secPlace) && !hidden18(secGen), '点了「放置神经元」后三类一起出现');
    log(document.getElementById('pl-info').textContent.indexOf('(') >= 0, '藏起来的分区状态照常刷新，不耽误放置');
    document.getElementById('t-select').click();
    await raf();
    log(hidden18(secPlace), '切回选择工具后它们又收起来');

    document.getElementById('sec-view').querySelector('h3').click();
    await raf();
    NF.select([n18], []);
    await raf();
    log(document.getElementById('sec-view').classList.contains('collapsed'),
        '左栏折叠状态不会被属性面板重建冲掉');

    const posSecOf = () => {
      const list = document.querySelectorAll('#inspector .sec');
      for (let i = 0; i < list.length; i++) {
        const h = list[i].querySelector('h3');
        if (h && h.textContent.indexOf('空间坐标') === 0) return list[i];
      }
      return null;
    };
    const posSec = posSecOf();
    log(!!posSec, '右栏也有可折叠的分区');
    posSec.querySelector('h3').click();
    await raf();
    log(posSec.classList.contains('collapsed'), '右栏分区点标题也能收起');
    NF.select([n18 + 1], []);
    await raf();
    NF.select([n18], []);
    await raf();
    const posSec2 = posSecOf();
    log(!!posSec2 && posSec2.classList.contains('collapsed'), '换选中对象后右栏折叠状态还在');
    posSec2.querySelector('h3').click();
    await raf();
    log(!posSec2.classList.contains('collapsed'), '右栏分区再点一下能展开回来');

    log(document.querySelectorAll('#sim-limit').length === 1 &&
        document.querySelectorAll('#sim-info').length === 1 &&
        document.querySelectorAll('#sim-live').length === 1,
        '模拟激活的设置整份界面只有一套（不会两边各留一份）');
    log(!document.querySelector('#left #sim-limit') && !!document.querySelector('#inspector #sim-limit'),
        '模拟激活的设置搬到了右栏，和模拟激活按钮同一块');
    const simBtn18 = document.querySelector('#inspector button[data-act=sim-one]');
    log(!!simBtn18 && simBtn18.textContent.indexOf('模拟激活') === 0, '右栏里就是开始按钮',
        simBtn18 ? simBtn18.textContent : '没找到');
    const lim18 = document.getElementById('sim-limit');
    lim18.value = '5';
    lim18.dispatchEvent(new Event('input', { bubbles: true }));
    log(NF.simState().waveLimit === 5, '在右栏改「最多播放波数」立刻生效', String(NF.simState().waveLimit));
    lim18.value = '0';
    lim18.dispatchEvent(new Event('input', { bubbles: true }));
    log(NF.simState().waveLimit === 0, '还能改回「不限」');
    const spd18 = document.getElementById('sim-speed');
    spd18.value = '400';
    spd18.dispatchEvent(new Event('input', { bubbles: true }));
    log(NF.simState().speed === 400, '播放速度同样在右栏直接生效', String(NF.simState().speed));
    simBtn18.click();
    await raf();
    log(NF.simState().active, '右栏按钮能直接开始模拟激活');
    NF.simClear();
    NF.select([], []);
    await raf();
    const simBtn0 = document.querySelector('#inspector button[data-act=sim-one]');
    log(!!simBtn0 && simBtn0.disabled, '一个都没选中时按钮是灰的');
    NF.setLang('en');
    await raf();
    log(document.getElementById('sec-view').classList.contains('collapsed'), '切成英文后左栏折叠状态还在');
    log(document.getElementById('sec-view').querySelector('h3').textContent === 'Display',
        '分区标题本身照常翻英文', document.getElementById('sec-view').querySelector('h3').textContent);
    NF.setLang('zh');
    await raf();
    log(document.getElementById('sec-view').classList.contains('collapsed'), '切回中文折叠状态也还在');
    document.getElementById('sec-view').querySelector('h3').click();   /* 还原折叠状态 */
    await raf();

    /* ---- 19. 两侧栏收放 + 底部 AI 助手 ---- */
    const AU = NF.aiAudit();
    log(AU.missing.length === 0, 'AI 工具表里写的脚本接口都真实存在',
        AU.tools + ' 个工具 / 缺 ' + AU.missing.length + ' 个' + (AU.missing.length ? '：' + AU.missing.join(',') : ''));
    log(AU.cmdsMissing.length === 0, '界面上每个菜单命令手册里都写了',
        AU.cmdsMissing.length ? AU.cmdsMissing.join(',') : AU.cmds.length + ' 条命令全覆盖');
    log(AU.promptHasManual === true, '系统提示词里真的带上了操作手册', '手册版本 ' + AU.manualVersion);
    log(AU.keysInPrompt === AU.apiKeys && AU.apiKeys > 100, '接口清单是开对话时现扫的，一个不漏地灌进了提示词',
        AU.keysInPrompt + '/' + AU.apiKeys);
    log(NF.aiPrompt().length > 3000, '提示词确实够长（手册 + 工具 + 状态）', NF.aiPrompt().length + ' 字符');
    log(NF.aiTools().length > 30, 'AI 能做的不止几件事', NF.aiTools().length + ' 个工具');
    log(NF.aiCommands().indexOf('toggle-both') >= 0 && NF.aiCommands().indexOf('lang-en') >= 0,
        '新加的菜单命令也进了手册', NF.aiCommands().length + ' 条');
    const mv19 = String(NF.aiState().manualVersion);
    log(mv19.charAt(0) === 'r' && mv19.length > 1 && String(parseInt(mv19.slice(1), 10)) === mv19.slice(1) &&
        NF.aiPrompt().indexOf(mv19) >= 0, '手册有版本号，而且真的写进了提示词', mv19);
    log(NF.aiState().seq >= 1, '启动时自动开了一个新对话', '第 ' + NF.aiState().seq + ' 次');
    /* ---- Key 这一段：用户被弄丢过一次，这里的规矩必须验到 ----
       机器上真存着 Key 的话，全程只用那个真值来回写，不塞假 Key；收尾还会再放回一次。 */
    const k19 = NF.aiState();
    log(k19.hasKey === (k19.keyLen > 0) && (NF.inShell() ? true : k19.hasKey === false),
        'Key 状态自洽（浏览器里是全新安装：没有 Key；壳子里可能存着用户自己的）',
        'hasKey=' + k19.hasKey + ' / ' + k19.keyLen + ' 位');
    log(k19.base.indexOf('deepseek') >= 0, '默认接 DeepSeek 的兼容端点', k19.base);
    const KK19 = KEEP19.key || 'sk-sticky19';
    log(NF.aiConfig({ key: KK19 }).hasKey === true, '填了 Key 之后状态跟着变');
    log(document.getElementById('ai-key').value === KK19, '设置面板里的输入框跟着填上，位数还对', NF.aiState().keyLen + ' 位');
    log(document.getElementById('ai-keynote').textContent.indexOf('位') > 0,
        '设置面板里 Key 下面那行自己说存了几位 / 存在哪', document.getElementById('ai-keynote').textContent.slice(0, 44));
    log(NF.aiState().bakKey === KK19.length, '带 Key 的配置会自动留一份备份（只留非空的）', NF.aiState().bakKey + ' 位');
    /* 造一个坏现场：现役那份被写空了，只剩备份里还有 Key */
    try { localStorage.setItem('nf.ai', JSON.stringify({ key: '', visKey: '', base: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-flash', extra: '', autoRun: true, stream: true, maxTurns: 80, at: 1 })); } catch (e) {}
    NF.aiReloadCfg();
    log(NF.aiState().hasKey === false, '造坏现场：现役配置被写空之后，读回来确实没有 Key');
    NF.aiSaveCfg(false);
    log(NF.aiState().keyLen === KK19.length, 'Key 保护：自动保存时非空的 Key 不许被空的盖掉（从备份里捡回来）', NF.aiState().keyLen + ' 位');
    log(String(localStorage.getItem('nf.ai')).indexOf(KK19) > 0, 'Key 保护：捡回来之后本机存储里那份也是完整的');
    /* 只有用户按「清掉 API Key」才是真清空 */
    NF.aiConfig({ key: '' });
    log(NF.aiState().hasKey === false && NF.aiState().bakKey === 0, '明确清空才是真清空：连备份一起清掉', 'bak=' + NF.aiState().bakKey);
    if (KEEP19.key) { NF.aiConfig({ key: KEEP19.key }); log(NF.aiState().keyLen === KEEP19.key.length, '这一段跑完把用户原来的 Key 放回去了', NF.aiState().keyLen + ' 位'); }
    /* 工具真的会改图，而且一次动作 = 一步撤销 */
    const n19 = NF.graph().n;
    const rr19 = await NF.aiTool('add_node', { x: 1234, y: 5, z: 6, color: '#ff8800' });
    log(rr19.ok === true && NF.graph().n === n19 + 1, 'AI 调工具真的能放神经元', JSON.stringify(rr19.result));
    const id19 = rr19.result.id;
    log(NF.node(id19).x === 1234 && NF.node(id19).color.toLowerCase() === '#ff8800', '坐标和颜色都按说的落了',
        '#' + id19 + ' ' + NF.node(id19).x + ',' + NF.node(id19).z + ' ' + NF.node(id19).color);
    NF.undo();
    await raf();
    log(NF.graph().n === n19, 'AI 的一次动作 = 一步撤销，Ctrl+Z 能整体退回去', NF.graph().n + '/' + n19);
    log((await NF.aiTool('menu', { cmd: '没有这条命令' })).ok === false, '乱写菜单命令会被拦住');
    log((await NF.aiTool('run_api', { name: '没有这个接口' })).ok === false, '乱调脚本接口也会被拦住');
    /* 破坏性操作必须先问用户。这里点的是软件自己画的确认框 —— 壳子里原生 confirm
       根本不显示、还会把渲染线程同步卡死（实测过），所以这一条同时验「真的问过」和「点了真管用」。 */
    const box19 = () => document.getElementById('nfask');
    const p19 = NF.aiTool('delete_selected', {});
    await raf();
    log(!!box19() && getComputedStyle(box19()).display !== 'none' && box19().textContent.indexOf('确认') >= 0,
        '破坏性操作会先弹一个软件自己画的确认框（不用系统的 confirm）');
    document.getElementById('nfask-no').click();
    const del19 = await p19;
    log(del19.ok === false && String(del19.error).indexOf('拒绝') >= 0, '用户点「取消」就不执行', del19.error);
    log(!box19() || box19().style.display === 'none', '点完之后确认框自己收起来');
    /* 点「允许」才真的动手：自己造两个节点选中，删完数一数 */
    const a19 = NF.addNode(0, 400, 0), b19 = NF.addNode(10, 400, 0);
    NF.select([a19, b19], []);
    await raf();
    const nB19 = NF.graph().n;
    const p19b = NF.aiTool('delete_selected', {});
    await raf();
    document.getElementById('nfask-yes').click();
    const del19b = await p19b;
    log(del19b.ok === true && NF.graph().n === nB19 - 2, '用户点「允许」才真的删（图里少了两个）',
        nB19 + ' -> ' + NF.graph().n);
    /* 关掉「大改动先问我」之后：不再弹框卡着，但**必须留一行记录**（不然就成了偷偷动用户的图） */
    NF.aiConfig({ noAsk: true });
    const mk19 = NF.aiLog().length;
    const c19 = NF.addNode(0, 500, 0), d19 = NF.addNode(10, 500, 0);
    NF.select([c19, d19], []);
    await raf();
    const nC19 = NF.graph().n;
    const p19c = NF.aiTool('delete_selected', {});
    await raf();
    const noBox = !box19() || getComputedStyle(box19()).display === 'none';
    const del19c = await p19c;
    log(noBox && del19c.ok === true && NF.graph().n === nC19 - 2,
        '关掉「大改动先问我」之后：不弹框、直接执行（不会把任务卡在等人点）',
        '框=' + (noBox ? '没有' : '还在') + ' ' + nC19 + ' -> ' + NF.graph().n);
    const tail19 = NF.aiLog().slice(mk19).map((x) => String(x.text || '')).join(' | ');
    log(tail19.indexOf('没问') >= 0,
        '关掉之后这类操作照样在对话里留一行记录（不是偷偷改用户的图）', tail19.slice(0, 90));
    log(NF.aiState().noAsk === true, '状态里如实报出「大改动先问我」是关着的');
    NF.aiConfig({ noAsk: false });
    log(NF.aiState().noAsk === false, '还能勾回去（默认装好之后是问的）');
    /* 侧栏收放 */
    const vpW19 = () => document.getElementById('viewport').getBoundingClientRect().width;
    NF.setPanels({ left: true, right: true });
    await raf();
    const w0_19 = vpW19();
    log(NF.panels().left === true && NF.panels().right === true, '默认两栏都在');
    NF.setPanels({ left: false });
    await raf();
    log(document.getElementById('app').classList.contains('hide-left'), '收左栏会给 #app 挂上 hide-left');
    const lw19 = document.getElementById('left').getBoundingClientRect().width;
    log(lw19 === 0, '收起的左栏完全不占宽度', lw19.toFixed(0) + 'px');
    const w1_19 = vpW19();
    log(w1_19 > w0_19 + 100, '收掉左栏后视口变宽了', w0_19.toFixed(0) + ' -> ' + w1_19.toFixed(0));
    const tabL19 = document.getElementById('tab-left');
    log(tabL19.classList.contains('on'), '边上那条竖条变成"已收起"的样子');
    log(document.querySelector('#viewport > #tab-left') !== null &&
        document.querySelector('#viewbar [data-cmd=toggle-left]') === null,
        '收放按钮贴在面板内边（挂在视口里），不在右上角工具条上');
    log(tabL19.textContent === String.fromCharCode(8250),
        '收起后箭头指向外侧（点它拉出来）', tabL19.textContent);
    const tr19 = tabL19.getBoundingClientRect(), vp19 = document.getElementById('viewport').getBoundingClientRect();
    log(Math.abs((tr19.y + tr19.height / 2) - (vp19.y + vp19.height / 2)) < 2,
        '竖条在竖直方向居中（不是压在顶上）',
        Math.round(tr19.y + tr19.height / 2) + ' vs ' + Math.round(vp19.y + vp19.height / 2));
    NF.setPanels({ left: true });
    await raf();
    log(Math.abs(vpW19() - w0_19) < 1, '还能原样收回来');
    log(tabL19.textContent === String.fromCharCode(8249),
        '展开后箭头指回里侧', tabL19.textContent);
    /* 快捷键 */
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true }));
    await raf();
    log(NF.panels().left === false, '按 [ 收左栏');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }));
    await raf();
    log(NF.panels().right === false, '按 ] 收右栏');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: String.fromCharCode(92), bubbles: true }));
    await raf();
    log(NF.panels().left === true && NF.panels().right === true, '再按一次两栏一起回来');
    /* 沉浸模式：脚本口和菜单口都要通 */
    await NF.aiTool('menu', { cmd: 'toggle-both' });
    await raf();
    log(NF.panels().left === false && NF.panels().right === false, '沉浸模式：两栏一起收，画面只剩神经元');
    log(document.getElementById('left').getBoundingClientRect().width === 0 &&
        document.getElementById('right').getBoundingClientRect().width === 0, '沉浸态下两栏都不占宽度');
    log(document.getElementById('tab-left').getBoundingClientRect().width > 5 &&
        document.getElementById('tab-right').getBoundingClientRect().width > 5,
        '两条竖条还钉在边上，收起来也找得到');
    log(vpW19() > window.innerWidth - 20, '沉浸态下视口铺满整宽', vpW19().toFixed(0) + 'px');
    NF.setPanels({ left: true, right: true });
    await raf();
    /* AI 框本体 */
    const ai19 = document.getElementById('ai');
    const aiHead19 = document.getElementById('aihead');
    log(!!ai19 && !!document.getElementById('ailog') && !!document.getElementById('aitext') &&
        !!document.getElementById('aisend'), 'AI 对话框挂在视口底部（记录 / 输入框 / 发送键都在）');
    log(aiHead19.querySelector('[data-aicmd=new]').textContent === '新对话' &&
        aiHead19.querySelector('[data-aicmd=set]').textContent === '设置' &&
        aiHead19.querySelector('[data-aicmd=hide]') === null,
        '标题栏只有"新对话 / 设置"，没有"关掉"键');
    /* 收放 = 贴在视口底边正中的小横条，挂在视口里（跟两侧栏一个规矩） */
    const tabAi19 = document.getElementById('tab-ai');
    log(!!tabAi19 && tabAi19.dataset.cmd === 'ai' &&
        document.getElementById('viewport').contains(tabAi19),
        'AI 框的收放也是贴在边上的小条，而且挂在视口里（收起来也找得到）');
    const vpRect19 = document.getElementById('viewport').getBoundingClientRect();
    const stripR19 = tabAi19.getBoundingClientRect();
    log(Math.abs((stripR19.x + stripR19.width / 2) - (vpRect19.x + vpRect19.width / 2)) < 2, '这条小横条横在视口正中');
    const aiTop19 = ai19.getBoundingClientRect().top;
    log(Math.abs(stripR19.bottom - aiTop19) < 2 && stripR19.height > 5,
        '摊开时它就贴在 AI 框顶上（不是压在对话框底下）', stripR19.width.toFixed(0) + 'x' + stripR19.height.toFixed(0));
    NF.aiSetUI({ open: true, folded: false, set: false });
    await raf();
    log(!ai19.classList.contains('hidden') && !ai19.classList.contains('folded'), '默认是摊开的');
    log(tabAi19.textContent === '\u2228', '摊开时箭头指着要收回去的那边（朝下）', tabAi19.textContent);
    tabAi19.click();
    await raf();
    log(ai19.classList.contains('folded'), '点一下就收起来');
    log(ai19.getBoundingClientRect().height === 0, '收起后 AI 框整块让位、不占地方');
    const stripFolded19 = tabAi19.getBoundingClientRect();
    log(tabAi19.classList.contains('on') && tabAi19.textContent === '\u2227' &&
        stripFolded19.height > 5,
        '收起来后小条变"已收起"的样子、箭头指回外侧，小条自己还在');
    log(stripFolded19.bottom <= vpRect19.bottom + 1 && vpRect19.bottom - stripFolded19.bottom < 40,
        '收起来后它落回视口底边，原地还找得到',
        '离底边 ' + (vpRect19.bottom - stripFolded19.bottom).toFixed(0) + 'px');
    tabAi19.click();
    await raf();
    log(!ai19.classList.contains('folded'), '再点一下又展开');
    const logVisible19 = document.getElementById('ailog').getBoundingClientRect().height > 0;
    NF.aiSetUI({ open: false });   /* 旧的"关掉"写法 */
    await raf();
    log(ai19.classList.contains('folded') && !ai19.classList.contains('hidden'), '想关掉也只会收成边上那条小横条');
    log(tabAi19.getBoundingClientRect().height > 5 && logVisible19, '小条还在、对话记录也没被删掉，随时拉得回来');
    log(!document.getElementById('aifab'), '也就没有"关掉之后找不回来"这回事');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', bubbles: true }));
    await raf();
    log(!ai19.classList.contains('folded'), 'F8 在收起 / 展开之间切');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', bubbles: true }));
    await raf();
    log(ai19.classList.contains('folded'), '再按一次又收起来');
    tabAi19.click();
    await raf();
    log(!ai19.classList.contains('folded'), '点底边那条小横条也能拉回来');
    aiHead19.querySelector('[data-aicmd=set]').click();
    await raf();
    log(document.getElementById('aiset').style.display === 'flex', '点"设置"展开参数面板');
    log(!!document.getElementById('ai-autorun') && !!document.getElementById('ai-extra') &&
        !!document.getElementById('ai-base') && !!document.getElementById('ai-model'),
        '设置里有接口地址 / 模型 / 附加要求 / 自动执行');
    log(document.getElementById('ai-extra').placeholder.indexOf('附加') < 0 &&
        document.getElementById('aitext').placeholder.indexOf('AI') >= 0,
        '输入框和附加要求都写了怎么用', document.getElementById('aitext').placeholder.slice(0, 18));
    document.getElementById('ai-autorun').checked = false;
    document.getElementById('ai-autorun').dispatchEvent(new Event('change', { bubbles: true }));
    const blocked19 = await NF.aiTool('add_node', { x: 1, y: 1, z: 1 });
    log(blocked19.ok === false && NF.graph().n === n19, '关掉"自动执行"后，AI 的命令不会真的动图');
    document.getElementById('ai-autorun').checked = true;
    document.getElementById('ai-autorun').dispatchEvent(new Event('change', { bubbles: true }));
    log((await NF.aiTool('add_node', { x: 1, y: 1, z: 1 })).ok === true, '打开后又能执行');
    NF.undo();
    await raf();
    log(NF.graph().n === n19, '又退回去了');
    aiHead19.querySelector('[data-aicmd=set]').click();
    await raf();
    log(document.getElementById('aiset').style.display === 'none', '"设置"再点一下收起');
    aiHead19.querySelector('[data-aicmd=set]').click();
    await raf();
    log(document.getElementById('aiset').style.display === 'flex', '再点一下又展开');
    document.getElementById('tab-ai').click();
    await raf();
    log(document.getElementById('aiset').style.display === 'none', '收起 AI 框时设置面板也一起让位');
    document.getElementById('tab-ai').click();
    await raf();
    log(document.getElementById('aiset').style.display === 'flex', '展开后又回来');
    aiHead19.querySelector('[data-aicmd=set]').click();
    await raf();
    log(document.getElementById('aiset').style.display === 'none', '最后收回设置面板');
    /* 新对话 */
    const seq19 = NF.aiState().seq;
    NF.aiNewSession('自测');
    await raf();
    log(NF.aiState().seq === seq19 + 1, '新开对话计数 +1', String(NF.aiState().seq));
    log(NF.aiState().msgs === 1, '新对话只留一条系统提示词，不带旧上下文');
    log(NF.aiLog().length > 0 && NF.aiLog()[0].role === 'note', '对话记录里有一条说明，告诉用户手册已交底');
    log(NF.aiLog().every((x) => x.role === 'note'), '自测没发过网络请求（离线也能跑）');
    log(NF.aiState().err === '', '也不该有错误残留', NF.aiState().err);
    /* 手册和状态是活的 */
    const st19 = (await NF.aiTool('get_state', {})).result;
    log(st19 && st19['神经元'] === NF.graph().n, 'get_state 报的神经元数就是当前的', String(st19['神经元']));
    /* 状态块现在是紧凑 JSON（r55 起：每轮都发，能省就省），所以匹配要容忍冒号后的空白 */
    log(new RegExp('"神经元":\\s*' + NF.graph().n).test(NF.aiPrompt()), '当前状态真的写进了提示词');
    log(NF.aiManual().indexOf('AI 助手') >= 0 && NF.aiManual().length > 3000, '手册正文够细',
        NF.aiManual().length + ' 字符');
    NF.aiSetUI({ set: false });
    await raf();


    /* ---- 22. 全局随机种子：同种子 = 同结果 ---- */
    const blankDoc = () => ({ format: 'neuroforge-project', version: 2, name: 'seed-test', seed: 1,
      neurons: { pos: [], io: [], col: [], colOn: [], thr: [], act: [], bias: [], lock: [], names: {} },
      edges: [], blocks: [] });
    const mkWeights = (sd) => {
      NF.loadV2(blankDoc());
      NF.seed(sd);
      NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, blink: true });
      NF.bulkPlace(4, 1, 1);
      const ids = NF.selectedNodes();
      NF.batchConnect('random', { nodes: ids, fan: 3 });
      const g = NF.graph(), w = [];
      for (let e = 0; e < g.e; e++) w.push(NF.edge(e).w);
      return w;
    };
    log(typeof NF.seed() === 'number' && NF.seed() > 0, '种子可读（默认就有一个固定值）', String(NF.seed()));
    const wA = mkWeights(11111), wB = mkWeights(11111), wC = mkWeights(22222);
    log(wA.length > 0, '种子用例：造出了带随机权重的图', wA.length + ' 条连接');
    log(wA.length === wB.length && wA.every((v, i) => Object.is(v, wB[i])), '同种子 → 权重逐位相同', wA.length + ' 条');
    log(wA.length !== wC.length || wA.some((v, i) => !Object.is(v, wC[i])), '换种子 → 结果不同');
    NF.seed(4242);
    const seedDoc2 = NF.serializeV2();
    log(seedDoc2.seed === 4242, 'v2 工程文件里带种子', String(seedDoc2.seed));
    NF.seed(7);
    NF.loadV2(seedDoc2);
    log(NF.seed() === 4242, 'v2 读回来种子跟着回来', String(NF.seed()));
    const buf3 = await NF.encodeV3({});
    log(NF.inspectFile(buf3).seed === 4242, 'v3 容器头里也写了种子', String(NF.inspectFile(buf3).seed));
    NF.seed(9);
    await NF.loadBuffer(buf3);
    log(NF.seed() === 4242, 'v3 读回来种子一致', String(NF.seed()));


    /* ---- 23. 历史：分块结构共享（可逆、无损） ---- */
    NF.loadV2(blankDoc());
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 8, blink: false });
    const nb0 = NF.graph().n;
    const madeN = NF.bulkPlace(30, 20, 6);
    const bigIds = [];
    for (let i = nb0; i < nb0 + madeN; i++) bigIds.push(i);
    NF.select(bigIds, []);
    NF.batchConnect('layer', { nodes: bigIds, axis: 2, tol: 8, fan: 2 });
    const s0 = NF.histStats();
    log(s0.steps >= 3 && s0.uniqueChunks > 20, '分块历史已建立', s0.steps + ' 格 / ' + s0.uniqueChunks + ' 块');
    log(s0.bytes > 0 && s0.bytes < s0.naive * s0.steps, '实际占用比“整份拷贝”小',
        s0.bytes + ' B vs ' + (s0.naive * s0.steps) + ' B');
    /* 同一个操作连做三次：第二、第三次已经加不出新边了，
       所以第三次拍的快照必须跟第二次共享全部分块——多一个字节都算错。 */
    const chainIds = bigIds.slice(0, 40);
    NF.batchConnect('chain', { nodes: chainIds, axis: 0 });
    const s1 = NF.histStats();
    NF.batchConnect('chain', { nodes: chainIds, axis: 0 });
    const s2 = NF.histStats();
    NF.batchConnect('chain', { nodes: chainIds, axis: 0 });
    const s3 = NF.histStats();
    log(s3.steps === s2.steps + 1, '空操作确实占了一格历史', s2.steps + ' -> ' + s3.steps);
    log(s3.bytes === s2.bytes && s3.uniqueChunks === s2.uniqueChunks, '没改动的那一格一个块都没重拷（结构共享）',
        '多占 ' + (s3.bytes - s2.bytes) + ' B / ' + (s3.uniqueChunks - s2.uniqueChunks) + ' 块');
    const ratio = (s0.naive * s3.steps) / Math.max(1, s3.bytes);
    log(ratio > 1.5, '总体压缩比 > 1.5 倍（' + (s1.steps - s0.steps) + ' 格真改动共 ' + s1.bytes + ' B）', ratio.toFixed(2) + ' x');
    /* ---- 登记快速路：拍完一拍就把三个「要扫」都清掉，只有真写了那一类列才会再变脏 ----
       这条近路靠「每个写入点打一下标记」跑起来：标记漏了 = 撤销静默回错格。
       所以既验标记本身（下面几条），也让上面打开的裁判把整场自测的每个操作都比一遍。 */
    NF.setW(0, 0.25);
    const mk1 = NF.histMarks();
    log(mk1.wdirty === true && mk1.dirty === false && mk1.sdirty === false, '改权重只脏「权重列」，不脏「拓扑列」「选中列」（大模型上这两类差 200 ms）', JSON.stringify(mk1));
    NF.snapshot();
    const mk2 = NF.histMarks();
    log(mk2.dirty === false && mk2.wdirty === false && mk2.sdirty === false, '拍完一拍三个登记都清干净（要等下一次真写了才再变脏）', JSON.stringify(mk2));
    /* 再拍两拍、中间一列连接都不写：必须走「整张沿用、一个字节都不比」的近路。
       裁判模式会挡近路，所以这一小段先把它关掉，数一数近路真的走了几列。 */
    NF.histVerify(false);
    const f1 = NF.histMarks().fast;
    NF.snapshot();
    NF.snapshot();
    const f2 = NF.histMarks().fast;
    log(f2 >= f1 + 12, '没写过的连接列走的是「整张沿用」的近路（两拍 = 那几列各不扫两次）', '近路列数 ' + f1 + ' -> ' + f2);
    const pc0 = NF.histStats().perCol;
    let edgeCopied = 0;
    for (let k = 10; k < 18 && k < pc0.length; k++) edgeCopied += pc0[k].copied;   /* 10..15 连接列 + selN + selE */
    log(edgeCopied === 0, '最近一拍里连接那几列一共重拷 0 块（真没动它们）', '重拷 ' + edgeCopied + ' 块');
    NF.histVerify(true);
    /* 撤销必须逐位还原（位置 / 权重 / 颜色 / 接口都要对得上） */
    const grab = () => {
      const g = NF.graph(), a = [];
      for (let i = 0; i < Math.min(g.n, 400); i++) {
        const nd = NF.node(i);
        a.push(nd.x, nd.y, nd.z, nd.bias, nd.thr, nd.act, nd.io, nd.lock, nd.colOn, nd.col[0], nd.col[1], nd.col[2]);
      }
      for (let e = 0; e < g.e; e++) { const ed = NF.edge(e); a.push(ed.src, ed.dst, ed.w, ed.lock); }
      return a;
    };
    const gA = grab();
    NF.batchConnect('chain', { nodes: bigIds.slice(0, 80), axis: 1 });
    const gC = grab();
    log(gC.length !== gA.length, '链式连接确实改了图', gA.length + ' -> ' + gC.length);
    const undoBtn = document.querySelector('[data-cmd=undo]');
    undoBtn.click();
    await raf();
    const gB = grab();
    log(gB.length === gA.length && gB.every((v, i) => Object.is(v, gA[i])), '撤销后逐位还原', gA.length + ' 个数值');
    document.querySelector('[data-cmd=redo]').click();
    await raf();
    const gD = grab();
    log(gD.length === gC.length && gD.every((v, i) => Object.is(v, gC[i])), '重做后逐位还原', gC.length + ' 个数值');

    /* ---- 撤销的近路：拓扑没变就不重建邻接表（1681 万条边实测 ~135 ms） ----
       判据一旦判错，撤销之后邻接表就跟图对不上（度数 / 模拟激活全跟着错）而且看不出来，
       所以配了裁判 adjAudit()：按当前 eSrc / eDst 从头算一遍逐条比。 */
    NF.histVerify(false);
    const aq0 = NF.adjAudit();
    log(aq0.badStart === 0 && aq0.badList === 0 && aq0.count === aq0.e * 2,
        '邻接表跟图逐条对得上（基准）', JSON.stringify(aq0));
    const ask0 = NF.adjSkipStats().skips;
    NF.snapshot(); NF.setW(0, 0.85);
    NF.undo();
    const ask1 = NF.adjSkipStats().skips;
    log(ask1 === ask0 + 1, '只改权重的撤销跳过「重建邻接表」这一步', ask0 + ' -> ' + ask1);
    const aq1 = NF.adjAudit();
    log(aq1.badStart === 0 && aq1.badList === 0, '走完近路邻接表仍然逐条一致', JSON.stringify(aq1));
    const askA = NF.adjSkipStats().skips;
    NF.undo(); NF.undo(); NF.redo(); NF.redo(); NF.undo(); NF.undo();
    const askB = NF.adjSkipStats().skips;
    log(askB > askA, '重做 / 撤销来回走也一直走近路（这一趟 ' + (askB - askA) + ' 次）', askA + ' -> ' + askB);
    /* 真加一条边（拓扑变了）：那次撤销必须整张重建，重建完还得逐条对得上 */
    const ask2 = NF.adjSkipStats().skips;
    NF.snapshot();
    const at1 = NF.addNode(9000, 9000, 0), at2 = NF.addNode(9010, 9000, 0);
    NF.addEdge(at1, at2, 1.25);
    const ask3 = NF.adjSkipStats().skips;
    NF.undo();
    log(NF.adjSkipStats().skips === ask3, '加过边的撤销不走近路（照旧整张重建）',
        ask2 + ' -> ' + ask3 + ' -> ' + NF.adjSkipStats().skips);
    const aq2 = NF.adjAudit();
    log(aq2.badStart === 0 && aq2.badList === 0, '重建之后邻接表逐条一致', JSON.stringify(aq2));
    /* 删（压缩拓扑）那条路的撤销：不断言走哪条，只断言走完结果一定对 */
    NF.snapshot();
    const at3 = NF.addNode(9200, 9200, 0), at4 = NF.addNode(9210, 9200, 0);
    NF.addEdge(at3, at4, 0.9);
    NF.pruneOrphans(false);
    NF.undo();
    const aq3 = NF.adjAudit();
    log(aq3.badStart === 0 && aq3.badList === 0, '删孤立子图（压缩拓扑）撤销之后邻接表逐条一致', JSON.stringify(aq3));
    /* 选中连接的统计 / 取号走的是维护好的列表：跟逐位扫必须永远是一份 */
    const selA0 = NF.selListAudit();
    log(selA0.bad === 0 && selA0.list === selA0.scan, '选中连接列表跟逐位扫一致（空选择）', JSON.stringify(selA0));
    const epick = [];
    for (let e = 0; e < NF.graph().e && epick.length < 5; e += 7) epick.push(e);
    NF.select([], epick);
    const selA1 = NF.selListAudit();
    log(selA1.bad === 0 && selA1.list === epick.length && selA1.scan === epick.length,
        '选了若干连接后：统计数 / 取号 / 逐位扫三者一致', JSON.stringify(selA1));
    log(NF.stats().selEdges === epick.length, '状态栏那个「已选中连接」读的就是这份列表', String(NF.stats().selEdges));
    NF.select([], []);
    const selA2 = NF.selListAudit();
    log(selA2.list === 0 && selA2.scan === 0 && selA2.bad === 0, '清空选中后列表也清空', JSON.stringify(selA2));
    NF.histVerify(true);
    /* ---- 撤销的快路：只重抄「真动过的那几段边」 ----
       撤销以前一律 rebuildScene()：14 万个神经元实例重写一遍、1681 万条边整场抄进
       GPU 缓冲再整块传一次（269 MB）。改 5 条权重也要为这一下等好几帧。
       快路只认「只进 bigWriteEdge 那个打包字」的那几列（权重 / 边的选中 / 锁定 / 隐藏），
       靠逐个分块比对象身份把「动过的块」数出来 —— 判据错一次就会静默画错，
       所以这里用「快路之后 vs 整场重建之后，整个缓冲的校验和必须相等」来对拍。 */
    NF.histVerify(false);
    const bigSave = NF.bigState();
    NF.bigSet({ eMin: 1 });                       /* 小图也强制走大数据层，才测得到这条快路 */
    NF.forceRebuild();
    const bHashA = NF.bigBufHash();
    log(NF.bigState().on === true && bHashA !== null, '强制切到大数据层并建完',
        'e=' + NF.graph().e + ' built=' + NF.bigState().built);
    /* ① 只改权重：撤销走快路，结果必须跟整场重建一字不差 */
    const rfFast0 = NF.restoreFastStats();
    NF.snapshot(); NF.setW(0, 0.717); NF.setW(1, -0.42);
    NF.undo();
    const rfFast1 = NF.restoreFastStats();
    const bHashB = NF.bigBufHash();
    log(rfFast1.restores === rfFast0.restores + 1, '只改权重的撤销走了「只重抄动过的边」快路',
        rfFast0.restores + ' -> ' + rfFast1.restores);
    log(rfFast1.edges > 0 && rfFast1.edges < NF.graph().e, '快路只重抄了一小段，不是整场',
        rfFast1.edges + ' 条 / 全场 ' + NF.graph().e + ' 条');
    log((bHashB >>> 0) === (bHashA >>> 0), '快路撤销之后整个缓冲跟整场重建一字不差', bHashA + ' / ' + bHashB);
    NF.forceRebuild();
    log((NF.bigBufHash() >>> 0) === (bHashB >>> 0), '再整场重建一遍还是同一个校验和', String(NF.bigBufHash()));
    const rfSkip0 = NF.restoreFastStats();
    NF.snapshot(); NF.setW(2, 0.55); NF.undo();
    const rfSkip1 = NF.restoreFastStats();
    log(rfSkip1.skipChunks - rfSkip0.skipChunks > (rfSkip1.copyChunks - rfSkip0.copyChunks + 1) * 10,
        '还原时没动过的分块一个字节都不搬（只拷真变过的那几块）',
        '拷 ' + (rfSkip1.copyChunks - rfSkip0.copyChunks) + ' 块 / 跳过 ' + (rfSkip1.skipChunks - rfSkip0.skipChunks) + ' 块');
    /* 逐元素比换成了整数位比较（浮点 !== 带 NaN 语义，向量化不了，只有 1.3 GB/s）。
       这一改最怕的是「其实变了却判成没变」——那会让撤销静默回错一格，所以专门在
       任意位置改一笔权重再撤销，断言一位不差。 */
    const wProbeI = Math.max(0, Math.min(3000, NF.graph().e - 1));
    const wProbe0 = NF.edge(wProbeI).w;
    NF.snapshot(); NF.setW(wProbeI, 0.1234567); NF.undo();
    log(Object.is(NF.edge(wProbeI).w, wProbe0), '任意位置改一笔权重再撤销都一位不差（整数位比较不会吞改动）',
        '第 ' + wProbeI + ' 条：' + wProbe0 + ' -> ' + NF.edge(wProbeI).w);
    /* ② 改坐标 / 隐藏神经元：这两样烘在实例矩阵和打包字里，必须退回整场重建 */
    const rfFast2 = NF.restoreFastStats();
    NF.snapshot(); NF.setPos(3, 10, 20, 30); NF.flushPos(); NF.undo();
    log(NF.restoreFastStats().restores === rfFast2.restores, '改坐标的撤销不走快路（位置烘在实例矩阵里）',
        rfFast2.restores + ' -> ' + NF.restoreFastStats().restores);
    const rfFast3 = NF.restoreFastStats();
    NF.snapshot(); NF.setHidden([5], [], true); NF.undo();
    log(NF.restoreFastStats().restores === rfFast3.restores, '隐藏神经元的撤销不走快路（隐藏位也烘在边的打包字里）',
        rfFast3.restores + ' -> ' + NF.restoreFastStats().restores);
    /* ③ 隐藏一条连线：只进打包字，应该走快路，结果照样要对 */
    NF.forceRebuild();
    const bHashC = NF.bigBufHash();
    const rfFast4 = NF.restoreFastStats();
    NF.snapshot(); NF.setHidden([], [2], true); NF.undo();
    log(NF.restoreFastStats().restores === rfFast4.restores + 1, '隐藏连线的撤销走快路（只动打包字）',
        rfFast4.restores + ' -> ' + NF.restoreFastStats().restores);
    log((NF.bigBufHash() >>> 0) === (bHashC >>> 0), '隐藏连线撤销之后缓冲照样对得上', bHashC + ' / ' + NF.bigBufHash());
    /* ④ 选中一条连线再撤：选中位在同一个字里，也该走快路 */
    const bHashD = NF.bigBufHash();
    const rfFast5 = NF.restoreFastStats();
    NF.snapshot(); NF.select([], [4]); NF.undo();
    log(NF.restoreFastStats().restores === rfFast5.restores + 1, '只改选中连接的撤销也走快路');
    log((NF.bigBufHash() >>> 0) === (bHashD >>> 0), '选中之后撤销，缓冲照样对得上', bHashD + ' / ' + NF.bigBufHash());
    /* ⑥ 锁定 / 隐藏一条边不是拓扑改动：撤销要留着邻接表。
       以前这两样也把「边列脏了」那一支打上，撤销就白重建一遍三千多万个邻接项（实测 ~135 ms），
       是锁定 / 隐藏撤销里最大的一笔。判据放宽了，所以这里既断言「真的走近路」，
       也断言「走完邻接表照样逐条对得上」——放宽判据最怕的就是留下对不上的表。 */
    const askL0 = NF.adjSkipStats().skips;
    NF.snapshot(); NF.setEdgeLock([8], 1); NF.undo();
    log(NF.adjSkipStats().skips === askL0 + 1, '锁定连线的撤销留着邻接表（不算拓扑改动）',
        askL0 + ' -> ' + NF.adjSkipStats().skips);
    const aqL = NF.adjAudit();
    log(aqL.badStart === 0 && aqL.badList === 0, '锁定撤销之后邻接表逐条一致', JSON.stringify(aqL));
    const askH0 = NF.adjSkipStats().skips;
    NF.snapshot(); NF.setHidden([], [19], true); NF.undo();
    log(NF.adjSkipStats().skips === askH0 + 1, '隐藏连线的撤销也留着邻接表',
        askH0 + ' -> ' + NF.adjSkipStats().skips);
    /* 反过来：真加过一条边的撤销必须整张重建（放宽了判据也不能把真拓扑改动放过去） */
    const askT0 = NF.adjSkipStats().skips;
    NF.snapshot();
    const tA = NF.addNode(9300, 9300, 0), tB = NF.addNode(9310, 9300, 0);
    NF.addEdge(tA, tB, 0.5);
    NF.undo();
    log(NF.adjSkipStats().skips === askT0, '真加过边的撤销仍然整张重建邻接表',
        askT0 + ' -> ' + NF.adjSkipStats().skips);
    /* ⑤ 拧回去：大数据层的阈值 / 开关恢复原样（阈值一回去这一层就整个收起来，缓冲为 null，
       所以这里对的是开关状态，不是缓冲） */
    NF.bigSet({ eMin: bigSave.eMin });
    const bigNow = NF.bigState();
    log(bigNow.eMin === bigSave.eMin && bigNow.on === bigSave.on, '收尾：大数据层阈值 / 开关恢复原样',
        'eMin ' + bigSave.eMin + ' -> ' + bigNow.eMin + '，on ' + bigSave.on + ' -> ' + bigNow.on);


    /* ---- 24. 自动保存（本机 IndexedDB） ---- */
    log(NF.autosaveOn() === true, '自动保存默认开着', String(NF.autosaveOn()));
    NF.autosaveOn(false);
    log(NF.autosaveOn() === false, '可以关掉', String(NF.autosaveOn()));
    const as1 = await NF.autosaveNow();
    log(!!as1 && as1.ok === true && as1.bytes > 0, '立即自动保存成功', as1 && as1.ok ? as1.bytes + ' B' : JSON.stringify(as1));
    const asRec = await NF.autosaveProbe();
    log(!!asRec && asRec.bytes > 0, '本机备份读得回来', asRec ? asRec.bytes + ' B' : 'null');
    const gN0 = NF.graph().n, gE0 = NF.graph().e;
    NF.batchConnect('chain', { nodes: bigIds.slice(0, 200), axis: 0 });
    log(NF.graph().e !== gE0, '备份后又改动了图', gE0 + ' -> ' + NF.graph().e);
    const asRes = await NF.autosaveRestore();
    log(!!asRes && asRes.ok === true, '恢复自动保存成功', asRes ? (asRes.n + '/' + asRes.e) : JSON.stringify(asRes));
    log(NF.graph().n === gN0 && NF.graph().e === gE0, '恢复出来的规模跟备份时一致', NF.graph().n + '/' + NF.graph().e);
    const asDel = await NF.autosaveForget();
    log(asDel === true, '能删掉本机备份', String(asDel));
    log((await NF.autosaveProbe()) === null, '删掉之后探不到了');
    NF.autosaveOn(true);
    log(NF.autosaveOn() === true, '可以再打开', String(NF.autosaveOn()));


    /* ---- 25. 模块库：封装 / 实例化 ---- */
    NF.loadV2(blankDoc());
    NF.moduleClear();
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, blink: false, axis: 0 });
    /* 手工搭一块小子图：a -> b -> c，b 还额外收一条 a 的直连。
       两头各挂一个「外面」的神经元，专门用来验入口 / 出口的自动判定：
       外面的边不算模块内部连接，只把端点标成入口 / 出口。 */
    const m25in = NF.addNode(-10, 0, 0), m25out = NF.addNode(30, 0, 0);
    const ma = NF.addNode(0, 0, 0), mb = NF.addNode(10, 0, 0), mc = NF.addNode(20, 0, 0);
    NF.setW(NF.addEdge(m25in, ma, 0.3), 0.3);
    NF.setW(NF.addEdge(mc, m25out, 0.4), 0.4);
    NF.setW(NF.addEdge(ma, mb, 0.5), 0.5);
    NF.setW(NF.addEdge(mb, mc, -1.0), -1.0);
    NF.setW(NF.addEdge(ma, mc, 2.0), 2.0);
    NF.setAct(mb, 1);
    NF.setIO([m25in], 1);          /* 图本身的对外接口，编译器要它才知道输入输出张量 */
    NF.setIO([m25out], 2);
    NF.setIO([ma], 1);             /* ma 再额外标一个接口，用来验 keepIO 这个开关 */
    NF.select([ma, mb, mc], []);
    const wm = NF.wrapSelection('测试模块', false);
    log(wm.nodes === 3 && wm.edges === 3, '封装：神经元和内部连接都收进去了', wm.nodes + ' 节点 / ' + wm.edges + ' 连接');
    log(wm.entries === 1 && wm.exits === 1, '封装：入口 / 出口按跨界连接自动判定', '入口 ' + wm.entries + ' / 出口 ' + wm.exits);
    log(NF.modules().length === 1, '模块进了模块库', String(NF.modules().length));
    log(NF.moduleExport(wm.i).nodes.every((n) => n.io === 0), 'keepIO 关闭时接口标记不跟着进模块');
    const wm2 = NF.wrapSelection('带接口的模块', true);
    log(NF.moduleExport(wm2.i).nodes.some((n) => n.io === 1),
        'keepIO 打开时接口标记跟着进模块', JSON.stringify(NF.moduleExport(wm2.i).nodes.map((n) => n.io)));
    log(NF.moduleDrop(wm2.i) === '带接口的模块' && NF.modules().length === 1, '试完随手删掉，只剩 1 个模块');
    /* 实例化一份：应该多出 3 个神经元、3 条连接，而且权重逐条对得上 */
    const before25 = NF.graph();
    const put = NF.instantiate(0, {});
    const after25 = NF.graph();
    log(after25.n === before25.n + 3 && after25.e === before25.e + 3, '实例化：多出 3 个神经元 / 3 条连接',
        (after25.n - before25.n) + ' 个 / ' + (after25.e - before25.e) + ' 条');
    const m25base = put.nodes[0];
    log(m25base === before25.n, '实例化用的是「接着往后加」的 id', String(m25base));
    /* 相对坐标必须原样搬过来 */
    const rel = [1, 2].map((k) => NF.node(put.nodes[k]).x - NF.node(m25base).x);
    log(rel[0] === 10 && rel[1] === 20, '实例化：相对坐标保持不变', rel.join(' / '));
    /* 内部连接的权重也应该原样复制：找出新加的那几条边对一下 */
    const newW = [];
    for (let e = before25.e; e < after25.e; e++) newW.push(NF.edge(e).w);
    log(newW.indexOf(0.5) >= 0 && newW.indexOf(-1) >= 0 && newW.indexOf(2) >= 0, '实例化：权重逐条照搬', JSON.stringify(newW));
    log(NF.instantiate(0, { x: 100, y: 0, z: 0 }).nodes[0] === after25.n, '实例化：也能指定坐标放下（不动放置光标）');
    /* 导出 / 导入：整库往返后一模一样 */
    const dump = JSON.parse(JSON.stringify({ format: 'neuroforge-modules', version: 1, modules: [NF.moduleExport(0)] }));
    NF.moduleClear();
    log(NF.modules().length === 0, '清空模块库');
    log(NF.moduleImport(dump) === 1, '导入整库返回 1 个模块');
    const m25back = NF.modules()[0];
    log(m25back.nodes === 3 && m25back.edges === 3 && m25back.entries === 1 && m25back.exits === 1,
        '导入回来的模块跟导出前一致', m25back.nodes + '/' + m25back.edges + '/' + m25back.entries + '/' + m25back.exits);
    log(NF.moduleExport(0).name === '测试模块', '名字也带回来了', NF.moduleExport(0).name);
    /* 实例化出来的图必须能编译：模块只是编辑期的封装，对代码生成没有影响 */
    const mcomp = NF.compile('pytorch');
    log(mcomp.errors.length === 0 && mcomp.N >= 9, '封装出来的图照样能编译',
        mcomp.N + ' 神经元 / ' + mcomp.E + ' 连接 / 错误 ' + mcomp.errors.length + ' ' + mcomp.errors.join(' | '));
    NF.moduleDrop(0);
    log(NF.modules().length === 0, '能从模块库里删掉', String(NF.modules().length));
    /* ---- 26. 体检 / 剪枝 / 分组 / 书签 / 量化 / 直方图：这一轮加的东西 ----
       搭一张有讲究的小图：一条正经通路 + 一条只进不出的支路 + 一条死链（三节，
       中间那节才是有进有出的「死神经元」）+ 一条零权重。体检报告要能分别认出这几类，
       不然「清理」按钮就是在瞎猜。 */
    NF.loadV2(blankDoc());
    const m26in = NF.addNode(-20, 0, 0), m26out = NF.addNode(40, 0, 0);
    const m26a = NF.addNode(0, 0, 0), m26up = NF.addNode(0, -20, 0);
    const m26d0 = NF.addNode(0, 20, 0), m26d1 = NF.addNode(10, 20, 0), m26d2 = NF.addNode(20, 20, 0);
    NF.setIO([m26in], 1);
    NF.setIO([m26out], 2);
    NF.setW(NF.addEdge(m26in, m26a, 0.7), 0.7);
    NF.setW(NF.addEdge(m26a, m26out, 0), 0);
    NF.setW(NF.addEdge(m26in, m26up, 0.4), 0.4);
    NF.setW(NF.addEdge(m26d0, m26d1, 0.5), 0.5);
    NF.setW(NF.addEdge(m26d1, m26d2, 0.9), 0.9);
    const m26ins = NF.insight();
    log(m26ins.comps === 2 && m26ins.largest === 4, '体检：连通分量 2 块、最大一块 4 个',
        m26ins.comps + ' 块 / 最大 ' + m26ins.largest);
    log(m26ins.deadMid === 1 && m26ins.deadIds.indexOf(m26d1) >= 0,
        '体检：认出了死链里那个「有进有出却不在通路上」的神经元', JSON.stringify(m26ins.deadIds));
    log(m26ins.upOnly === 1 && m26ins.downOnly === 0, '体检：认出只进不出的那条支路',
        'upOnly ' + m26ins.upOnly + ' / downOnly ' + m26ins.downOnly);
    log(m26ins.zeroW === 1, '体检：数出了那条零权重连接', String(m26ins.zeroW));
    log(m26ins.compsWithoutIO.length === 1 && m26ins.compsWithoutIO[0] === 3,
        '体检：死链那整块跟输入输出都不连通', JSON.stringify(m26ins.compsWithoutIO));
    const m26an = NF.analyze();
    log(!!m26an.insight && m26an.warnings.join('|').indexOf('死神经元') >= 0,
        '校验报告里出现了死神经元这条警告', m26an.warnings.length + ' 条警告');
    /* 剪枝：dry 一个字节都不能改，真删要能撤销 */
    const m26dry = NF.pruneUnused(true);
    log(m26dry.total === 1 && m26dry.dead === 1 && NF.graph().n === 7 && NF.graph().e === 5,
        '清理无用神经元：dry 只报数不动手', JSON.stringify(m26dry));
    const m26odry = NF.pruneOrphans(true);
    log(m26odry.total === 3 && NF.graph().n === 7, '删无关子图：dry 只报数不动手', JSON.stringify(m26odry));
    NF.pruneUnused(false);
    log(NF.graph().n === 6 && NF.graph().e === 3, '清理无用神经元：死神经元连同它的两条边一起没了',
        NF.graph().n + '/' + NF.graph().e);
    NF.undo();
    log(NF.graph().n === 7 && NF.graph().e === 5, '清理可以撤销', NF.graph().n + '/' + NF.graph().e);
    NF.pruneOrphans(false);
    log(NF.graph().n === 4, '删无关子图：整块死链真的没了', String(NF.graph().n));
    NF.undo();
    log(NF.graph().n === 7, '删无关子图可以撤销', String(NF.graph().n));
    const m26bz = NF.pruneByWeight(0.001, 'zero', false);
    log(m26bz.changed === 1 && NF.graph().e === 5, '按阈值剪枝：归 0 只动权重，连接还在', JSON.stringify(m26bz));
    NF.undo();
    const m26bd = NF.pruneByWeight(0.001, 'drop', false);
    log(m26bd.changed === 1 && NF.graph().e === 4, '按阈值剪枝：删连接真的少一条', JSON.stringify(m26bd));
    NF.undo();
    log(NF.graph().e === 5, '剪枝都能撤销', String(NF.graph().e));
    /* 随机稀疏化：同种子剪两次，剩下的连接逐条相同 */
    const m26rand = (sd) => {
      NF.loadV2(blankDoc());
      NF.seed(sd);
      NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, blink: false, axis: 0 });
      const nb = NF.graph().n;
      NF.bulkPlace(6, 1, 1);
      const ids = [];
      for (let i = nb; i < NF.graph().n; i++) ids.push(i);
      NF.batchConnect('random', { nodes: ids, fan: 4 });
      const e0 = NF.graph().e;
      NF.pruneRandom(0.6, false);
      const kept = [];
      for (let e = 0; e < NF.graph().e; e++) { const g = NF.edge(e); kept.push(g.src + '>' + g.dst + '@' + g.w); }
      return { e0: e0, kept: kept };
    };
    const m26ra = m26rand(20250912), m26rb = m26rand(20250912);
    log(m26ra.e0 > 3 && m26ra.kept.length < m26ra.e0, '随机稀疏化：真的丢了连接',
        m26ra.e0 + ' -> ' + m26ra.kept.length);
    log(JSON.stringify(m26ra.kept) === JSON.stringify(m26rb.kept), '随机稀疏化：同种子剪两次逐条相同',
        m26ra.kept.length + ' 条');
    /* 分组：工程里的真实数据，进文件、进撤销栈 */
    NF.loadV2(blankDoc());
    const m26g0 = NF.addNode(0, 0, 0), m26g1 = NF.addNode(10, 0, 0), m26g2 = NF.addNode(20, 0, 0);
    NF.setGroup([m26g0, m26g2], '第一组');
    log(NF.groupOf(m26g0) === '第一组' && NF.groupOf(m26g2) === '第一组' && NF.groupOf(m26g1) === '',
        '分组：两个进组、一个没进', NF.groupOf(m26g0) + ' / ' + NF.groupOf(m26g1));
    log(NF.groups().indexOf('第一组') >= 0, '分组：组名写进了工程数据', JSON.stringify(NF.groups()));
    NF.undo();
    log(NF.groupOf(m26g0) === '', '分组跟着撤销退回去', JSON.stringify(NF.groupOf(m26g0)));
    NF.redo();
    log(NF.groupOf(m26g0) === '第一组', '重做又把分组带回来', NF.groupOf(m26g0));
    NF.setName(m26g1, '隐藏层A');
    log(NF.findNodes('隐藏', 'name').length === 1 && NF.findNodes('隐藏', 'name')[0] === m26g1,
        '按名称找得到', JSON.stringify(NF.findNodes('隐藏', 'name')));
    log(NF.findNodes('第一组', 'group').length === 2 && NF.findNodes('第一组', 'group').indexOf(m26g1) < 0,
        '按分组名找得到那两个', JSON.stringify(NF.findNodes('第一组', 'group')));
    log(NF.findNodes('0-1', 'id').length === 2, '按编号区间 0-1 找得到两个',
        JSON.stringify(NF.findNodes('0-1', 'id')));
    const m26dump = NF.serializeV2();
    NF.loadV2(blankDoc());
    NF.loadV2(m26dump);
    log(NF.groupOf(m26g0) === '第一组' && NF.groups().indexOf('第一组') >= 0,
        'v2 工程往返后分组还在', JSON.stringify(NF.groups()));
    const m26buf = await NF.encodeV3({});
    NF.loadV2(blankDoc());
    await NF.loadBuffer(m26buf);
    log(NF.groupOf(m26g2) === '第一组', 'v3 容器往返后分组还在', JSON.stringify(NF.groups()));
    /* 视角书签：存的是相机位置。用「跳回去再存一份、两份必须逐项一致」来自证。 */
    NF.setCam(10, 20, 30, 0, 0, 0);
    NF.saveView('自测视角');
    NF.setCam(200, 200, 200, 5, 5, 5);
    NF.gotoView('自测视角');
    NF.saveView('自测视角副本');
    const m26v1 = NF.views().filter((v) => v.name === '自测视角')[0];
    const m26v2 = NF.views().filter((v) => v.name === '自测视角副本')[0];
    log(!!m26v1 && !!m26v2 && m26v1.px === m26v2.px && m26v1.py === m26v2.py && m26v1.tz === m26v2.tz,
        '视角书签：跳回去的相机位置跟存的时候逐项一致', JSON.stringify([m26v1, m26v2]));
    log(NF.views().every((v) => typeof v.px === 'number') && NF.gotoView('没有这个书签') === false,
        '视角书签列得出来，跳不存在的书签如实返回 false', NF.views().length + ' 个');
    /* 滚轮缩放必须**自己**触发重绘。历史上的坑：OrbitControls 自己先 update() 把相机变化吃掉了，
       我们下一帧再 update() 返回 false，于是这一帧不画——"滚轮转了画面不动，动鼠标才跳过去"。 */
    NF.setCam(120, 90, 160, 0, 0, 0);
    await raf();
    const m26w0 = NF.renderProbe();
    const m26sp0 = NF.screenOfPoint(0, 20, 0);
    document.getElementById('c').dispatchEvent(new WheelEvent('wheel',
      { deltaY: -120, deltaMode: 0, cancelable: true, bubbles: true }));
    const m26wMid = NF.renderProbe();
    await raf();
    const m26w1 = NF.renderProbe();
    const m26sp1 = NF.screenOfPoint(0, 20, 0);
    log(m26w1.dist < m26w0.dist - 1, '滚轮往前滚：相机距离真的变近了',
        m26w0.dist.toFixed(1) + ' → ' + m26w1.dist.toFixed(1));
    log(m26w1.frames > m26w0.frames, '滚轮缩放自己就会触发重绘（不用等鼠标动一下）',
        '第 ' + m26w0.frames + ' 帧 → 第 ' + m26w1.frames + ' 帧');
    log(m26wMid.camValid === false && m26wMid.pending === true,
        '滚轮那一刻：屏幕坐标缓存作废、这一帧已经排上（不然缩放过悬停会挑错神经元）',
        'camValid=' + m26wMid.camValid + ' pending=' + m26wMid.pending);
    log(Math.abs(m26sp1.x - m26sp0.x) + Math.abs(m26sp1.y - m26sp0.y) > 0.5,
        '缩放过以后投影坐标跟着变（相机真动了；取的是偏离注视中心的点，注视中心本来就不会动）',
        JSON.stringify([m26sp0, m26sp1]));
    NF.setCam(78, 62, 104, 0, 4, 0);
    /* ---- 相机：上下左右平移 / 以选中为中心 / 聚焦不再只会看原点 ---- */
    NF.loadV2(blankDoc());
    const camN = [NF.addNode(0, 0, 0), NF.addNode(100, 0, 0), NF.addNode(200, 0, 0), NF.addNode(300, 0, 0)];
    const camE = NF.addEdge(camN[2], camN[3], 0.5);
    NF.select([], []);
    NF.setCam(60, 40, 80, 0, 0, 0);
    await raf();
    const ca0 = NF.camState();
    NF.camPan(1, 0, true);
    await raf();
    const ca1 = NF.camState();
    const dirOf = (c) => [c.pos[0] - c.target[0], c.pos[1] - c.target[1], c.pos[2] - c.target[2]].map((v) => v / c.dist);
    const cd0 = dirOf(ca0), cd1 = dirOf(ca1);
    const shifted = Math.hypot(ca1.target[0] - ca0.target[0], ca1.target[1] - ca0.target[1], ca1.target[2] - ca0.target[2]);
    log(Math.abs(ca0.dist - ca1.dist) < 1e-6 &&
        Math.abs(cd0[0] - cd1[0]) + Math.abs(cd0[1] - cd1[1]) + Math.abs(cd0[2] - cd1[2]) < 1e-6,
        '平移：注视点和相机一起挪，视距和朝向都不变',
        '视距 ' + ca0.dist.toFixed(2) + ' → ' + ca1.dist.toFixed(2));
    log(Math.abs(shifted - ca0.dist * 0.16) < ca0.dist * 0.01,
        '平移一步 = 视距的 16%（Shift 大步），跟当前缩放档位对得上',
        '挪了 ' + shifted.toFixed(1) + '，步长 ' + (ca0.dist * 0.16).toFixed(1));
    /* 以选中为中心：只换注视点 */
    NF.select([camN[0]], []);
    await raf();
    const cBefore = NF.camState();
    NF.camCenter();
    await raf();
    const cAfter = NF.camState();
    log(Math.abs(cAfter.target[0]) < 1e-6 && Math.abs(cAfter.target[1]) < 1e-6 && Math.abs(cAfter.target[2]) < 1e-6 &&
        Math.abs(cAfter.dist - cBefore.dist) < 1e-6,
        '选中神经元后「以选中为中心」：注视点搬到它身上，视距一点没变（之后旋转就绕它）',
        JSON.stringify(cAfter.target.map((v) => +v.toFixed(2))) + ' 视距 ' + cAfter.dist.toFixed(2));
    /* 只选连线：聚焦要框住这条连线，而不是回原点 */
    NF.select([], [camE]);
    await raf();
    NF.camFocus();
    await raf();
    const cEdge = NF.camState();
    log(Math.abs(cEdge.target[0] - 250) < 1e-6 && Math.abs(cEdge.target[1]) < 1e-6,
        '只选连线时「聚焦」：中心落在连线两端点之间（不再当"没选中"回原点）',
        JSON.stringify(cEdge.target.map((v) => +v.toFixed(1))));
    /* 什么都没选：聚焦 = 框整张图（全图中心），不是 HOME 的原点 */
    NF.select([], []);
    await raf();
    NF.camFocus();
    await raf();
    const cAll = NF.camState();
    log(Math.abs(cAll.target[0] - 150) < 1e-6 && Math.abs(cAll.target[1]) < 1e-6,
        '什么都没选时「聚焦」= 框住整张图（中心是全图中心，不再跳回原点）',
        JSON.stringify(cAll.target.map((v) => +v.toFixed(1))));
    /* 跟随开关：打开后换个选择，注视点自己跟过去 */
    NF.camFollow(true);
    await raf();
    NF.select([camN[3]], []);
    await raf(); await raf();
    const cFollow = NF.camState();
    log(cFollow.follow === true && Math.abs(cFollow.target[0] - 300) < 1e-6,
        '「选中就换旋转中心」打开后：换一次选择，注视点自动跟过去',
        JSON.stringify(cFollow.target.map((v) => +v.toFixed(1))));
    NF.camFollow(false);
    NF.select([], []);
    /* ---- 平滑平移：按住 = 持续滑行，不是一格一格跳 ----
       历史问题：方向键一按就跳一步（4%），按住时靠系统键盘重复驱动，肉眼看就是一格一格。
       现在改成了速度模型，这里逐帧手动推进（panAuto(false)），不受真实帧率影响。 */
    NF.setCam(60, 40, 80, 0, 0, 0);
    await raf();
    NF.panAuto(false);
    const panS0 = NF.camState();
    const panD = panS0.dist, panP0 = panS0.pos;
    NF.camPanHold(1, 0, true, false);
    const panSteps = [];
    for (let i = 0; i < 12; i++) panSteps.push(NF.camPanFrame(16));
    const panS1 = NF.camState();
    const panMove = Math.hypot(panS1.pos[0] - panP0[0], panS1.pos[1] - panP0[1], panS1.pos[2] - panP0[2]);
    const panSum = panSteps.reduce((a, b) => a + b, 0);
    const panMax = Math.max.apply(null, panSteps);
    log(Math.abs(panMove - panSum) < 1e-6 && panMax < panD * 0.025 && panMove > panD * 0.03,
        '按住方向键 0.2 秒是一路小步走（每帧都小于视距的 2.5%），不是一按一大格',
        '12 帧共走 ' + (panMove / panD * 100).toFixed(1) + '%，最大一帧 ' + (panMax / panD * 100).toFixed(2) + '%');
    log(panSteps[0] < panSteps[11] * 0.85 && Math.abs(panSteps[11] - panSteps[10]) < panSteps[11] * 0.15,
        '起步是加速的，随后趋于匀速（相邻帧几乎一样大，所以看不出「格」）',
        '第 1 帧 ' + (panSteps[0] / panD * 100).toFixed(2) + '% → 第 12 帧 ' + (panSteps[11] / panD * 100).toFixed(2) + '%');
    log(Math.abs(panS1.dist - panD) < 1e-6,
        '滑行过程中视距一点没变（挪的是注视点和相机，不动缩放）',
        panD.toFixed(2) + ' → ' + panS1.dist.toFixed(2));
    /* 松手：还会滑一小段再停 */
    NF.camPanHold(1, 0, false, false);
    const panG1 = NF.camPanFrame(16);
    let panGlide = panG1, panFrames = 1;
    for (let i = 0; i < 80 && NF.panState().active; i++) { panGlide += NF.camPanFrame(16); panFrames++; }
    log(panG1 > 0 && panG1 < panSteps[11] && !NF.panState().active && panGlide < panD * 0.09,
        '松手后还会滑一小段再停下（缓停），不是硬刹车',
        '又滑了 ' + (panGlide / panD * 100).toFixed(1) + '% 视距 / ' + panFrames + ' 帧后归零');
    /* 同样按住 12 帧：Shift = 约 4 倍；斜着按不该更快 */
    const panRun = (dx, dy, big) => {
      NF.setCam(60, 40, 80, 0, 0, 0);
      const p = NF.camState().pos;
      NF.camPanHold(dx, dy, true, big);
      for (let i = 0; i < 12; i++) NF.camPanFrame(16);
      const q = NF.camState().pos;
      NF.camPanHold(dx, dy, false, false);
      for (let i = 0; i < 80 && NF.panState().active; i++) NF.camPanFrame(16);
      return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    };
    const panShift = panRun(1, 0, true);
    log(panShift > panMove * 3.4 && panShift < panMove * 4.6,
        'Shift + 方向键 = 大步：同样按住 0.2 秒，位移约 4 倍（同样是滑行，不是跳）',
        (panMove / panD * 100).toFixed(1) + '% → ' + (panShift / panD * 100).toFixed(1) + '%');
    const panDiag = panRun(1, 1, false);
    log(panDiag > panMove * 0.85 && panDiag < panMove * 1.15,
        '斜着按（右 + 上）不会比单向更快',
        (panDiag / panD * 100).toFixed(1) + '% vs ' + (panMove / panD * 100).toFixed(1) + '%');
    NF.panAuto(true);
    /* ---- 镜头对着空白：提示 + 一键找回 ----
       用户报的"视角移到某些角度后全黑"就是这个：旋转中心默认在世界原点，图一大、又不在原点附近，
       绕着原点一转就有很多角度里一个神经元都没有。这里量的是"视野里到底有多少东西"。 */
    NF.loadV2(blankDoc());
    NF.setPlacement({ x: 1500, y: 0, z: 0, step: 40, blink: false, axis: 0 });
    NF.bulkPlace(12, 12, 1);
    await raf();
    NF.setCam(270, 603, -133, 260, 551, -555);
    await raf();
    const vb = NF.graphBounds();
    const vf0 = NF.viewFill();
    const vh0 = NF.voidHint();
    const vAway = document.getElementById('vh-away').textContent;
    log(vf0.nodes === 0 && vh0.shown === true && vAway.length > 0,
        '镜头对着空白时：视野内如实报 0 个，并浮出提示（告诉用户模型在屏幕哪边）',
        '视野内 ' + vf0.nodes + ' 个，提示 ' + JSON.stringify(vh0) + ' 箭头 ' + vAway);
    const vDist = parseFloat(document.getElementById('vh-dist').textContent.replace(/,/g, ''));
    const v真 = Math.hypot(270 - vb.cx, 603 - vb.cy, -133 - vb.cz);
    log(Math.abs(vDist - v真) < 30,
        '提示里的"多远"是镜头到图中心的真实距离，不是编的',
        '提示 ' + vDist + ' / 实际 ' + v真.toFixed(0));
    document.getElementById('vh-focus').click();
    await raf();
    const vf1 = NF.viewFill();
    log(NF.voidHint().shown === false && vf1.nodes > 0,
        '提示里点「框住整张图」：图立刻回到视野里，提示自己收掉',
        '视野内 ' + vf0.nodes + ' → ' + vf1.nodes + ' 个');
    /* 重置视角 = 框住整张图（图不在原点时，回到 HOME 等于回到空镜头） */
    NF.setCam(270, 603, -133, 260, 551, -555);
    await raf();
    NF.resetView();
    await raf();
    const vc = NF.camState();
    log(Math.abs(vc.target[0] - vb.cx) < 1e-6 && Math.abs(vc.target[1] - vb.cy) < 1e-6 &&
        Math.abs(vc.target[2] - vb.cz) < 1e-6 && NF.viewFill().nodes > 0 && NF.voidHint().shown === false,
        '「重置视角」在图非空时 = 用初始角度重新框住整张图（不再回到原点那个空镜头）',
        '注视点 ' + JSON.stringify(vc.target.map((v) => Math.round(v))));
    NF.loadV2(blankDoc());
    log(NF.resetView() === false && Math.abs(NF.camState().target[1] - 4) < 1e-6,
        '图是空的时候，「重置视角」还是老老实实回初始机位',
        JSON.stringify(NF.camState().target.map((v) => +v.toFixed(1))));
    /* 相机在图内部、只是背对：不该弹提示（刻意拉近看某个神经元是正常操作） */
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 40, blink: false, axis: 0 });
    NF.bulkPlace(12, 12, 1);
    await raf();
    const ib = NF.graphBounds();
    NF.setCam(ib.cx, ib.cy, ib.cz, ib.cx + 400, ib.cy + 900, ib.cz);
    await raf();
    log(NF.voidHint().shown === false,
        '相机在图里（哪怕正好背对）不打扰：只有真的跑到图外面才提醒',
        '相机在包围盒内，shown=' + NF.voidHint().shown);
    /* ---- 雾 / 远裁剪面 / 背景色：用户报的"画面移到某些位置就全黑、像被什么东西挡住了" ----
       根子是三条写死的参数：雾 far=1400、远裁剪面 6000、清屏纯黑（≠雾色）。
       模型一摊开或者镜头一推远，整片越过界线被涂成背景色；清屏色又跟雾色不同，
       于是"被雾吃掉"的那一片在画面上是一块看得见的暗色方块。 */
    NF.loadV2(blankDoc());
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 30, blink: false, axis: 0 });
    NF.bulkPlace(16, 16, 4);
    await raf();
    const fxB = NF.graphBounds();
    const frameAt = async (d) => {
      NF.setCam(fxB.cx + d * 0.62, fxB.cy + d * 0.5, fxB.cz + d * 0.6, fxB.cx, fxB.cy, fxB.cz);
      await raf(); await raf();
      const px = NF.grabFrame();
      let ink = 0, bg = 0; const hist = new Map();
      for (let i = 0; i < px.length; i += 4) {
        const k = px[i] + ',' + px[i + 1] + ',' + px[i + 2];
        hist.set(k, (hist.get(k) || 0) + 1);
        if (k === '8,11,16') bg++; else ink++;
      }
      let mode = '', mc = -1;
      for (const e of hist) if (e[1] > mc) { mc = e[1]; mode = e[0]; }
      const q = NF.camState().pos;
      return { ink: ink, bg: bg, mode: mode, fill: NF.viewFill().nodes, fog: NF.fogState(),
               far: NF.camFar(), dist: Math.round(Math.hypot(q[0] - fxB.cx, q[1] - fxB.cy, q[2] - fxB.cz)) };
    };
    const fxNear = await frameAt(fxB.r * 0.6);
    const fxMid = await frameAt(fxB.span);
    const fxFar = await frameAt(fxB.span * 3.2);
    log(fxNear.ink > 1000 && fxMid.ink > 200 && fxFar.ink > 50,
        '镜头推到 0.6 / 1 / 3.2 倍图跨度：画面里一直有东西，不会整片黑掉',
        fxNear.dist + '→' + fxNear.ink + ' / ' + fxMid.dist + '→' + fxMid.ink + ' / ' + fxFar.dist + '→' + fxFar.ink);
    log(fxFar.fog.auto === true && fxFar.fog.far > fxMid.fog.far && fxMid.fog.far > fxNear.fog.far &&
        fxFar.far > fxNear.far,
        '雾的远近和相机远裁剪面跟着视距一起长大（不再是写死的 320/1400 和 6000）',
        '雾 far ' + Math.round(fxNear.fog.far) + '→' + Math.round(fxMid.fog.far) + '→' + Math.round(fxFar.fog.far) +
        '，裁剪面 ' + Math.round(fxNear.far) + '→' + Math.round(fxFar.far));
    log(fxFar.far >= fxFar.dist + fxB.r && fxNear.far >= fxNear.dist,
        '远裁剪面永远比"最远的那个神经元"还远（模型不会整片被裁掉）',
        '裁剪面 ' + Math.round(fxFar.far) + ' ≥ 相机到最远一侧 ' + Math.round(fxFar.dist + fxB.r));
    const fch = NF.fogColorHex();
    log(fxFar.mode === ((fch >> 16 & 255) + ',' + (fch >> 8 & 255) + ',' + (fch & 255)),
        '视口背景色 = 雾色：被雾吃掉的那一片跟真空背景分不出来（不再是一块看得见的暗墙）',
        '画面里最多的颜色 ' + fxFar.mode + '，雾色 #' + fch.toString(16).padStart(6, '0'));
    /* 对照：把雾换回写死的老参数，同一个机位立刻"什么都没有"——这就是用户报的那一帧 */
    NF.fog(true, 320, 1400);
    const fxOld = await frameAt(fxB.span * 3.2);
    NF.fog(true);
    log(fxOld.ink <= Math.max(20, fxFar.ink / 5),
        '对照：雾换回写死的 320/1400，同一个机位马上变成一片空（这就是用户看到的那一帧）',
        '老参数非背景像素 ' + fxOld.ink + '，现在 ' + fxFar.ink);
    NF.fog(false); await raf();
    const fogOff = NF.fogState();
    NF.fog(true); await raf();
    const fogOn = NF.fogState();
    log(fogOff.on === false && fogOn.on === true && fogOn.auto === true,
        '雾能一键关掉再打开（关掉之后是真空背景，不会再有任何"雾墙"）',
        '关掉 ' + JSON.stringify(fogOff) + ' → 打开 ' + JSON.stringify(fogOn));
    /* ---- 权重块板子贴到镜头前 = 一堵墙：整屏热力图，神经元一个都看不见 ----
       板子永远正对相机（billboard），走到跟前时它比整个视野还大。
       现在按"占几屏"淡出、占满就收掉；下面用关掉淡出做 A/B，像素级证明。 */
    NF.loadV2(blankDoc());
    const pwS = [], pwD = [];
    for (let i = 0; i < 12; i++) pwS.push(NF.addNode(i * 4, 0, 0));
    for (let j = 0; j < 12; j++) pwD.push(NF.addNode(j * 4, 40, 0));
    const pwW = new Array(144);
    for (let i = 0; i < 144; i++) pwW[i] = 0.01 + 0.4 * ((i * 13) % 7) / 7;
    const pwId = NF.addBlock(pwS, pwD, pwW, { label: '贴脸墙' });
    await raf();
    const pwB = NF.graphBounds();
    const plateAt = async (d) => {
      NF.setCam(pwB.cx, pwB.cy, pwB.cz + d, pwB.cx, pwB.cy, pwB.cz);
      await raf(); await raf();
      const px = NF.grabFrame();
      let bg = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] === 8 && px[i + 1] === 11 && px[i + 2] === 16) bg++;
      const v = NF.blockView(pwId);
      return { d: Math.round(d), fill: v.screenFill, op: v.opacity, visible: v.visible, bg: bg, all: px.length / 4 };
    };
    const plFar = await plateAt(pwB.span * 3);
    const plNear = await plateAt(Math.max(5, pwB.span * 0.18));
    const plMid = await plateAt(Math.max(9, pwB.span * 0.5));
    log(plFar.fill < plMid.fill && plMid.fill < plNear.fill,
        '板子"占几屏"随镜头靠近单调变大（判据本身可查）',
        plFar.fill.toFixed(2) + ' → ' + plMid.fill.toFixed(2) + ' → ' + plNear.fill.toFixed(1) + ' 屏');
    log(plFar.visible === true && plFar.op > 0.99, '离得远：板子照常不透明地画（不影响正常查看）',
        '占屏 ' + plFar.fill.toFixed(2) + '，不透明度 ' + plFar.op.toFixed(2));
    log(plNear.visible === false && plNear.op <= 0.002, '贴到跟前：板子收掉，不再糊住整个画面',
        '占屏 ' + plNear.fill.toFixed(1) + '，visible=' + plNear.visible + '，不透明度 ' + plNear.op.toFixed(2));
    NF.plateFade(false);                       /* 关掉淡出 = 老行为，做像素级对照 */
    const plOld = await plateAt(Math.max(5, pwB.span * 0.18));
    NF.plateFade(true);
    log(plOld.bg < plOld.all * 0.02 && plNear.bg > plNear.all * 0.2,
        '对照：老行为下这个机位满屏都是热力图（背景像素≈0），现在能看见背后的东西',
        '老行为背景 ' + (plOld.bg / plOld.all * 100).toFixed(1) + '% → 现在 ' + (plNear.bg / plNear.all * 100).toFixed(1) + '%');

    /* 第二视口：跟主画面共用一台渲染器，只是画第二遍 */
    log(!!NF.view2('top') && NF.view2State().mode === 'top' && NF.view2State().on === true,
        '第二视口能开到顶视图', JSON.stringify(NF.view2State()));
    NF.view2('off');
    log(NF.view2State().on === false, '第二视口能关掉', JSON.stringify(NF.view2State()));
    /* 能编译的图：量化导出 + 直方图都在这张图上验 */
    NF.loadV2(blankDoc());
    const m26qi = NF.addNode(0, 0, 0), m26qo = NF.addNode(20, 0, 0);
    NF.setIO([m26qi], 1);
    NF.setIO([m26qo], 2);
    NF.setW(NF.addEdge(m26qi, m26qo, 0.5), 0.5);
    const m26q = NF.artifacts('pytorch', { quant: true });
    const m26pyOn = m26q.files.filter((f) => f.name === 'hand_built_net.py')[0].text;
    log(m26pyOn.indexOf('def export_int8') >= 0 && m26pyOn.indexOf('--quantize-int8') >= 0,
        '量化导出：生成的 .py 里有 int8 那套函数和命令行开关', m26pyOn.length + ' 字符');
    const m26pyOff = NF.artifacts('pytorch', { quant: false }).files
        .filter((f) => f.name === 'hand_built_net.py')[0].text;
    log(m26pyOff.indexOf('def export_int8') < 0, '不勾量化就不会多出那些函数');
    const m26d = NF.dist('weight', 16, false);
    log(m26d.total === 1 && m26d.nbins === 16 && m26d.bins.length === 16,
        '权重直方图：扫出的条数和分箱数都对', JSON.stringify({ total: m26d.total, nbins: m26d.nbins }));
    log(Math.abs(m26d.max - 0.5) < 1e-9 && Math.abs(m26d.min - 0.5) < 1e-9,
        '权重直方图：极值就是那条 0.5', m26d.min + ' ~ ' + m26d.max);
    const m26dd = NF.dist('degree', 8, false);
    log(m26dd.total === 2 && m26dd.max === 1 && m26dd.min === 1,
        '连接数分布：两个神经元各 1 度', JSON.stringify({ t: m26dd.total, min: m26dd.min, max: m26dd.max }));
    log(m26dd.sum === 2 * NF.graph().e, '连接数分布：度之和正好是连接数的两倍', String(m26dd.sum));
    /* 面板上那两段统计文本是拼出来的 HTML，最容易出一个 undefined 就整块炸掉，
       所以直接生成一遍：既要求有关键行，也要求一个字面量 undefined 都不许出现。 */
    const m26sumW = NF.distSummary('weight', 16, false);
    log(m26sumW.indexOf('连接条数') >= 0 && m26sumW.indexOf('权重集中度') >= 0 && m26sumW.indexOf('undefined') < 0,
        '权重视图的统计文本能生成', m26sumW.slice(0, 46));
    const m26sumD = NF.distSummary('degree', 16, false);
    log(m26sumD.indexOf('度之和') >= 0 && m26sumD.indexOf('孤立点') >= 0 && m26sumD.indexOf('undefined') < 0,
        '连接数视图的统计文本能生成，且一个 undefined 都没有', m26sumD.slice(0, 46));
    /* 真一点的图：链式连接，然后在直方图上按区间剪一刀 */
    NF.loadV2(blankDoc());
    NF.seed(31337);
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, blink: false, axis: 0 });
    const m26nb = NF.graph().n;
    NF.bulkPlace(6, 1, 1);
    const m26ids = [];
    for (let i = m26nb; i < NF.graph().n; i++) m26ids.push(i);
    NF.setIO([m26ids[0]], 1);
    NF.setIO([m26ids[5]], 2);
    NF.batchConnect('chain', { nodes: m26ids, axis: 0 });
    const m26e0 = NF.graph().e;
    const m26big = NF.dist('weight', 32, false);
    log(m26big.total === m26e0 && m26big.top1 > 0 && m26big.top1 <= 1,
        '权重直方图：真图上条数对得上，权重集中度落在 (0,1]',
        m26big.total + ' 条 / top1 ' + m26big.top1);
    const m26pick = NF.distPick('weight', 32, false, 31, 31);
    log(m26pick.length >= 1 && m26pick.indexOf(-1) < 0, '直方图：能按箱号捞出连接下标',
        JSON.stringify(m26pick));
    const m26drop = NF.distPrune('weight', 32, false, 31, 31, 'drop');
    log(m26drop.changed >= 1 && NF.graph().e === m26e0 - m26drop.changed,
        '直方图区间剪枝：删掉最高那一箱里的连接', JSON.stringify(m26drop));
    NF.undo();
    log(NF.graph().e === m26e0, '直方图剪枝也能撤销', String(NF.graph().e));
    /* 能截画面（AI 看画面的底子）+ AI 手里真的有这些新工具 */
    /* 截图前先框住整图：旋转中心现在会跟着选择走，不能再指望碰巧还停在原点附近 */
    NF.camFocus();
    await raf();
    const m26shot = NF.shot(64);
    const m26px = await shotInk(m26shot);
    log(typeof m26shot === 'string' && m26shot.indexOf('data:image') === 0 && m26px.ok && m26px.ink > 30,
        '能截当前画面（AI 看画面的底子）：解码回来图里真的有东西',
        'dataURL ' + (m26shot ? m26shot.length : 0) + ' 字节，' + m26px.w + '×' + m26px.h + '，非底色像素 ' + m26px.ink);
    /* 这一组的前提是「没填 Key」。壳子里跑的时候，上面那段刚把用户的真 Key 放回来过，
       所以这里先明确清掉一次，让前提真的成立；验完立刻就放回去（整段收尾还会再兜一次）。 */
    NF.aiConfig({ key: '' });
    const m26vis0 = NF.aiVis();
    log(m26vis0.ready === false && m26vis0.mode === null, '没填 Key 时，AI 看画面明确是「发不出去」而不是假装看了',
        JSON.stringify(m26vis0));
    /* 视觉那组留空 = 直接用主接口：DeepSeek 的 deepseek-flash 本身就收图，一个 Key 够用 */
    log(NF.aiState().model === 'deepseek-flash', '默认模型是能看图的 deepseek-flash', NF.aiState().model);
    NF.aiConfig({ key: 'sk-selftest' });
    const m26vis1 = NF.aiVis();
    log(m26vis1.ready === true && m26vis1.mode === 'main' && m26vis1.model === 'deepseek-flash' && m26vis1.own === false,
        '视觉那组留空时，看图直接走主接口（不用配第二套）', JSON.stringify(m26vis1));
    NF.aiConfig({ visBase: 'https://example.com/v1/chat/completions', visModel: 'gpt-4o' });
    const m26vis2 = NF.aiVis();
    log(m26vis2.ready === true && m26vis2.mode === 'own' && m26vis2.model === 'gpt-4o',
        '单独填了视觉端点时，只看画面用它，文本对话还是走主接口', JSON.stringify(m26vis2));
    NF.aiConfig({ visBase: '', visModel: '', key: '' });
    log(NF.aiVis().ready === false, '视觉与 Key 都清掉后又回到「发不出去」', String(NF.aiVis().ready));
    /* 旧模型名（deepseek-chat / deepseek-reasoner）已经不在官方定价表里，读配置时要自动挪到 flash */
    try { localStorage.setItem('nf.ai', JSON.stringify({ key: 'sk-x', model: 'deepseek-chat' })); } catch (e) {}
    log(NF.aiReloadCfg().model === 'deepseek-flash', '旧模型名 deepseek-chat 读配置时自动挪到 deepseek-flash',
        NF.aiState().model);
    NF.aiConfig({ key: '' });
    if (KEEP19.key) NF.aiConfig({ key: KEEP19.key });   /* 验完立刻把用户的 Key 放回去 */
    const m26tools = NF.aiTools().map((t) => t.name);
    log(m26tools.indexOf('distribution') >= 0 && m26tools.indexOf('insight') >= 0 &&
        m26tools.indexOf('prune') >= 0 && m26tools.indexOf('see_screen') >= 0,
        'AI 工具表里有 insight / prune / distribution / see_screen', m26tools.length + ' 个工具');
    log(NF.aiCommands().indexOf('dist') >= 0 && NF.aiManual().indexOf('权重直方图') >= 0,
        'AI 手册和菜单命令表都更新了');

    /* ---- 27. 权重块也在撤销里：块权重是写时复制的 ----
       块的权重矩阵是原地改的（剪枝归零），而历史快照里的块对象是共享的。
       所以动权重之前必须先把数组换成一个私有副本，否则撤销回去看到的是
       同一个数组的最新内容——那就等于「剪枝块权重撤不回来」。 */
    NF.loadV2(blankDoc());
    for (let i = 0; i < 6; i++) NF.addNode(i * 10, 0, 0);
    /* 权重存的是 float32，字面量 0.4 存进去就不是 0.4 了，所以基准值先过一遍 Float32Array */
    const m27w0 = Array.from(Float32Array.from([0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.001]));
    const m27id = NF.addBlock([0, 1, 2], [3, 4, 5], m27w0);
    const m27same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    log(NF.blocksInfo().length === 1 && NF.blockTotal() === 9, '块权重：3×3 的块建好了', JSON.stringify(NF.blocksInfo()));
    log(m27same(NF.blockWeights(m27id), m27w0), '块权重：读回来的就是写进去的那 9 个数',
        JSON.stringify(NF.blockWeights(m27id).slice(0, 3)));
    const m27r = NF.pruneByWeight(0.15, 'zero', true);
    const m27after = NF.blockWeights(m27id);
    log(m27r.blkW === 5, '剪枝：3×3 里有 5 个权重小于 0.15，被归零', JSON.stringify(m27r));
    log(m27after.filter((v) => v === 0).length === 5, '剪枝：归零确实写进了块权重', JSON.stringify(m27after));
    NF.undo();
    const m27undo = NF.blockWeights(m27id);
    log(m27same(m27undo, m27w0), '剪枝块权重之后撤销，块权重逐位回到原值',
        JSON.stringify(m27undo));
    log(NF.blocksInfo().length === 1 && !!NF.blockView(m27id) && NF.blockViewStats().drawn === 1,
        '撤销回来块还在、板子也还在（没有幽灵板）', JSON.stringify(NF.blockViewStats()));
    NF.redo();
    log(m27same(NF.blockWeights(m27id), m27after), '重做之后块权重又回到剪枝后的值',
        JSON.stringify(NF.blockWeights(m27id)));
    const m27hs = NF.histStats();
    log(m27hs.blkBytes > 0 && m27hs.bytes >= m27hs.blkBytes,
        '历史占用把块权重也算进去了',
        JSON.stringify({ bytes: m27hs.bytes, blkBytes: m27hs.blkBytes, steps: m27hs.steps }));
    log(m27hs.blkBytes <= 9 * 4 * 3, '块权重的历史占用只跟「存了几个版本」有关，不按格数翻倍',
        m27hs.blkBytes + ' 字节（9 个权重 = 36 字节一个版本）');
    log(m27hs.naive >= 9 * 4, '不做共享的对比数字里也算上了块权重', m27hs.naive + ' 字节');
    log(m27hs.perCol.length === 18, '历史里注册的列数是 18', m27hs.perCol.length + ' 列');
    /* 面板的列名表必须跟真正注册的 18 列一一对上：删掉后面那句就会错位，
       错位以后「权重」那行显示的是别的列，看数字会看错列。 */
    document.querySelector('[data-cmd=hist]').click();
    const m27body = document.getElementById('dlgbody');
    const m27txt = m27body ? m27body.textContent : '';
    log(!!m27body && m27txt.indexOf('分组') >= 0 && m27txt.indexOf('列 17') < 0 && m27txt.indexOf('列 16') < 0,
        '历史面板 18 列每列都有名字（没有一列退化成「列 N」）', m27txt.slice(0, 70));

    /* ---- 28. 名称表：也走分块 + 结构共享
       以前每拍一格快照就 new Map(nName) 整份拷一遍——12 万个名字的工程里，
       改一条权重也要多拷约 1.8 MB，而且这块内存历史面板根本看不见。 */
    NF.loadV2(blankDoc());
    NF.bulkPlace(2000, 3, 1);                      /* 6000 个神经元 = 6 个名字段 */
    const m28n = NF.graph().n;
    for (let i = 0; i < m28n; i += 2) NF.setName(i, 'n' + i);   /* 3000 个名字 */
    const m28live = NF.nameStats();
    log(m28live.entries === Math.ceil(m28n / 2) && m28live.segs === 6,
        '名字表：3000 个名字落在 6 个段里', JSON.stringify(m28live));
    log(NF.nameOf(0) === 'n0' && NF.nameOf(1) === '' && NF.nameOf(5998) === 'n5998',
        '名字表：读名字照旧（没名字的返回空串）',
        [NF.nameOf(0), NF.nameOf(1), NF.nameOf(5998)].join('/'));
    NF.snapshot();
    NF.setName(0, '改过的'); NF.setName(5998, ''); NF.setName(1, '新加的');
    log(NF.nameOf(0) === '改过的' && NF.nameOf(5998) === '' && NF.nameOf(1) === '新加的',
        '名字表：改名 / 删名 / 新增都生效',
        [NF.nameOf(0), NF.nameOf(1), NF.nameOf(5998)].join('/'));
    NF.undo();
    log(NF.nameOf(0) === 'n0' && NF.nameOf(5998) === 'n5998' && NF.nameOf(1) === '',
        '名字表：撤销回来逐字回到原样（改名 / 删名 / 新增三样都退回去）',
        [NF.nameOf(0), NF.nameOf(1), NF.nameOf(5998)].join('/'));
    NF.redo();
    log(NF.nameOf(0) === '改过的' && NF.nameOf(5998) === '' && NF.nameOf(1) === '新加的',
        '名字表：重做也原路回去');
    NF.undo();
    /* 结构共享：连着三步只改权重（一个字都没碰名字），名字表的驻留一个字节都不该涨 */
    const m28a = NF.histStats();
    NF.snapshot(); NF.setW(0, 1);
    NF.snapshot(); NF.setW(0, 2);
    NF.snapshot(); NF.setW(0, 3);
    const m28b = NF.histStats();
    /* 只保证「不涨」而不是「不变」：这几步改权重之前，上一段撤销 / 重做在栈顶留了一格
       重做的尾巴（那份改过名字的状态），新的改动一进来它就该被丢掉（改动之后重做失效），
       所以名字表的驻留段数是**可能往下走**的，往下走是对的，往上走才是漏拷。 */
    log(m28b.nameBytes <= m28a.nameBytes && m28b.nameSegsUnique <= m28a.nameSegsUnique,
        '名字表：没改名字的那几步一个段都没多拷（结构共享，只可能往下掉）',
        m28a.nameBytes + ' B -> ' + m28b.nameBytes + ' B / ' + m28a.nameSegsUnique + ' -> ' + m28b.nameSegsUnique + ' 段');
    log(m28b.bytes >= m28b.nameBytes && m28b.nameBytes > 0 && m28b.naive >= m28b.nameBytes,
        '历史占用与「不共享」的对比数字里都算上了名字表',
        JSON.stringify({ bytes: m28b.bytes, nameBytes: m28b.nameBytes, naive: m28b.naive }));
    NF.snapshot();
    NF.setName(3, '只改这一个');
    /* 改完的那一份是「当前值」，还不算历史；再拍一格把它交给历史，才量得到重拷了多少。
       所以要撤两下才回到改之前：第一下撤掉这格，第二下才撤掉改名。 */
    NF.snapshot();
    const m28c = NF.histStats();
    const m28inc = m28c.nameBytes - m28b.nameBytes;
    log(m28inc > 0 && m28inc <= 64 + 40 * 600,
        '名字表：改一个名字只重拷那一段（一段最多 1024 项）',
        m28inc + ' B（整张表 ' + m28live.bytes + ' B）');
    log(m28inc * 2 < m28live.bytes, '名字表：重拷的那一段明显小于整张表',
        m28inc + ' B vs 整张表 ' + m28live.bytes + ' B');
    NF.undo(); NF.undo();
    log(NF.nameOf(3) === '', '名字表：改名那一步能撤销回来（连撤两下：一下撤掉「交给历史」的那格）',
        NF.nameOf(3) || '（空）');

    /* ---- 29. 导入来源表 / 结构视图（翻页）/ 重排 ----
       来源表是导入器写进 v3 文件头里的：折平之后「哪个神经元来自哪个算子」就靠它。
       这里在浏览器里造一份带 source 的文件（把 encodeV3 的头改一改再塞回去），
       验证：读得进来、查得到、翻得出结构视图、四种重排都能跑并且可撤销。 */
    NF.loadV2(blankDoc());
    NF.seed(4242);
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, blink: false, axis: 0 });
    NF.bulkPlace(4, 1, 1);
    NF.bulkPlace(3, 1, 1);
    const m29all = [];
    for (let i = 0; i < NF.graph().n; i++) m29all.push(i);
    NF.batchConnect('chain', { nodes: m29all, axis: 0 });
    NF.setIO([0], 1);
    NF.setIO([NF.graph().n - 1], 2);
    const m29u8 = await NF.encodeV3();
    const m29hl = new DataView(m29u8.buffer, m29u8.byteOffset).getUint32(8, true);
    const m29hdr = JSON.parse(new TextDecoder().decode(m29u8.subarray(16, 16 + m29hl)));
    const m29n = NF.graph().n;
    m29hdr.source = {
      format: 1, kind: 'onnx', generator: 'test', model: 'demo.onnx', exact: true,
      auto: { names: true, positions: true, layout: 'ring', spacing: 26 },
      nodes: [
        { i: 0, op: 'Input', n: 'X', ly: 0, out: [[0, 1]], k: 'in' },
        { i: 1, op: 'Gemm', n: 'fc1', ly: 1, out: [[1, m29n]], 'in': [0], w: 12, blk: 0, nt: '测试用来源表', fl: ['Relu'] }
      ],
      spans: [[0, 1, 0], [1, m29n, 1]],
      notes: ['这是自测造出来的来源表'],
      skipped: [], casts: [],
      shared: [{ t: 'Wt', u: 2, at: ['Gemm t1 的权重', 'Gemm t2 的权重'] }],
      precision: { weights: {}, examples: [] },
      counts: { ops: 2, spans: 2, skipped: 0, shared: 1, blocks: 0, blockWeights: 0 }
    };
    const m29hb = new TextEncoder().encode(JSON.stringify(m29hdr));
    const m29tail = m29u8.subarray(16 + m29hl);
    const m29out = new Uint8Array(16 + m29hb.length + m29tail.length);
    m29out.set(m29u8.subarray(0, 16), 0);
    new DataView(m29out.buffer).setUint32(8, m29hb.length, true);
    m29out.set(m29hb, 16);
    m29out.set(m29tail, 16 + m29hb.length);
    await NF.loadBuffer(m29out);
    log(NF.graph().n === m29n && NF.graph().e > 0, '来源表：带 source 的 v3 文件照常载入',
        NF.graph().n + ' 个神经元 / ' + NF.graph().e + ' 条连接');
    const m29s = NF.sourceSummary();
    log(!!m29s && m29s.ops === 2 && m29s.model === 'demo.onnx' && m29s.exact === true,
        '来源表：读进工程并给出摘要', JSON.stringify(m29s));
    log(NF.sourceLabel(0) === 'Input X', '来源表：第 0 个神经元来自 Input', NF.sourceLabel(0));
    const m29r = NF.sourceOf(2);
    log(NF.sourceLabel(2) === 'Gemm fc1' && !!m29r && !!m29r.fl && m29r.fl[0] === 'Relu',
        '来源表：第 2 个神经元来自 Gemm，并且记着折进来的 Relu', String(NF.sourceLabel(2)));
    log(NF.sourceOf(m29n - 1) !== null, '来源表：区间末端也查得到（二分查找的边界）');
    log(NF.structView(true) === true, '结构视图：能翻过去');
    const m29panel = document.getElementById('structpanel');
    log(!!m29panel && m29panel.classList.contains('show'), '结构视图：面板显示出来了');
    log(document.getElementById('vb-struct').classList.contains('on'),
        '结构视图：右上角那个键变成「按下」状态');
    const m29cv = document.getElementById('structc');
    log(!!m29cv && m29cv.width > 0 && m29cv.height > 0, '结构视图：画布有实际尺寸',
        m29cv ? (m29cv.width + 'x' + m29cv.height) : '没有画布');
    const m29m = NF.structModel();
    log(m29m.mode === 'source' && m29m.nodes.length === 2 && m29m.edges.length === 1,
        '结构视图：用来源表画出算子图',
        JSON.stringify({ mode: m29m.mode, nodes: m29m.nodes.length, edges: m29m.edges.length }));
    log(m29m.nodes[1].w === 12 && m29m.nodes[1].ups === 1 && m29m.nodes[0].kind === 'in',
        '结构视图：节点带着权重数 / 上游数 / 类别');
    const m29s2 = NF.sourceSummary();
    log(m29s2.shared === 1 && NF.sourceShared()[0].t === 'Wt' && NF.sourceShared()[0].u === 2,
        '来源表：权值共享（同一常量被多处引用）读得进来',
        'shared=' + m29s2.shared + ' / ' + NF.sourceShared().map((e) => e.t + '×' + e.u).join('、'));
    log((NF.sourceShared()[0].at || []).length === 2,
        '来源表：共享记录里带着引用它的算子名（能告诉用户是哪两处在共用）',
        (NF.sourceShared()[0].at || []).join('、'));
    NF.structTab('info');
    const m29info = document.getElementById('structside').innerHTML;
    log(NF.structTab() === 'info' && m29info.indexOf('模型独有信息') >= 0,
        '结构视图：能翻到「模型独有信息」那一页');
    log(m29info.indexOf('共享参数（权值共享）') >= 0 && m29info.indexOf('Wt') >= 0 &&
        m29info.indexOf('共享参数组') >= 0,
        '模型独有信息：列着共享参数，并写明导入会把能建的那些建成共享参数组');
    const m29side = document.getElementById('structside');
    log(m29cv.style.display === 'none' && /^1 1 /.test(m29side.style.flex),
        '结构视图：翻到文字页时画布收起、右栏撑满（不留空画布）',
        m29cv.style.display + ' / ' + m29side.style.flex);
    log(!!m29side.querySelector('.stwrap'), '结构视图：文字页包在 .stwrap 里（行宽不拉满整屏）');
    NF.structTab('dag');
    log(m29cv.style.display !== 'none' && m29side.style.flex === '',
        '结构视图：翻回算子图，画布又出来了');
    const m29sub = document.getElementById('struct-sub').textContent || '';
    log(m29cv.width > 1 && m29cv.height > 1 && m29sub.indexOf('滚轮缩放') >= 0,
        '结构视图：翻回来会重画画布、标题也改回算子图（不是一片黑）',
        m29cv.width + 'x' + m29cv.height + ' / ' + m29sub);
    log(NF.structView(false) === false && !m29panel.classList.contains('show'),
        '结构视图：能翻回 3D 建模');
    /* 手工工程没有来源表：不能编一份假的，只能按当前图现场聚合 */
    NF.loadV2(blankDoc());
    NF.setPlacement({ x: 0, y: 0, z: 0, step: 10, blink: false, axis: 0 });
    NF.bulkPlace(6, 1, 1);
    for (let i = 0; i < 5; i++) NF.addEdge(i, i + 1, 1);
    NF.setIO([0], 1); NF.setIO([5], 2);
    log(NF.sourceSummary() === null, '没有来源表的工程：摘要返回 null（不编一份假的）');
    const m29g = NF.structModel();
    log(m29g.mode === 'graph' && m29g.nodes.length >= 1 && m29g.nodes[0].n >= 1,
        '结构视图：手工工程按拓扑现场聚合出结构',
        JSON.stringify({ mode: m29g.mode, nodes: m29g.nodes.length }));
    /* 重排四种：只动坐标，每一步都可撤销 */
    const m29p0 = NF.node(2);
    const m29r1 = NF.relayout('line');
    log(!!m29r1 && m29r1.mode === 'line' && m29r1.neurons === NF.graph().n,
        '重排：直线模式跑通', JSON.stringify(m29r1));
    const m29p1 = NF.node(2);
    log(Math.abs(m29p1.x - m29p0.x) + Math.abs(m29p1.y - m29p0.y) + Math.abs(m29p1.z - m29p0.z) > 0,
        '重排：坐标真的变了', JSON.stringify(m29p0) + ' -> ' + JSON.stringify(m29p1));
    NF.undo();
    const m29p2 = NF.node(2);
    log(m29p2.x === m29p0.x && m29p2.y === m29p0.y && m29p2.z === m29p0.z,
        '重排：能撤销回原坐标');
    const m29r2 = NF.relayout('grid');
    const m29r3 = NF.relayout('layer');
    log(!!m29r2 && m29r2.mode === 'grid' && !!m29r3 && m29r3.mode === 'layer',
        '重排：网格 / 层状两种模式都能跑');
    const m29r4 = NF.relayout('force');
    log(!!m29r4 && m29r4.mode === 'force' && m29r4.neurons === NF.graph().n,
        '重排：力导向在小图上跑通', JSON.stringify(m29r4));
    /* 导入报告面板：来源表要能列出来，且不许出现 undefined */
    await NF.loadBuffer(m29out);
    NF.openSourceReport();
    const m29txt = document.getElementById('dialog').textContent;
    log(m29txt.indexOf('demo.onnx') >= 0 && m29txt.indexOf('Gemm') >= 0 && m29txt.indexOf('undefined') < 0,
        '导入报告：面板列出了模型名和算子，一个 undefined 都没有');
    document.getElementById('dlgclose').click();
    log(!document.getElementById('modal').classList.contains('show'), '导入报告：能关掉');
    const m29tools = NF.aiTools().map((t) => t.name);
    log(m29tools.indexOf('struct_view') >= 0 && m29tools.indexOf('relayout') >= 0 &&
        NF.aiCommands().indexOf('struct') >= 0 && NF.aiManual().indexOf('来源表') >= 0,
        'AI 那边也接上了：工具表 / 菜单命令 / 手册都写了来源表与结构视图');
    /* ---- 30. 共享参数组（权值共享）：一组块 = 同一个参数 ----
       用户问过「权值共享不就是共用同一组参数吗」——对。这里要证明的不是「数值一样」，
       而是**身份一样**：两块拿到的是同一份 Float32Array，改一处全组一起变、只算一份、
       容器里只存一份、撤销能整组逐位退回去。 */
    NF.loadV2(blankDoc());
    for (let i = 0; i < 7; i++) NF.addNode(i * 10, 0, 0);
    const m30a = Array.from(Float32Array.from([1, 2, 3, 4]));
    const m30b = Array.from(Float32Array.from([9, 8, 7, 6]));
    const m30b1 = NF.addBlock([0, 1], [2, 3], m30a);
    const m30b2 = NF.addBlock([2, 3], [4, 5], m30b);
    const m30wide = NF.addBlock([0, 1], [4, 5, 6], [1, 1, 1, 1, 1, 1]);
    log(NF.blockTotal() === 14 && NF.blockTotalAll() === 14,
        '共享组：还没建组时每块各算各的（4 + 4 + 6 = 14）',
        NF.blockTotal() + ' / ' + NF.blockTotalAll());
    log(NF.blockArrId(m30b1) !== NF.blockArrId(m30b2),
        '共享组：没建组时两块各自持有一份数组（身份号不同）',
        NF.blockArrId(m30b1) + ' / ' + NF.blockArrId(m30b2));
    const m30sh = NF.blockShare([m30b1, m30b2]);
    log(m30sh.ok === true && m30sh.sg > 0 && m30sh.members.length === 2,
        '共享组：两个同形状的块并成一组', JSON.stringify(m30sh));
    log(m30sh.overwrote === 1,
        '共享组：如实报告「有 1 个块原来的值被覆盖」，不假装没发生', String(m30sh.overwrote));
    log(NF.blockArrId(m30b1) === NF.blockArrId(m30b2),
        '共享组：两块拿到的权重数组身份号相同（真的是同一个参数，不是数值凑巧相等）',
        NF.blockArrId(m30b1) + ' / ' + NF.blockArrId(m30b2));
    log(NF.blockWeights(m30b2).every((v, i) => Object.is(v, m30a[i])),
        '共享组：值取第一块那一份（第二块原来的 [9,8,7,6] 被覆盖，可以撤销）',
        JSON.stringify(NF.blockWeights(m30b2)));
    log(NF.blockTotal() === 10 && NF.blockTotalAll() === 14,
        '共享组：权重总数按去重算（10），不去重的对照是 14',
        NF.blockTotal() + ' / ' + NF.blockTotalAll());
    const m30g = NF.blockGroups();
    log(m30g.length === 1 && m30g[0].count === 2 && m30g[0].weights === 4 && m30g[0].saved === 4,
        '共享组：组清单给出成员数 / 每份权重数 / 省下的数', JSON.stringify(m30g));
    const m30bi = NF.blocksInfo();
    log(m30bi[0].sg > 0 && m30bi[0].sg === m30bi[1].sg && m30bi[1].sharedWith.indexOf(m30b1) >= 0,
        '共享组：块清单里互相指认（面板上那句「和块 #x 是同一个参数」就是从这儿来的）',
        JSON.stringify([m30bi[0].sg, m30bi[0].sharedWith, m30bi[1].sharedWith]));
    const m30one = NF.blockShare([m30b1]);
    log(m30one.ok === false && m30one.msg.indexOf('两块') >= 0,
        '共享组：只选一块会被明确拒绝', m30one.msg);
    const m30bad = NF.blockShare([m30b1, m30wide]);
    log(m30bad.ok === false && m30bad.msg.indexOf('元素总数对不上') >= 0,
        '共享组：元素总数不一样的块会被拒绝（共享的是同一段数值，不是"形状必须相同"）', m30bad.msg);
    log(NF.blockGroups().length === 1 && NF.blockArrId(m30wide) !== NF.blockArrId(m30b1),
        '共享组：被拒绝的两次都没有偷偷改动什么',
        NF.blockGroups().length + ' 组 / ' + NF.blockArrId(m30wide));
    NF.delBlocks([m30wide]);
    log(NF.blockTotalAll() === 8, '共享组：把形状不同的那块删掉，回到两块 2×2', String(NF.blockTotalAll()));
    const m30p = NF.pruneByWeight(2.5, 'zero', true);
    log(m30p.blkW === 2,
        '共享组：剪枝只数代表块的那一份（[1,2,3,4] 里 2 个低于阈值），不按块数翻倍',
        JSON.stringify(m30p));
    log(NF.blockWeights(m30b1).join(',') === NF.blockWeights(m30b2).join(','),
        '共享组：剪枝之后两块还是逐位一样（改一处全组一起变，字符串化之后逐位相同）',
        JSON.stringify(NF.blockWeights(m30b1)));
    log(NF.blockArrId(m30b1) === NF.blockArrId(m30b2),
        '共享组：剪枝换的是**整组共用的那一份新副本**，身份号还是同一个',
        NF.blockArrId(m30b1) + ' / ' + NF.blockArrId(m30b2));
    NF.undo();
    log(NF.blockWeights(m30b1).every((v, i) => Object.is(v, m30a[i])) &&
        NF.blockWeights(m30b2).every((v, i) => Object.is(v, m30a[i])),
        '共享组：撤销之后整组权重逐位回到原值', JSON.stringify(NF.blockWeights(m30b1)));
    NF.setIO([0, 1], 1);
    NF.setIO([4, 5], 2);
    const m30c = NF.compile('pytorch');
    log(m30c.blocks === 2 && m30c.blockWeights === 4,
        '共享组：IR 里块数 2、权重数 4（共享的那一份只算一次）',
        JSON.stringify({ blocks: m30c.blocks, weights: m30c.blockWeights }));
    log(m30c.errors.length === 0,
        '共享组：带共享组的工程能正常编译', m30c.errors.join(' | ') || '没有错误');
    /* 容器往返：文件里只存代表块那一份，引用表把其余成员指回去 */
    const m30buf = await NF.encodeV3({});
    NF.clear();
    const m30lr = await NF.loadBuffer(m30buf);
    const m30bi2 = NF.blocksInfo();
    log(m30lr.blocks === 2 && m30bi2.length === 2 && m30bi2[0].sg > 0 && m30bi2[0].sg === m30bi2[1].sg,
        '共享组：容器往返之后两块还是同一组（文件里只存了一份权重）',
        JSON.stringify({ blocks: m30lr.blocks, sg: m30bi2.map((x) => x.sg) }));
    log(m30bi2[0].sharedWith.indexOf(m30bi2[1].id) >= 0,
        '共享组：往返之后互相指认还在', JSON.stringify(m30bi2[0].sharedWith));
    log(NF.blockTotal() === 4 && NF.blockTotalAll() === 8,
        '共享组：往返之后去重数字没变（4 / 8）', NF.blockTotal() + ' / ' + NF.blockTotalAll());
    log(NF.blockArrId(m30bi2[0].id) === NF.blockArrId(m30bi2[1].id),
        '共享组：往返之后读回来的仍然是同一份数组（不是各拷了一份）',
        NF.blockArrId(m30bi2[0].id) + ' / ' + NF.blockArrId(m30bi2[1].id));
    /* 界面那一条路：面板里那一节 + 两个按钮真的接上了 */
    NF.selectBlocks([m30bi2[0].id, m30bi2[1].id]);
    const m30panel = document.getElementById('inspector').innerHTML;
    log(m30panel.indexOf('共享参数组（权值共享）') >= 0,
        '面板：右侧出现了「共享参数组（权值共享）」那一节');
    const m30sbtn = document.querySelector('#inspector button[data-act=blk-share]');
    log(!!m30sbtn && !m30sbtn.disabled,
        '面板：框选两块之后「设为共享参数」可以点了',
        m30sbtn ? ('disabled=' + m30sbtn.disabled) : '没有这个按钮');
    const m30ubtn0 = document.querySelector('#inspector button[data-act=blk-unshare][data-sg]');
    log(!!m30ubtn0, '面板：每个共享组都带一个「解除这一组共享」按钮');
    const m30un = NF.blockUnshare([m30bi2[1].id]);
    log(m30un.ok === true && m30un.freed === 1 && m30un.dissolved === 1 && NF.blockGroups().length === 0,
        '解除共享：只退出一块，组里只剩一块时顺手解散（不留只有一个成员的组）',
        JSON.stringify(m30un));
    log(NF.blockArrId(m30bi2[0].id) !== NF.blockArrId(m30bi2[1].id) && NF.blockTotal() === 8,
        '解除共享：两块各自拿到一份数组，权重总数回到 8',
        NF.blockTotal() + ' / ' + NF.blockArrId(m30bi2[0].id) + ',' + NF.blockArrId(m30bi2[1].id));
    log(NF.blockWeights(m30bi2[1].id).every((v, i) => Object.is(v, m30a[i])),
        '解除共享：值不动（解除共享不等于回退，想回退点撤销）',
        JSON.stringify(NF.blockWeights(m30bi2[1].id)));
    /* 按钮真的点得动（不是只有脚本接口能用） */
    NF.selectBlocks([m30bi2[0].id, m30bi2[1].id]);
    const m30sbtn2 = document.querySelector('#inspector button[data-act=blk-share]');
    if (m30sbtn2) m30sbtn2.click();
    log(NF.blockGroups().length === 1,
        '面板：点「设为共享参数」真的把两块并成了一组', JSON.stringify(NF.blockGroups()));
    const m30ubtn = document.querySelector('#inspector button[data-act=blk-unshare][data-sg]');
    if (m30ubtn) m30ubtn.click();
    log(NF.blockGroups().length === 0 && NF.blockTotal() === 8,
        '面板：点「解除这一组共享」整组退出，权重总数回到 8', String(NF.blockTotal()));
    /* AI 那边也要能用 */
    log(NF.aiTools().map((t) => t.name).indexOf('block_share') >= 0 &&
        NF.aiManual().indexOf('共享参数组') >= 0,
        'AI 那边也接上了：工具表里有 block_share，手册写了共享参数组');

    /* ---- 31. 转置共享（形状不同、元素总数一样）+ 共享块展开会自动退组 ----
       第 30 节验的是"两块形状一样"。这一节验"同一段数值按另一种形状读"：
       3×2 和 2×3 就是互为转置。容器读写、编译、剪枝、撤销、往返都要按这条走。 */
    NF.loadV2(blankDoc());
    for (let i = 0; i < 8; i++) NF.addNode(i * 10, 0, 0);
    const m31w = [1, 2, 3, 4, 5, 6];
    const m31a = NF.addBlock([0, 1, 2], [3, 4], m31w);          /* 3×2 */
    const m31b = NF.addBlock([3, 4], [5, 6, 7], m31w.slice());  /* 2×3：同一段数值按另一种形状读 */
    const m31tr = NF.blockShare([m31a, m31b]);
    log(m31tr.ok === true && m31tr.sg > 0 && m31tr.members.length === 2,
        '转置共享：元素总数一样的 3×2 和 2×3 能并成一组', JSON.stringify(m31tr));
    log(NF.blockArrId(m31a) === NF.blockArrId(m31b),
        '转置共享：两块拿到的是同一份数组（本身就是互为转置的关系）',
        NF.blockArrId(m31a) + ' / ' + NF.blockArrId(m31b));
    const m31g = NF.blockGroups();
    log(m31g.length === 1 && m31g[0].mixedShape === true &&
        m31g[0].shapes.join('/') === '3×2/2×3',
        '转置共享：组清单如实标出形状不同（shapes = 3×2 / 2×3）', JSON.stringify(m31g));
    log(NF.blockTotal() === 6 && NF.blockTotalAll() === 12,
        '转置共享：权重总数按一份算（6），不去重是 12', NF.blockTotal() + ' / ' + NF.blockTotalAll());
    NF.setIO([0, 1, 2], 1);
    NF.setIO([5, 6, 7], 2);
    const m31c = NF.compile('pytorch');
    log(m31c.errors.length === 0 && m31c.blocks === 2 && m31c.blockWeights === 6,
        '转置共享：能编译，IR 里 2 块 / 权重 6（共享的那一份只算一次）',
        m31c.errors.join(' | ') || JSON.stringify({ b: m31c.blocks, w: m31c.blockWeights }));
    log(m31c.code.indexOf('self.bwoff[bi]:self.bwoff[bi] + self.bk[bi] * self.bn[bi]') >= 0 &&
        m31c.code.indexOf('.view(self.bk[bi], self.bn[bi])') >= 0,
        '转置共享：生成的 Python 按各自的形状 view 同一段 self.bw');
    const m31buf = await NF.encodeV3({});
    NF.clear();
    const m31lr = await NF.loadBuffer(m31buf);
    const m31bi = NF.blocksInfo();
    log(m31lr.blocks === 2 && m31bi[0].sg > 0 && m31bi[0].sg === m31bi[1].sg &&
        NF.blockArrId(m31bi[0].id) === NF.blockArrId(m31bi[1].id),
        '转置共享：容器往返之后还是同一组、还是同一份数组（文件里只存一份）',
        JSON.stringify({ blocks: m31lr.blocks, shapes: [m31bi[0].k + '×' + m31bi[0].n, m31bi[1].k + '×' + m31bi[1].n] }));
    log(JSON.stringify(NF.blockWeights(m31bi[0].id)) === JSON.stringify(m31w),
        '转置共享：往返之后那段数值逐位不变', JSON.stringify(NF.blockWeights(m31bi[0].id)));
    NF.pruneByWeight(3.5, 'zero', true);
    log(JSON.stringify(NF.blockWeights(m31bi[0].id)) === JSON.stringify([0, 0, 0, 4, 5, 6]) &&
        NF.blockArrId(m31bi[0].id) === NF.blockArrId(m31bi[1].id),
        '转置共享：剪枝改的还是整组共用的那一份（逐位相同、身份号不变）',
        JSON.stringify(NF.blockWeights(m31bi[0].id)));
    NF.undo();
    log(JSON.stringify(NF.blockWeights(m31bi[0].id)) === JSON.stringify(m31w),
        '转置共享：撤销之后整组逐位回到原值', JSON.stringify(NF.blockWeights(m31bi[0].id)));
    const m31c2 = NF.addBlock([0, 1], [3, 4], [1, 1, 1, 1]);    /* 2×2 = 4 个，跟 6 对不上 */
    const m31no = NF.blockShare([m31bi[0].id, m31c2]);
    log(m31no.ok === false && m31no.msg.indexOf('元素总数对不上') >= 0,
        '转置共享：元素总数不一样的块仍然被明确拒绝', m31no.msg);
    NF.delBlocks([m31c2]);
    /* 展开成连接：共享块会被自动移出组（不是报"先去退组"） */
    const m31ex = NF.expandBlockById(m31bi[0].id);
    log(m31ex.ok === true && m31ex.unshared === 1 && m31ex.sg > 0 &&
        m31ex.others.indexOf(m31bi[1].id) >= 0,
        '展开共享块：先自动移出共享组，再把"退出了哪一组、和谁不再联动"如实报出来',
        JSON.stringify(m31ex));
    log(NF.blockGroups().length === 0 && NF.blocksInfo().length === 1,
        '展开共享块：组里只剩一块时自动解散，展开之后块没了只剩连接',
        NF.blockGroups().length + ' 组 / ' + NF.blocksInfo().length + ' 块');
    log(NF.blockArrId(m31bi[0].id) === -1 && NF.blockArrId(m31bi[1].id) > 0,
        '展开共享块：留下来的那块拿到自己的数组（不再和被展开的那份共享）',
        NF.blockArrId(m31bi[0].id) + ' / ' + NF.blockArrId(m31bi[1].id));
    NF.undo();
    log(NF.blockGroups().length === 1 && NF.blocksInfo().length === 2 &&
        NF.blockArrId(m31bi[0].id) === NF.blockArrId(m31bi[1].id),
        '展开共享块：撤销之后块和共享组都原样回来（同一份数组）',
        NF.blockGroups().length + ' 组 / ' + NF.blocksInfo().length + ' 块');
    /* ---- 32. 算子节点（算子级聚合块）：数据模型 / 3D 板子 / 拾取 / 往返 ---- */
    NF.loadV2(blankDoc());
    for (let i = 0; i < 12; i++) NF.addNode(i * 10, 0, 0);
    NF.setIO([0, 1, 2], 1);
    NF.setIO([9, 10, 11], 2);
    NF.setIO([3, 4, 8], 2);
    const opW1 = [1, 2, 3, 4, 5, 6];
    const opA = NF.addOp('Conv', 'conv1', {
      ins: [{ k: 'n', ids: [0, 1, 2], shape: [1, 1, 1, 3] }],
      outShape: [1, 2, 1, 1], land: [3, 4],
      params: [{ name: 'W', dtype: 'f32', shape: [2, 3, 1, 1], data: opW1 }],
    });
    log(opA.ok === true && opA.id >= 0,
        '算子节点：卷积建得起来（3 个神经元按 1×1×3 读，2 个元素落到 2 个神经元）',
        JSON.stringify(opA.msg || (opA.id + ' / out=' + opA.info.out)));
    const opB1 = NF.addOp('Conv', 'b1', { ins: [{ k: 'n', ids: [0, 1, 2], shape: [1, 1, 1, 3] }],
      outShape: [1, 3, 1, 1], land: [3, 4],
      params: [{ name: 'W', dtype: 'f32', shape: [3, 3, 1, 1], data: [1, 2, 3, 4, 5, 6, 7, 8, 9] }] });
    log(opB1.ok === false && String(opB1.msg).indexOf('元素个数必须一样') >= 0,
        '算子节点：落点个数跟输出元素个数对不上 -> 当场拒绝', opB1.msg);
    const opB2 = NF.addOp('Conv', 'b2', { ins: [{ k: 'n', ids: [0, 1, 2], shape: [1, 1, 1, 3] }],
      outShape: [1, 2, 1, 1], land: [3, 99],
      params: [{ name: 'W', dtype: 'f32', shape: [2, 3, 1, 1], data: opW1 }] });
    log(opB2.ok === false && String(opB2.msg).indexOf('越界') >= 0,
        '算子节点：落点越界 -> 当场拒绝', opB2.msg);
    const opB3 = NF.addOp('Conv', 'b3', { ins: [{ k: 'n', ids: [0, 1, 2], shape: [1, 1, 1, 3] }],
      outShape: [1, 2, 1, 1], land: [3, 4],
      params: [{ name: 'W', dtype: 'f32', shape: [2, 3, 1, 1], data: [1, 2, 3, 4, 5] }] });
    log(opB3.ok === false && String(opB3.msg).indexOf('要 6 个数值') >= 0,
        '算子节点：参数个数跟形状对不上 -> 当场拒绝', opB3.msg);
    const opB4 = NF.addOp('Conv', 'b4', { ins: [{ k: 'n', ids: [0, 1, 2], shape: [1, 2] }],
      outShape: [1, 2, 1, 1], land: [3, 4],
      params: [{ name: 'W', dtype: 'f32', shape: [2, 3, 1, 1], data: opW1 }] });
    log(opB4.ok === false && String(opB4.msg).indexOf('要 2 个神经元') >= 0,
        '算子节点：输入形状跟神经元个数对不上 -> 当场拒绝', opB4.msg);
    log(NF.opsStats().count === 1, '算子节点：被拒绝的那四个都没有留在图里', JSON.stringify(NF.opsStats()));
    const opC = NF.addOp('Relu', 'relu1', { ins: [{ k: 'o', id: opA.id }], outShape: [1, 2, 1, 1], land: [5, 6] });
    NF.addEdge(5, 9, 1); NF.addEdge(6, 10, 1);
    log(opC.ok === true, '算子节点：算子读另一个算子的输出（算子之间的链）', JSON.stringify(opC.msg || opC.id));
    const opBad = NF.addOp('Relu', 'badref', { ins: [{ k: 'o', id: 99999 }], outShape: [1, 1, 1, 1], land: [7] });
    log(opBad.ok === false && String(opBad.msg).indexOf('不存在的节点') >= 0,
        '算子节点：引用不存在的算子 -> 当场拒绝', opBad.msg);
    /* ---- 3D 板子 ---- */
    const opv = NF.opView(opA.id);
    log(!!opv && opv.hasMesh && opv.inScene && !!opv.tex && opv.tex.w === 3 && opv.tex.h === 2,
        '算子板子：卷积核 [2,3,1,1] 按 2 行 × 3 列的参数热力图贴上去', JSON.stringify(opv));
    log(Math.abs(opv.cx - 35) < 1e-6 && Math.abs(opv.cy) < 1e-6,
        '算子板子：位置 = 落点神经元的重心（#3 在 x=30、#4 在 x=40 -> 35）', opv.cx + ',' + opv.cy);
    const tx1 = NF.opTexel(opA.id, 0, 0), tx2 = NF.opTexel(opA.id, 2, 1);
    log(tx1 && tx1[3] === 255 && tx1[2] > tx1[1] && tx1[1] > tx1[0],
        '算子板子：正权重那格是蓝的（b > g > r）', JSON.stringify(tx1));
    log(tx2 && tx2[2] > tx1[2], '算子板子：|w| 越大越亮（第 6 个数比第 1 个数亮）', JSON.stringify([tx1, tx2]));
    const opNeg = NF.addOp('Conv', 'neg', { ins: [{ k: 'n', ids: [0, 1, 2], shape: [1, 1, 1, 3] }],
      outShape: [1, 1, 1, 1], land: [8],
      params: [{ name: 'W', dtype: 'f32', shape: [1, 3, 1, 1], data: [-2, -1, -3] }] });
    NF.addEdge(8, 11, 1);
    const tn = NF.opTexel(opNeg.id, 0, 0);
    log(opNeg.ok === true && tn[0] > tn[2], '算子板子：负权重那格是红的（r > b）', JSON.stringify(tn));
    log(NF.opColorOf(opA.id) === '#60a5fa' && NF.opColorOf(opNeg.id) === NF.opColorOf(opA.id),
        '算子板子：同类型的算子用同一种边框色（Conv = #60a5fa）', NF.opColorOf(opA.id));
    log(NF.opViewStats().inScene === 3, '算子板子：3 个算子 3 张板子都挂在场景里', JSON.stringify(NF.opViewStats()));
    /* ---- 选中 / 悬停 / 拾取 ---- */
    NF.selectOps([opA.id]);
    const ovs = NF.opViewStats();
    log(ovs.sel.length === 1 && ovs.sel[0] === opA.id && ovs.halo === true,
        '算子节点：脚本选中它之后，视口里的边框高亮跟着亮', JSON.stringify(ovs));
    NF.setHoverOp(opA.id);
    log(NF.opViewStats().hover === opA.id, '算子节点：悬停状态记得住', NF.opViewStats().hover);
    NF.setHoverOp(-1);
    NF.setCamera(35, 0, 90, 35, 0, 0);
    await raf();
    const sp = NF.screenOfPoint(35, 0, 0);
    const hitOp = sp ? NF.pickOpAt(sp.x, sp.y) : -1;
    log(hitOp === opA.id, '算子节点：在视口里点得中（板子拾取）', 'pick=' + hitOp + ' 期望 ' + opA.id);
    /* ---- 位置：自动 <-> 手动 ---- */
    const opSet = NF.opSetPos(opA.id, 100, 200, 300);
    const ov2 = NF.opView(opA.id);
    log(opSet.ok === true && ov2.cx === 100 && ov2.cy === 200 && ov2.cz === 300 &&
        !!ov2.pos && ov2.pos.x === 100,
        '算子板子：可以手动钉在指定坐标', JSON.stringify(opSet));
    NF.opSetPos(opA.id, null);
    log(Math.abs(NF.opView(opA.id).cx - 35) < 1e-6 && NF.opView(opA.id).pos === null,
        '算子板子：取消手动位置后又回到落点重心', NF.opView(opA.id).cx);
    /* ---- 神经元 -> 算子的索引（CSR）---- */
    let refTotal = 0;
    for (let i = 0; i < NF.graph().n; i++) refTotal += NF.opRefs(i).length;
    let wantTotal = 0;
    for (const o of NF.opsInfo()) {
      wantTotal += o.land;
      for (const r of o.ins) if (r.k === 'n') wantTotal += r.count;
    }
    log(refTotal === wantTotal && refTotal === 11,
        '神经元 -> 算子的索引：条目总数跟「落点 + 输入」对得上', refTotal + ' / ' + wantTotal);
    const ref0 = NF.opRefs(0), ref3 = NF.opRefs(3), ref11 = NF.opRefs(11);
    log(ref0.indexOf(opA.id) >= 0 && ref0.indexOf(opNeg.id) >= 0 && ref0.indexOf(opC.id) < 0,
        '神经元 -> 算子的索引：#0 被两个卷积读着，Relu 读的是算子的输出不算它的输入', JSON.stringify(ref0));
    log(ref3.indexOf(opA.id) >= 0 && ref3.indexOf(opC.id) < 0 && ref11.length === 0,
        '神经元 -> 算子的索引：落点神经元查到的是写它的那个算子（没人用的神经元查出来是空的）',
        JSON.stringify(ref3) + ' / ' + JSON.stringify(ref11));
    /* ---- 删：依赖拦截 + 撤销 ---- */
    const opDelBlocked = NF.delOps([opA.id]);
    log(opDelBlocked.ok === false && String(opDelBlocked.msg).indexOf('的输出还被') >= 0,
        '算子节点：输出还被别的算子用着就删不掉，并且说清是谁在用', opDelBlocked.msg);
    NF.snapshot();
    const opDelOk = NF.delOps([opC.id]);
    log(opDelOk.ok === true && opDelOk.deleted === 1 && NF.opsStats().count === 2,
        '算子节点：把下游删掉之后上游的数对得上', JSON.stringify(opDelOk) + ' / ' + NF.opsStats().count);
    NF.undo();
    log(NF.opsStats().count === 3 && NF.opsInfo().filter((x) => x.id === opC.id).length === 1,
        '算子节点：撤销把删掉的算子原样带回来', NF.opsStats().count);
    /* ---- 参数：写时复制 + 撤销逐位回来 + 贴图跟着重画 ---- */
    const opTexTagBefore = NF.opTexel(opNeg.id, 0, 0).join(',');
    log(NF.opParamValues(opNeg.id)[0].join(',') === '-2,-1,-3', '算子参数：读得出来',
        NF.opParamValues(opNeg.id)[0].join(','));
    const opSetP = NF.opSetParam(opNeg.id, 'W', [9, 9, 9]);
    log(opSetP.ok === true && NF.opParamValues(opNeg.id)[0].join(',') === '9,9,9',
        '算子参数：写得进去（写时复制成新对象）', JSON.stringify(opSetP.values));
    const opTexTagAfter = NF.opTexel(opNeg.id, 0, 0).join(',');
    log(opTexTagAfter !== opTexTagBefore, '算子参数：改完参数那张贴图跟着重画了',
        opTexTagBefore + ' -> ' + opTexTagAfter);
    NF.undo();
    log(NF.opParamValues(opNeg.id)[0].join(',') === '-2,-1,-3',
        '算子参数：撤销之后参数逐位回到原值', NF.opParamValues(opNeg.id)[0].join(','));
    const opBadSet = NF.opSetParam(opNeg.id, 'W', [1, 2]);
    log(opBadSet.ok === false && String(opBadSet.msg).indexOf('要 3 个数值') >= 0,
        '算子参数：个数对不上 -> 当场拒绝', opBadSet.msg);
    /* ---- 编译：PyTorch 出代码 + 二进制；C 后端明确拒绝 ---- */
    const opComp = NF.compile('pytorch');
    log(opComp.errors.length === 0 && opComp.waves >= 3 && !!opComp.bin,
        '算子节点：能编译成 PyTorch（含二进制权重），波次把算子排进了拓扑序',
        opComp.errors.join(' | ') || ('waves=' + opComp.waves + ' bin=' + (opComp.bin ? opComp.bin.byteLength : 0)));
    log(opComp.code.indexOf('F.conv2d(') >= 0 && opComp.code.indexOf('self._op(') >= 0 &&
        opComp.code.indexOf('self.num_op_nodes') >= 0,
        '算子节点：生成的 Python 里真的调了 conv2d，并且走的是 run 里的算子调度');
    const opCompC = NF.compile('exe');
    log(opCompC.errors.length > 0 && String(opCompC.errors.join(' ')).indexOf('算子节点') >= 0 &&
        String(opCompC.errors.join(' ')).indexOf('PyTorch / ONNX') >= 0,
        '算子节点：独立可执行文件（C 后端）明确拒绝，并指路 PyTorch / ONNX',
        String(opCompC.errors[0] || '').slice(0, 60));
    /* ---- 英文界面：算子节点那一节（T() 碎片与 h-* 整句两条路都要走通）---- */
    NF.setLang('en');
    await raf();
    NF.selectOps([opNeg.id]);
    await raf();
    const opInsEn = document.getElementById('inspector').textContent;
    log(opInsEn.indexOf('Operator node #') >= 0 && opInsEn.indexOf('Plate position') >= 0,
        '英文界面：算子节点标题与「板子位置」一节都翻过去了', opInsEn.slice(0, 44) + '…');
    log(opInsEn.indexOf('compiling') >= 0 && opInsEn.indexOf('Parameter tensors') >= 0,
        '英文界面：算子节点说明（data-i18n 整句）与参数张量一节都翻了');
    const opInsCjk = (opInsEn.match(/[\u4e00-\u9fff]+/g) || []).join('|');
    log(opInsCjk === '', '英文界面：算子节点明细里一个中文都不剩', opInsCjk || 'clean');
    NF.selectOps([]);
    await raf();
    const opPanelEn = document.getElementById('inspector').textContent;
    log(opPanelEn.indexOf('Operator nodes') >= 0 && opPanelEn.indexOf('Landing total') >= 0,
        '英文界面：没选中时的算子节点清单也翻了');
    NF.setLang('zh');
    await raf();
    log(document.getElementById('inspector').textContent.indexOf('算子节点') >= 0,
        '算子节点面板切回中文能复原');
    /* ---- 容器往返：目录 + 参数逐位不变 ---- */
    const opBuf = await NF.encodeV3({});
    const opInfoBefore = JSON.stringify(NF.opsInfo());
    const opValsBefore = JSON.stringify(NF.opParamValues(opNeg.id));
    NF.clear();
    const opLr = await NF.loadBuffer(opBuf);
    log(opLr.ops === 3 && JSON.stringify(NF.opsInfo()) === opInfoBefore,
        '算子节点：容器往返之后算子目录逐字段不变（类型 / 形状 / 落点 / 参数表）',
        JSON.stringify({ ops: opLr.ops, same: JSON.stringify(NF.opsInfo()) === opInfoBefore }));
    log(JSON.stringify(NF.opParamValues(opNeg.id)) === opValsBefore,
        '算子节点：容器往返之后参数数值逐位不变', NF.opParamValues(opNeg.id)[0].join(','));
    const opv2 = NF.opView(opNeg.id);
    log(!!opv2 && opv2.inScene && !!opv2.tex && Math.abs(opv2.cx - 80) < 1e-6,
        '算子节点：往返之后板子重新画了出来，位置还是落点重心', JSON.stringify(opv2 && [opv2.cx, opv2.tex]));

    /* ==== 接口运行时：外界信号真的进得来、软件里的激活真的出得去 ==== */
    NF.clear();
    await raf();
    const ri0 = NF.addNode(0, 0, 0), rmid = NF.addNode(20, 0, 0), ro0 = NF.addNode(40, 0, 0);
    NF.addEdge(ri0, rmid, 2.0); NF.addEdge(rmid, ro0, 2.0);
    NF.setIO([ri0], 1); NF.setIO([ro0], 2);
    NF.setThr([ri0, rmid, ro0], 0.5);
    await raf();
    const ist0 = NF.ifaceState();
    log(ist0.on === false && ist0.feeds === 0, '接口运行时：默认是关的，一次都没喂过', 'on=' + ist0.on);
    log(ist0.ins.length === 1 && ist0.outs.length === 1, '接口运行时：认得出 1 个输入接口 / 1 个输出接口',
        'ins=' + JSON.stringify(ist0.ins) + ' outs=' + JSON.stringify(ist0.outs));
    NF.ifaceBind(ri0, { kind: 'key', code: 'Digit1', value: 1 });
    NF.ifaceBindOut(ro0, { kind: 'log' });
    NF.ifaceOn(true);
    /* 派发一个真的键盘事件：走完整的 keydown → 喂值 → 前向 → 输出动作 */
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', key: '1', bubbles: true, cancelable: true }));
    await raf();
    const ist1 = NF.ifaceState();
    log(ist1.feeds === 1, '接口运行时：按一下绑定的键 → 真的喂进一次信号', 'feeds=' + ist1.feeds);
    const ov1 = ist1.outVal.filter(function (x) { return x[0] === ro0; })[0];
    log(!!ov1 && ov1[1] > 0, '接口运行时：信号按阈值传到输出接口（权重 2 → 2 的链）', 'outVal=' + JSON.stringify(ist1.outVal));
    log(ist1.fires === 1, '接口运行时：输出接口激活后触发了一次动作', 'fires=' + ist1.fires);
    log(ist1.log.length >= 2 && ist1.log[0].dir === 'out' && ist1.log[1].dir === 'in',
        '接口运行时：日志把「进」和「出」都记下来了',
        ist1.log.map(function (e) { return e.dir + ':' + e.text.slice(0, 12); }).join(' / '));
    /* 上升沿：输出一直是正的，再算一次也不该重复触发 */
    NF.ifaceFeed(ri0, 1, 400);
    const ist2 = NF.ifaceState();
    log(ist2.fires === 1, '接口运行时：输出没掉下去就不重复触发（只认上升沿）', 'fires=' + ist2.fires);
    /* 阈值不够：0.1 的权重推不过 0.5 的阈值，信号就断在那里 */
    NF.clear();
    await raf();
    const wi0 = NF.addNode(0, 0, 0), wmid = NF.addNode(20, 0, 0), wo0 = NF.addNode(40, 0, 0);
    NF.addEdge(wi0, wmid, 0.1); NF.addEdge(wmid, wo0, 2.0);
    NF.setIO([wi0], 1); NF.setIO([wo0], 2);
    NF.setThr([wi0, wmid, wo0], 0.5);
    await raf();
    NF.ifaceBind(wi0, { kind: 'key', code: 'Digit2', value: 1 });
    NF.ifaceBindOut(wo0, { kind: 'log' });
    NF.ifaceOn(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', key: '2', bubbles: true, cancelable: true }));
    await raf();
    const ist3 = NF.ifaceState();
    const ov3 = ist3.outVal.filter(function (x) { return x[0] === wo0; })[0];
    log(ist3.feeds === 1 && !!ov3 && ov3[1] === 0,
        '接口运行时：没到阈值就不激活，信号断在中间（0.1 推不过 0.5）',
        'feeds=' + ist3.feeds + ' outVal=' + JSON.stringify(ist3.outVal));
    log(ist3.fires === 0, '接口运行时：输出接口没激活 → 一个动作都不触发', 'fires=' + ist3.fires);
    /* 手动喂值：不按键盘也能给信号 */
    NF.ifaceManual(wi0, 1);
    NF.ifaceForward();
    const ist4 = NF.ifaceState();
    const iv4 = ist4.inVal.filter(function (x) { return x[0] === wi0; })[0];
    log(!!iv4 && iv4[1] === 1, '接口运行时：手动喂值也能当外部信号用', JSON.stringify(ist4.inVal));
    NF.ifaceManual(wi0, undefined);
    /* ==== 通用信号通道：编解码 + 传输 ==== */
    const sl0 = NF.ifaceSlots('0, 1*2, 2*0.5+0.1');
    log(sl0.length === 3 && sl0[0].n === 0 && sl0[1].k === 2 && Math.abs(sl0[2].b - 0.1) < 1e-9,
        '信号通道：信号位解析（编号 / 编号*增益 / 编号*增益+偏移）', JSON.stringify(sl0));
    const ifc1 = NF.ifaceCodecProbe('json', '{"v":[1,2,3]}');
    const ifc2 = NF.ifaceCodecProbe('text', '1 2 3');
    const ifc3 = NF.ifaceCodecProbe('csv', '1,2,3');
    log(ifc1.vals.join() === '1,2,3' && ifc2.vals.join() === '1,2,3' && ifc3.vals.join() === '1,2,3',
        '信号通道：JSON / 文本 / CSV 三种编码解出来是同一组值', JSON.stringify([ifc1.vals, ifc2.vals, ifc3.vals]));
    const ifc4 = NF.ifaceCodecProbe('json', '{"12":1,"13":0.5}');
    log(!!ifc4.named && ifc4.named.length === 2 && ifc4.named[0][0] === 12,
        '信号通道：{"编号":值} 这种 JSON 按编号点名，跟顺序无关', JSON.stringify(ifc4.named));
    const ifc5 = NF.ifaceCodecProbe('text', '12=1 13=0.5');
    log(!!ifc5.named && ifc5.named[1][0] === 13, '信号通道：文本里的「编号=值」也按编号点名', JSON.stringify(ifc5.named));
    const f32b = new Float32Array([1.5, -2.25]);
    const ifc6 = NF.ifaceCodecProbe('f32', Array.from(new Uint8Array(f32b.buffer)));
    log(ifc6.vals.length === 2 && Math.abs(ifc6.vals[0] - 1.5) < 1e-6 && Math.abs(ifc6.vals[1] + 2.25) < 1e-6,
        '信号通道：float32 小端二进制解出来是对的（仿真软件最常用的那种）', JSON.stringify(ifc6.vals));
    const i16b = new Int16Array([16384, -16384]);
    const ifc7 = NF.ifaceCodecProbe('i16', Array.from(new Uint8Array(i16b.buffer)));
    log(ifc7.vals.length === 2 && Math.abs(ifc7.vals[0] - 0.5) < 1e-3 && Math.abs(ifc7.vals[1] + 0.5) < 1e-3,
        '信号通道：int16 小端二进制按 1/32767 归一化', JSON.stringify(ifc7.vals));
    const ifc8 = NF.ifaceCodecProbe('json', '{这不是JSON');
    log(!!ifc8.error && ifc8.error.indexOf('JSON') >= 0, '信号通道：解不开的帧会把原因说清楚，不会闷掉', ifc8.error);

    /* 一条收 + 一条发：喂进去 -> 按阈值传到输出接口 -> 输出通道在上升沿发一帧 */
    NF.clear();
    await raf();
    const ci0 = NF.addNode(0, 0, 0), cmid = NF.addNode(20, 0, 0), co0 = NF.addNode(40, 0, 0);
    NF.addEdge(ci0, cmid, 2.0); NF.addEdge(cmid, co0, 2.0);
    NF.setIO([ci0], 1); NF.setIO([co0], 2);
    NF.setThr([ci0, cmid, co0], 0.5);
    await raf();
    const chIn = NF.ifaceChanAdd('in', { name: '测试收', xp: 'log', codec: 'text', slots: String(ci0) });
    const chOut = NF.ifaceChanAdd('out', { name: '测试发', xp: 'log', codec: 'text', slots: String(co0) });
    NF.ifaceOn(true);
    NF.ifaceChanFeed(chIn, '1');
    await raf();
    const stC = NF.ifaceState();
    const cIn = stC.chan.filter(function (x) { return x.id === chIn; })[0];
    const cOut = stC.chan.filter(function (x) { return x.id === chOut; })[0];
    log(!!cIn && cIn.rx === 1, '信号通道：收到一帧文本，按信号位喂进输入接口', 'rx=' + (cIn && cIn.rx));
    log(!!cOut && cOut.tx === 1, '信号通道：输出通道在信号的上升沿发了一帧', 'tx=' + (cOut && cOut.tx));
    const chanLog = NF.ifaceLog().map(function (e) { return e.text; }).join(' | ');
    log(chanLog.indexOf('测试发') >= 0, '信号通道：发出去的那一帧进了日志（能核对内容）', chanLog.slice(0, 80));
    NF.ifaceChanFeed(chIn, '0');
    await raf();
    NF.ifaceChanFeed(chIn, '1');
    await raf();
    const cOut2 = NF.ifaceState().chan.filter(function (x) { return x.id === chOut; })[0];
    log(cOut2.tx === 2, '信号通道：掉下去再上来会再发一帧（不是只发第一次）', 'tx=' + cOut2.tx);
    NF.ifaceChanFeed(chIn, '1');
    await raf();
    log(NF.ifaceState().chan.filter(function (x) { return x.id === chOut; })[0].tx === 2,
        '信号通道：一直是正的就不重复发（只有上升沿才算新事件）');
    const cBad = NF.ifaceChanAdd('in', { name: '坏 JSON', xp: 'log', codec: 'json', slots: String(ci0) });
    NF.ifaceChanFeed(cBad, '{这不是JSON');
    const cBad2 = NF.ifaceState().chan.filter(function (x) { return x.id === cBad; })[0];
    log(!!cBad2.err && cBad2.err.indexOf('JSON') >= 0, '信号通道：通道解不开的帧会挂在通道上，面板上看得到', cBad2.err);
    NF.ifaceChanDel(cBad);
    log(NF.ifaceState().chan.length === 2, '信号通道：删得掉', NF.ifaceState().chan.length + ' 条');
    /* 顺便接一根键盘线，存盘往返那一节要拿它对账 */
    NF.ifaceBind(ci0, { kind: 'key', code: 'Digit3', value: 1 });
    /* 接线跟着工程文件走：v3 容器往返之后还在（运行时开着的状态也一起存） */
    NF.snapshot();
    const wantIn = JSON.stringify(NF.ifaceState().inBind);
    const wantOut = JSON.stringify(NF.ifaceState().outBind);
    const chanProj = function (list) {
      return JSON.stringify(list.map(function (x) {
        return [x.name, x.dir, x.xp, x.codec, x.addr, x.port, x.url, x.slots, x.period, x.on];
      }));
    };
    const wantChan = chanProj(NF.ifaceState().chan);
    const rtBuf = await NF.encodeV3({});
    NF.clear();
    await raf();
    log(NF.ifaceState().inBind.length === 0, '接口运行时：新建工程会把接线清掉（神经元编号换了含义）',
        NF.ifaceState().inBind.length + ' 条');
    await NF.loadBuffer(rtBuf);
    await raf();
    log(JSON.stringify(NF.ifaceState().inBind) === wantIn && JSON.stringify(NF.ifaceState().outBind) === wantOut,
        '接口运行时：接线跟着 .nforge 工程文件走，存了再开还在', JSON.stringify(NF.ifaceState().inBind));
    log(chanProj(NF.ifaceState().chan) === wantChan,
        '信号通道：通道（传输 / 编码 / 信号位 / 周期）也跟着工程文件走', chanProj(NF.ifaceState().chan));
    log(NF.ifaceState().on === true, '接口运行时：工程里存的「运行时是开着的」也一起复原', 'on=' + NF.ifaceState().on);
    /* 接管按键：绑了 2 之后按 2 不再触发「把选中神经元设成输出接口」的软件快捷键 */
    NF.select([wmid], []);
    await raf();
    log(NF.node(wmid).io === 0, '接口运行时：按之前这个神经元的接口标记是「无」', 'io=' + NF.node(wmid).io);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', key: '3', bubbles: true, cancelable: true }));
    await raf();
    log(NF.node(wmid).io === 0, '接口运行时：绑定的键被接管，不再触发软件快捷键（按 3 没把它设成双向接口）',
        'io=' + NF.node(wmid).io);
    /* 面板：输入通道 / 输出通道两页都要真的画出东西 */
    NF.ifacePanel('rt');
    await raf();
    const rtBox = document.getElementById('iobody');
    const rtInRows = rtBox.querySelectorAll('[data-rtin]').length;
    const rtKeyBtn = rtBox.querySelector('button[data-rt="grab"]');
    log(rtInRows === NF.ifaceState().ins.length && !!rtKeyBtn && rtKeyBtn.textContent.indexOf('3') >= 0,
        '接口运行时：运行时面板列出了输入接口，键位按钮显示的是绑的那个键',
        '行数=' + rtInRows + ' 按钮=' + (rtKeyBtn ? rtKeyBtn.textContent : '没有'));
    const rtOutSel = rtBox.querySelector('select[data-rt="outkind"]');
    log(!!rtOutSel && rtOutSel.value === 'log', '接口运行时：输出通道的动作下拉出现了', rtOutSel ? rtOutSel.value : '没有');
    log(rtBox.querySelectorAll('[data-rt="on"]').length === 1, '接口运行时：总开关在面板里');
    /* #0 的编号也是 0，而 0 又是「没在采集」的哨兵——两边都不能认错 */
    const grab0 = rtBox.querySelector('button[data-rt="grab"][data-id="0"]');
    log(!!grab0 && grab0.textContent.indexOf('按下') < 0,
        '接口运行时：#0 号接口的采集按钮不会被误当成「正在采集」', grab0 ? grab0.textContent : '没有这一行');
    /* 英文界面：标题 / 按钮 / 开关这些"面板骨架"要全翻过去（日志里的内容不算骨架） */
    NF.setLang('en');
    NF.ifacePanel('rt');
    await raf(); await raf();
    const cjkOf = (sel) => (Array.from(document.querySelectorAll(sel)).map((x) => x.textContent).join(' ')
        .match(/[\u4e00-\u9fff]+/g) || []);
    const enHead = cjkOf('#iobody .sec > h3'), enBtn = cjkOf('#iobody button'), enChk = cjkOf('#iobody label.chk');
    log(!enHead.length && !enBtn.length && !enChk.length,
        '英文界面：接口运行时的标题 / 按钮 / 开关都翻了英文',
        JSON.stringify({ 标题: enHead, 按钮: enBtn, 开关: enChk }));
    const enCard = document.querySelector('#iobody .rstat');
    log(!!enCard && !/[\u4e00-\u9fff]/.test(enCard.textContent),
        '英文界面：信号通道卡片的状态行（收几帧 / 周期 / 打开没打开）也翻了', enCard ? enCard.textContent : '没有卡片');
    NF.setLang('zh');
    NF.ifacePanel('rt');
    await raf(); await raf();
    const zhBack = document.getElementById('iobody').textContent;
    log(zhBack.indexOf('总开关') >= 0 && zhBack.indexOf('运行日志') >= 0 && zhBack.indexOf('信号通道') >= 0,
        '英文切回中文：接口运行时面板原样复原');
    document.getElementById('ioclose').click();
    await raf();
    log(!document.getElementById('iopanel').classList.contains('show'), '接口运行时：面板关得掉');
    /* ---- 33. 外部操作（桌面版才有的那条通道） ----------------------------------------
       这一段**两种环境都要过**：浏览器里没有这条通道、桌面壳里有。所以断言按 sysReady 分叉，
       两边都得说清楚自己的事实——不许在浏览器里假装能，也不许在壳子里假装不能。
       真的跑命令 / 下载 / 开工程那套是在桌面壳里单独实测的（见 README）。 */
    {
      const t33 = NF.aiTools().map((t) => t.name);
      const want33 = ['sys_info', 'sys_list_dir', 'sys_read_text', 'sys_write_text', 'sys_download', 'sys_run', 'sys_open_project'];
      const miss33 = want33.filter((n) => t33.indexOf(n) < 0);
      log(miss33.length === 0, '外部操作：7 个 sys_* 工具都进了工具表',
          miss33.length ? '缺 ' + miss33.join(',') : t33.length + ' 个工具');

      const st33 = NF.aiState();
      const ready33 = st33.sysReady;
      log(typeof ready33 === 'boolean' && st33.sysFs === false && st33.sysRun === false,
          '外部操作：状态里读得到这条通道，而且两道门开局都是关的',
          JSON.stringify({ ready: ready33, fs: st33.sysFs, run: st33.sysRun }));
      out.push('INFO | 外部通道 | ' + (ready33 ? '桌面壳：这条通道在' : '浏览器：没有这条通道'));

      const brief33 = String(((await NF.aiTool('get_state', {})).result || {})['外部操作'] || '');
      log(brief33.length > 0 && (ready33 ? brief33.indexOf('关着') >= 0 : brief33.indexOf('浏览器') >= 0),
          '外部操作：get_state 里如实报告这条通道的状态', brief33);

      /* sys_info 不设门：桌面壳里直接能探，浏览器里明确说没有这条通道 */
      const r33a = await NF.aiTool('sys_info', {});
      if (ready33) {
        log(r33a.ok === true && !!r33a.result && !!r33a.result.os && !!r33a.result.home,
            '外部操作：桌面壳里 sys_info 不用开开关就能探环境',
            JSON.stringify({ os: r33a.result && r33a.result.os, home: r33a.result && r33a.result.home }));
      } else {
        log(r33a.ok === false && /桌面版/.test(String(r33a.error)),
            '外部操作：浏览器里 sys_info 明确拒绝，不假装能', String(r33a.error).slice(0, 44));
      }

      /* 门没开时必须是「拒」，而且拒得有理有据：壳子里说该开哪个开关，浏览器里说没有这条通道 */
      const r33b = await NF.aiTool('sys_run', { cmd: 'echo hi' });
      const why33 = String(r33b.error || '');
      log(r33b.ok === false && (ready33 ? /开关没打开/.test(why33) : /桌面版/.test(why33)),
          ready33 ? '外部操作：桌面壳里门没开就拒，原文说清该开哪个开关' : '外部操作：浏览器里 sys_run 拒绝（不是静默失败）',
          why33.slice(0, 44));
      const r33c = await NF.aiTool('sys_read_text', { path: 'C:/肯定不存在的文件.txt' });
      log(r33c.ok === false, '外部操作：读文件同样过不去（门没开 / 没这条通道）', String(r33c.error || '').slice(0, 30));

      /* 勾选框：浏览器里必须灰掉，壳子里必须能勾、而且还真的管用 */
      const cb33 = document.getElementById('ai-sysfs');
      const cb33r = document.getElementById('ai-sysrun');
      log(!!cb33 && !!cb33r, '外部操作：设置面板里有那两个勾选框');
      if (!!cb33 && !ready33) {
        log(cb33.disabled === true && cb33r.disabled === true && cb33.checked === false,
            '外部操作：浏览器版把两个勾选框灰掉，勾不上');
        cb33.click();
        log(NF.aiState().sysFs === false, '外部操作：灰掉的勾选框点了也不生效');
      }
      if (!!cb33 && ready33) {
        log(cb33.disabled === false && cb33r.disabled === false, '外部操作：桌面壳里勾选框是可点的');
        cb33.click();
        await raf(); await raf();
        log(NF.aiState().sysFs === true, '外部操作：勾一下，门真的开了（状态跟着变）',
            JSON.stringify(NF.aiState().sysFs));
        const r33d = await NF.aiTool('sys_list_dir', {});
        log(r33d.ok === true && Array.isArray(r33d.result),
            '外部操作：门开了之后列目录真的能跑', (r33d.result || []).length + ' 项');
        cb33.click();
        await raf(); await raf();
        const r33e = await NF.aiTool('sys_list_dir', {});
        log(NF.aiState().sysFs === false && r33e.ok === false,
            '外部操作：再点一下就关了，立刻又列不了（不用重启）');
      }
      const note33 = document.getElementById('ai-sysnote');
      log(!!note33 && note33.textContent.length > 10 &&
          (ready33 ? note33.textContent.indexOf('碰不到这台机器') >= 0 : note33.textContent.indexOf('桌面版') >= 0),
          '外部操作：设置面板那行状态如实写明现在能不能碰本机',
          note33 ? note33.textContent.slice(0, 30) : '');

      const man33 = NF.aiManual();
      log(NF.aiState().manualVersion === '{{MV}}' && man33.indexOf('外部操作：AI 真的能在本机装东西') >= 0 &&
          man33.indexOf('这不是沙箱') >= 0 && man33.indexOf('每次打开软件都要重新勾一次') >= 0,
          '外部操作：手册升到 r35，通道 / 边界 / 重启不保留都写了');
      /* 用户问过「没有联网搜索怎么下模型」——手册必须把这条说清楚，且提示词里要带着它 */
      log(man33.indexOf('你没有网页搜索工具') >= 0 && man33.indexOf('完整的联网能力') >= 0 &&
          man33.indexOf('huggingface.co/api/models') >= 0 && man33.indexOf('api.github.com/search') >= 0 &&
          man33.indexOf('winget search') >= 0 && man33.indexOf('不要凭记忆编网址') >= 0,
          '外部操作：手册写清了「没有网页搜索、但有联网能力」这条——怎么按名字找模型 / 找包 / 找软件');
      log(NF.aiPrompt().indexOf('huggingface.co/api/models') >= 0,
          '外部操作：这条进了系统提示词，AI 一上来就知道该去问谁的搜索接口');
      const pr33 = NF.aiPrompt();
      log(pr33.indexOf('【外部操作】') >= 0 && pr33.indexOf('sys_download') >= 0,
          '外部操作：系统提示词里写清了这条通道和边界');
      const au33 = NF.aiAudit();
      log(au33.missing.length === 0, '外部操作：工具表里写的接口一个都没写错', au33.missing.join(','));
    }
    /* ---- 34. 智能体那一层（长活丢后台 / 找文件 / 改一处 / 流式 / 随时叫停） -------------
       浏览器里能验的：工具在不在、门开不开、状态报不报得出来、压缩摘要插没插、界面上那些开关在不在。
       真跑起来的流式输出和「停止」，只有桌面壳里有那条通道，那一半在壳子那份自测里做。 */
    try {
      const t34 = NF.aiTools().map((x) => x.name);
      const want34 = ['job_start', 'job_poll', 'job_kill', 'job_list', 'sys_stat', 'sys_mkdir', 'sys_edit_text', 'sys_find'];
      const miss34 = want34.filter((n) => t34.indexOf(n) < 0);
      log(miss34.length === 0, '智能体层：8 个新工具都进了工具表',
          miss34.length ? '缺 ' + miss34.join(',') : t34.length + ' 个工具');

      const st34 = NF.aiState();
      const ready34 = st34.sysReady;
      log(typeof st34.stream === 'boolean' && typeof st34.streamBad === 'boolean' &&
          typeof st34.maxTurns === 'number' && st34.maxTurns >= 4 && st34.maxTurns <= 400 &&
          typeof st34.stop === 'boolean' && typeof st34.jobs === 'number' && typeof st34.did === 'number',
          '智能体层：状态里读得到流式 / 轮数上限 / 停止 / 后台数 / 做过的事',
          JSON.stringify({ stream: st34.stream, maxTurns: st34.maxTurns, stop: st34.stop, jobs: st34.jobs }));

      /* 参数没填全时必须在本地就拦住：别把一条空命令发到壳子里去 */
      const r34a = await NF.aiTool('sys_edit_text', { path: 'x.txt' });
      log(r34a.ok === false && String(r34a.error).indexOf('find 不能空') >= 0,
          '智能体层：改文件不给 find 直接拦下（本地就拒，不惊动壳子）', String(r34a.error || '').slice(0, 34));
      const r34b = await NF.aiTool('sys_find', { pattern: '*.py' });
      log(r34b.ok === false && String(r34b.error).indexOf('root 不能空') >= 0,
          '智能体层：找文件不给 root 直接拦下', String(r34b.error || '').slice(0, 34));
      const r34c = await NF.aiTool('job_start', {});
      log(r34c.ok === false && String(r34c.error).indexOf('cmd 不能空') >= 0,
          '智能体层：后台任务不给命令直接拦下', String(r34c.error || '').slice(0, 34));
      const r34d = await NF.aiTool('job_poll', {});
      log(r34d.ok === false && String(r34d.error).indexOf('id 不能空') >= 0,
          '智能体层：轮询不给 id 直接拦下', String(r34d.error || '').slice(0, 34));

      /* 门没开：这些工具要么说「开关没打开」，要么说「浏览器版没这条通道」，都不许静默成功 */
      const r34e = await NF.aiTool('job_list', {});
      const why34 = String(r34e.error || '');
      log(r34e.ok === false && (ready34 ? why34.indexOf('开关没打开') >= 0 : why34.indexOf('桌面版') >= 0),
          ready34 ? '智能体层：桌面壳里门没开就拒（说清该开哪个开关）' : '智能体层：浏览器里后台任务没有这条通道（明说，不假装）',
          why34.slice(0, 40));
      const r34f = await NF.aiTool('sys_stat', { path: 'C:/Windows' });
      const why34f = String(r34f.error || '');
      log(r34f.ok === false && (ready34 ? why34f.indexOf('开关没打开') >= 0 : why34f.indexOf('桌面版') >= 0),
          '智能体层：看路径状态同样过不去（不是静默失败）', why34f.slice(0, 40));
      out.push('INFO | 智能体层 | ' + (ready34 ? '桌面壳：后台任务/找文件/改一处都在' : '浏览器：只有界面这一半'));

      /* 说明书里那两句最容易踩的坑：轮询等待写 30 秒、改文件要唯一 */
      const d34 = {};
      NF.aiTools().forEach((x) => { d34[x.name] = x.desc; });
      log(String(d34.job_poll || '').indexOf('30 秒') >= 0 && String(d34.job_poll || '').indexOf('6 秒') < 0,
          '智能体层：job_poll 的等待上限说明跟实现对齐（30 秒）');
      log(String(d34.job_start || '').indexOf('后台') >= 0 && String(d34.sys_edit_text || '').indexOf('唯一') >= 0 &&
          String(d34.sys_find || '').indexOf('不要硬猜') + String(d34.sys_find || '').indexOf('先用它找') >= 0,
          '智能体层：长活丢后台 / 改一处要唯一 / 找不到先用它找，都写进了工具说明');

      /* 界面：停止键、本机权限小标、两个新设置项 */
      const stop34 = document.getElementById('aistop');
      log(!!stop34 && stop34.dataset.aicmd === 'stop', '智能体层：标题栏里有「停止」键');
      log(!!stop34 && getComputedStyle(stop34).display === 'none',
          '智能体层：没在跑的时候停止键是藏着的', stop34 ? getComputedStyle(stop34).display : '');
      const chip34 = document.getElementById('aisyschip');
      log(!!chip34 && chip34.textContent.indexOf('本机：') === 0,
          '智能体层：标题栏那个小标如实写着这台机器能不能被碰', chip34 ? chip34.textContent : '');

      NF.aiSetUI({ set: true, folded: false });
      await raf(); await raf();
      const cbs34 = document.getElementById('ai-stream');
      const cmt34 = document.getElementById('ai-maxturns');
      log(!!cbs34 && !!cmt34, '智能体层：设置面板里有「流式输出」和「最多来回」');
      if (cbs34) {
        log(cbs34.checked === NF.aiState().stream, '智能体层：流式那个勾选框跟状态一致');
        const was34 = NF.aiState().stream;
        cbs34.click();
        await raf(); await raf();
        log(NF.aiState().stream === !was34, '智能体层：点一下就真的换了（来回都能切）');
        cbs34.click();
        await raf(); await raf();
        log(NF.aiState().stream === was34 && NF.aiState().streamBad === false,
            '智能体层：重新勾上时会把上次「端点不认流式」的结论清掉，再试一次');
      }
      if (cmt34) {
        const setMt = (v) => { cmt34.value = v; cmt34.dispatchEvent(new Event('change')); };
        setMt('99999');
        log(NF.aiState().maxTurns === 400 && cmt34.value === '400', '智能体层：轮数上限填太大了夹到 400',
            NF.aiState().maxTurns + ' / 框里 ' + cmt34.value);
        setMt('0');
        log(NF.aiState().maxTurns === 4 && cmt34.value === '4', '智能体层：填太小（0）夹到 4', NF.aiState().maxTurns);
        setMt('abc');
        log(NF.aiState().maxTurns === 4 && cmt34.value === '4', '智能体层：填了不是数字的就保持原值，不当成 0');
        setMt('80');
        log(NF.aiState().maxTurns === 80, '智能体层：填回来就是 80');
      }

      /* 停止键：点一下状态就置位（不是静默失效），新对话再清掉 */
      NF.aiNewSession('自测');
      await NF.aiTool('get_state', {});
      const didBefore34 = NF.aiState().did;
      log(didBefore34 >= 1, '智能体层：调过一次工具就会记一笔「做过什么」', didBefore34 + ' 条');
      if (stop34) {
        stop34.click();
        await raf(); await raf();
        log(NF.aiState().stop === true, '智能体层：点「停止」状态真的置位了');
      }
      NF.aiNewSession('自测');
      await raf(); await raf();
      log(NF.aiState().stop === false && NF.aiState().did === 0,
          '智能体层：新对话把停止标记和「做过什么」都清干净',
          JSON.stringify({ stop: NF.aiState().stop, did: NF.aiState().did }));

      /* 上下文压缩：塞满之后要留一张「做过什么」的单子，不能光丢 */
      await NF.aiTool('get_state', {});
      const tr34 = NF.aiTrim(80);
      log(tr34.msgs <= 60 && tr34.digest === 1,
          '智能体层：上下文压到上限内，而且插了一张「做过什么」的单子（不是光丢）',
          JSON.stringify(tr34));
      NF.aiNewSession('自测');

      /* 手册跟着一起升：新的这一节得写进去，提示词里也得挂上 */
      const man34 = NF.aiManual();
      log(NF.aiState().manualVersion === '{{MV}}' && man34.indexOf('智能体怎么干活') >= 0 &&
          man34.indexOf('job_start') >= 0 && man34.indexOf('别原地打转') >= 0,
          '智能体层：手册升到 r35，把长活/找文件/改一处/叫停这一节写进去了');
      const pr34 = NF.aiPrompt();
      log(pr34.indexOf('智能体怎么干活') >= 0 && pr34.indexOf('job_poll') >= 0,
          '智能体层：系统提示词里带着这一节，AI 一上来就知道怎么干长活');
      const au34 = NF.aiAudit();
      log(au34.missing.length === 0 && au34.manualVersion === '{{MV}}',
          '智能体层：工具表里写的接口一个都没写错', au34.missing.join(','));
    } catch (e) {
      out.push('ERROR | ' + ((e && e.stack) || e));
    }

      /* ---- 第 35 组：自定义工具（AI 给自己长本事）+ 配置落盘 ---- */
      try {
        const st35 = NF.aiState();
        const names35 = NF.aiTools().map((x) => x.name);
        const need35 = ['list_user_tools', 'reload_tools', 'save_tool', 'delete_tool'];
        log(names35.length >= 95 && need35.every((n) => names35.indexOf(n) >= 0),
            '自定义工具：工具表里多了 list_user_tools / reload_tools / save_tool / delete_tool（共 ' + names35.length + ' 个）',
            names35.length);
        log(typeof st35.cfgAt === 'number' && typeof st35.cfgDir === 'string' && typeof st35.toolsDir === 'string',
            '自定义工具：状态里报出配置时间戳和两个目录',
            JSON.stringify({ cfgAt: st35.cfgAt, cfgDir: st35.cfgDir, toolsDir: st35.toolsDir }));
        log(!!NF.ext && typeof NF.ext.call === 'function' && typeof NF.ext.tools === 'function' &&
            typeof NF.ext.defineTool === 'function' && typeof NF.ext.state === 'function' && typeof NF.ext.manual === 'function',
            '自定义工具：NF.ext 桥上挂着 tools / state / call / defineTool / manual');
        log(NF.ext.manual() === '{{MV}}' && NF.ext.cfgDir() === st35.cfgDir && NF.ext.toolsDir() === st35.toolsDir,
            '自定义工具：NF.ext 报的手册版本和两个目录跟状态里一致');
        const ext35 = NF.ext.call('seed');
        log(typeof ext35 === 'number' && ext35 === NF.seed(), '自定义工具：NF.ext.call 不带参数也调得通，回来的就是接口原本的返回', ext35);
        const ext35b = NF.ext.call('nameStats', []);
        log(!!ext35b && typeof ext35b.segBytes === 'number' && typeof ext35b.entries === 'number',
            '自定义工具：NF.ext.call 带参数数组也调得通，返回的是接口原本的对象', JSON.stringify(ext35b));
        const extBad35 = (() => { try { NF.ext.call('q35_not_a_fn', []); return ''; } catch (e) { return String((e && e.message) || e); } })();
        log(extBad35.indexOf('没有这个脚本接口') >= 0, '自定义工具：NF.ext.call 调不存在的接口会说清楚，不静默失败', extBad35.slice(0, 70));

        /* 挂一个合法工具：能挂上、工具表和状态都认，还能被工具通道真的叫起来 */
        log(typeof NF.defineTool === 'function' && typeof st35.cfgFile === 'string' && typeof NF.ext.cfgFile === 'function' && NF.ext.cfgFile() === st35.cfgFile,
            '自定义工具：NF.defineTool 别名和 NF.ext.cfgFile 都挂上了（工具文件照着手册写就能跑）');
        log(NF.defineTool({ name: 'q35_probe', desc: '自测用的假工具，把参数原样返回', args: { x: ['int?', '随便给个数'] },
              run: (a) => ({ got: a.x === undefined ? 0 : a.x, dir: NF.ext.toolsDir() }) }) === 'q35_probe',
            '自定义工具：挂一个合法工具会返回它的名字');
        log(NF.aiTools().map((x) => x.name).indexOf('q35_probe') >= 0 && NF.aiState().userTools.indexOf('q35_probe') >= 0,
            '自定义工具：挂上之后工具表和状态里都真的有它');
        const call35 = await NF.aiTool('q35_probe', { x: 7 });
        log(call35.ok === true && call35.result.got === 7,
            '自定义工具：通过工具通道真的能调起来，参数也传到了', JSON.stringify(call35));

        /* 校验：不合规的四种一律拒掉，而且理由说得清楚 */
        const bad35 = (d) => { try { NF.aiDefineTool(d); return 'ok'; } catch (e) { return String((e && e.message) || e); } };
        const b35a = bad35({ name: 'Q35_Bad', desc: 'x', run: () => 1 });
        const b35b = bad35({ name: 'get_state', desc: 'x', run: () => 1 });
        const b35c = bad35({ name: 'q35_nodesc', run: () => 1 });
        const b35d = bad35({ name: 'q35_norun', desc: 'x' });
        log(b35a !== 'ok' && b35b !== 'ok' && b35c !== 'ok' && b35d !== 'ok',
            '自定义工具：名字不合法 / 想盖内置 / 没 desc / run 不是函数，四种都被拒了',
            [b35a, b35b, b35c, b35d].join(' | '));
        log(b35a.indexOf('工具名') >= 0 && b35b.indexOf('内置') >= 0 && b35c.indexOf('desc') >= 0 && b35d.indexOf('run') >= 0,
            '自定义工具：拒绝的理由说得清楚，不是一句「失败」');

        /* 这条路分两种环境：浏览器版必须明确说「没有」；桌面壳里读的是真目录。
           同一份自测要在两边都过，所以按环境分别断言，而不是只写一边。 */
        const isDesk35 = st35.sysReady === true;
        const rl35 = await NF.aiUserToolsReload();
        if (isDesk35) {
          log(rl35.errors.length === 0 && Array.isArray(rl35.loaded),
              '自定义工具：桌面壳里 reload_tools 读的是真目录（现在装着 ' + rl35.loaded.length + ' 个）', JSON.stringify(rl35).slice(0, 110));
        } else {
          log(rl35.loaded.length === 0 && rl35.errors.length === 1 && rl35.errors[0].indexOf('桌面版') >= 0,
              '自定义工具：浏览器版调 reload_tools 会明确说这条路只有桌面版有', JSON.stringify(rl35));
        }
        /* 桌面壳里 reload 是真的去重读磁盘目录：内存里那个假工具会被清掉 —— 这是对的，不是 bug。
           浏览器版那条分支提前就 return 了，什么都不动。这里把假工具补回去，后面接着验。 */
        if (isDesk35 && NF.aiState().userTools.indexOf('q35_probe') < 0) {
          NF.defineTool({ name: 'q35_probe', desc: '自测用的假工具，把参数原样返回', args: { x: ['int?', '随便给个数'] },
            run: (a) => ({ got: a.x === undefined ? 0 : a.x, dir: NF.ext.toolsDir() }) });
          log(NF.aiState().userTools.indexOf('q35_probe') >= 0,
              '自定义工具：桌面壳里 reload 是真的按磁盘目录重挂（内存里那个假工具被清掉，再挂回来）');
        }
        const ut35 = NF.aiUserTools();
        log(!!ut35 && ut35.builtin >= 91 && Array.isArray(ut35.user) && typeof ut35.dir === 'string',
            '自定义工具：NF.aiUserTools 报得出内置几个 / 自定义挂了哪些 / 目录在哪', JSON.stringify(ut35));
        const info35 = await NF.aiTool('list_user_tools', {});
        log(info35.ok === true && (isDesk35
              ? String(info35.result['设置文件'] || '').indexOf('settings.json') > 0
              : String(info35.result['说明'] || '').indexOf('桌面版') >= 0),
            '自定义工具：list_user_tools 这个工具真的能调，并且如实说清这条路在不在', JSON.stringify(info35.result).slice(0, 110));
        const sv35 = await NF.aiTool('save_tool', { name: 'q35_x', code: 'NF.defineTool({name:"q35_x",desc:"x",run:function(){return 1;}});' });
        log(sv35.ok === false && String(sv35.error).indexOf(isDesk35 ? '开关' : '桌面版') >= 0,
            isDesk35 ? '自定义工具：桌面壳里没勾「读写文件」时，save_tool 会被那道门挡住'
                     : '自定义工具：浏览器版调 save_tool 会被挡住并说清原因', JSON.stringify(sv35).slice(0, 110));
        log(NF.aiTools().map((x) => x.name).indexOf('q35_probe') >= 0 && NF.aiState().userTools.indexOf('q35_probe') >= 0,
            '自定义工具：挡住的只是「加新工具」这件事，已经挂上的工具不受影响');

        /* 配置：双写（本机存储 + 落盘文件），启动时按时间戳取新的那份 */
        const boot35 = await NF.aiCfgBoot();
        if (isDesk35) {
          /* 壳子里这一步会把磁盘那份合并进来；不去动用户的真配置，只确认它说得清自己在哪 */
          log(!!boot35 && boot35.ok === true && String(boot35.dir).indexOf(':') > 0 && String(boot35.settings).indexOf('settings.json') > 0,
              '配置落盘：桌面壳里开机读配置报得出设置目录和设置文件', JSON.stringify(boot35).slice(0, 120));
          log(NF.aiState().cfgDir === boot35.dir && NF.aiState().cfgFile === boot35.settings,
              '配置落盘：状态里的目录跟这一步报的一致');
        } else {
          NF.aiConfig({ base: 'https://example.invalid/v1', model: 'q35-model' });
          await raf();
          const j35 = (() => { try { return JSON.parse(localStorage.getItem('nf.ai') || '{}'); } catch (e) { return null; } })();
          log(!!j35 && j35.base === 'https://example.invalid/v1' && j35.model === 'q35-model' && typeof j35.at === 'number',
              '配置落盘：改完设置立刻写进本机存储，并带上时间戳', JSON.stringify(j35).slice(0, 110));
          log(!!boot35 && boot35.ok === false && String(boot35.why || '').indexOf('localStorage') >= 0,
              '配置落盘：浏览器版跑开机读配置会老实说只有本机存储一份', JSON.stringify(boot35));
          log(NF.aiState().base === 'https://example.invalid/v1' && NF.aiState().model === 'q35-model',
              '配置落盘：读回来还是刚才那份，没有被就地改掉');
          NF.aiConfig({ base: 'https://api.deepseek.com/v1', model: 'deepseek-flash' });
          await raf();
          log(NF.aiState().base === 'https://api.deepseek.com/v1' && NF.aiState().model === 'deepseek-flash',
              '配置落盘：改回来也立刻生效（这一组不给用户留副作用）');
        }

        /* 手册 r32：这一节得写进去，提示词里也得挂上 */
        const man35 = NF.aiManual();
        log(NF.aiState().manualVersion === '{{MV}}' && man35.indexOf('自定义工具') >= 0 &&
            man35.indexOf('NF.defineTool') >= 0 && man35.indexOf('reload_tools') >= 0 && man35.indexOf('NF.ext.call') >= 0 &&
            man35.indexOf('APPDATA') >= 0,
            '自定义工具：手册升到 r35，把「怎么给自己加本事」和边界写进去了');
        const pr35 = NF.aiPrompt();
        log(pr35.indexOf('自定义工具') >= 0 && pr35.indexOf('reload_tools') >= 0,
            '自定义工具：系统提示词里带着这一节，AI 一上来就知道自己能长本事');
        const au35 = NF.aiAudit();
        log(au35.missing.length === 0 && au35.manualVersion === '{{MV}}' && au35.tools >= 95,
            '自定义工具：工具表里写的接口一个都没写错，工具数 ' + au35.tools, au35.missing.join(','));

        /* 手册 r44：对话存档（一个工程里可以有好几段对话，跟着工程文件走） */
        const man44 = NF.aiManual();
        log(NF.aiState().manualVersion === '{{MV}}' && man44.indexOf('对话存档') >= 0 &&
            man44.indexOf('ai_session_read') >= 0 && man44.indexOf('.nforge') >= 0,
            '对话存档：手册升到 r44，把「对话存哪、怎么跟着工程走」写进去了');
        const pr44 = NF.aiPrompt();
        log(pr44.indexOf('对话存档') >= 0 && pr44.indexOf('ai_sessions') >= 0,
            '对话存档：系统提示词里带着这一节，AI 一上来就知道有这回事');
        const tools44 = NF.aiTools().map((x) => x.name);
        log(['ai_sessions', 'ai_session_new', 'ai_session_switch', 'ai_session_read'].every((n) => tools44.indexOf(n) >= 0),
            '对话存档：四个工具都挂上了', tools44.length + ' 个工具');

        NF.aiSessionReset('自测起点');
        const q0 = NF.aiSessions();
        const qid0 = q0.当前;
        log(q0.sessions.length === 1 && q0.sessions[0].正在用 === true && !!qid0,
            '对话存档：一开始就是一段对话，并标出正在用的是哪一段', q0.sessions.length + ' 段');
        const qid1 = NF.aiSessionNew('自测另一段');
        NF.aiSessionRename(qid0, '第一段（改过名）');
        log(NF.aiSessions().sessions.length === 2 && NF.aiSessions().当前 === qid1,
            '对话存档：新开一段 = 旧的留着、当前换成新的');
        log(NF.aiSessionLoad(qid0) === true && NF.aiSessions().当前 === qid0,
            '对话存档：能切回旧的那一段');
        let qerr = '';
        try { NF.aiSessionDel(qid0); } catch (e) { qerr = String((e && e.message) || e); }
        log(qerr.indexOf('先切') >= 0, '对话存档：正在用的那段不给删，而且说清为什么', qerr);

        /* 跟着文件走：编进容器 -> 清干净 -> 读回来 */
        NF.clear();
        const qidR = NF.aiSessions().当前;
        NF.aiSessionRename(qidR, '自测：跟着工程走的这段');
        const qa = NF.addNode(0, 0, 0), qb = NF.addNode(8, 0, 0);
        NF.addEdge(qa, qb, 0.4);
        const qdoc = NF.aiSessionDoc();
        const qbuf = await NF.encodeV3({ chunkNeurons: 4 });
        const qh = NF.inspectFile(qbuf);
        log(!!qh.ai && qh.ai.count === qdoc.sessions.length && qh.version === 3,
            '对话存档：写进了工程文件头（字节布局版本一个数字都没动）', JSON.stringify(qh.ai));
        NF.aiSessionReset('自测：模拟换台电脑');
        const qr = await NF.loadBuffer(qbuf);
        const qback = NF.aiSessions();
        log(qback.sessions.length === qdoc.sessions.length && qback.当前 === qdoc.sid && qr.n === 2 && qr.e === 1,
            '对话存档：从工程文件读回来，对话和图都回来了',
            qback.sessions.length + ' 段 · 当前=' + qback.当前 + ' · 图 ' + qr.n + '/' + qr.e);
        log(qback.sessions.filter((x) => x.标题 === '自测：跟着工程走的这段').length === 1,
            '对话存档：每段的标题也回来了');
        const qj = NF.serializeV2();
        log(!!qj.ai && qj.ai.sessions.length >= 1, '对话存档：v2 JSON 工程里也带着对话');
        const qput = await NF.aiArchivePut();
        log(!!(qput && qput.ok), '对话存档：本机那份兜底副本写得进去', 'pid=' + (qput && qput.pid));
        NF.aiSessionReset('自测：本机存档');
        const qgot = await NF.aiArchiveLoad(qput.pid);
        log(qgot.added >= 1, '对话存档：本机那份能拿回列表里', '拿回 ' + qgot.added + ' 段');
        log(await NF.aiArchiveDel(qput.pid) === true, '对话存档：本机那份能删掉');
        NF.aiNewSession('自测');
      } catch (e) {
        out.push('ERROR | ' + ((e && e.stack) || e));
      }

    /* ---- 35. 循环网（回边 / 自环）：编译与模拟都按时间展开 ----------------------------
       用户自己那张 born-wired-cortex 就带反馈连接。老版本遇到环直接拒绝，这一版给环一条
       时间轴：回边读「上一拍」的值，整张图按时间展开。这一段要验到底：
         1 前馈工程一个字没变（没回边 -> 压根不走这条路）
         2 环网能编：recurrent=true、NUM_STEPS 跟着展开步数走
         3 自环不再是错误，编辑器里也画得出来
         4 模拟激活真的按拍跑：回边读上一拍，信号每拍重新注入
         5 展开步数在编译对话框里改得动、落得下
       手搭的小网：a -> b、b -> c，再加一条 c -> b 的回边（权重 0.5），c 是输出。
       b 和 c 互相喂，所以两条边都算回边（强连通分量内部的边），一共 2 条。
       去掉回边之后 a=第0波、b=第1波、c 没有前向入边也落在第0波，一拍 2 波。
       手算（阈值 0.5，ReLU）：b_k = 1 + 0.5*c_(k-1)、c_k = b_(k-1)，第 0 拍 c 还是 0；
       跑满 8 拍时 c = 1.875。 */
    NF.clear();
    await raf();
    /* 播放是 setInterval 驱动的：无头浏览器会把后台页的定时器压到 1 秒一次，
       所以别写死 sleep，直接等它自己播完。 */
    const simPlayWait = async () => {
      const t0 = Date.now();
      while (NF.simState().playing && Date.now() - t0 < 6000) await sleep(50);
      return NF.simState();
    };
    {
      const ra = NF.addNode(0, 0, 0), rb = NF.addNode(20, 0, 0), rc = NF.addNode(40, 0, 0);
      NF.addEdge(ra, rb, 1.0); NF.addEdge(rb, rc, 1.0); NF.addEdge(rc, rb, 0.5);
      NF.setIO([ra], 1); NF.setIO([rc], 2);
      NF.setThr([ra], 0.5); NF.setThr([rb], 0.5); NF.setThr([rc], 0.5);
      await raf();
      NF.recSetSteps(8);
      const recComp = NF.compile("pytorch");
      log(recComp.errors.length === 0 && recComp.recurrent === true && recComp.numRecEdges === 2 &&
          recComp.selfLoops === 0,
          "循环网：有环的工程编得出来，回边数如实报出来（b 与 c 这条回路就是 2 条边）",
          recComp.errors.join(" | ") || ("回边 " + recComp.numRecEdges + " 条，自环 " + recComp.selfLoops));
      log(recComp.code.indexOf("self.recurrent = True") >= 0 && recComp.code.indexOf("NUM_STEPS = 8") >= 0 &&
          recComp.code.indexOf("self.num_rec_edges") >= 0 && recComp.code.indexOf("self.rptr") >= 0,
          "循环网：生成的 Python 里标了 recurrent / NUM_STEPS / num_rec_edges / rptr");
      log(recComp.report.indexOf("循环结构") >= 0 && recComp.report.indexOf("环形依赖") < 0,
          "循环网：报告说清哪几条是回边，不再报「环形依赖」");
      const recExe = NF.compile("exe");
      log(recExe.errors.length === 0 && recExe.code.indexOf("N_REC_EDGES") >= 0 && recExe.code.indexOf("hp[") >= 0,
          "循环网：独立 exe 那份也生成了（流式，喂一行 = 算一拍）",
          recExe.errors.join(" | "));

      /* 4 模拟激活：回边读上一拍 */
      const rs8 = NF.simCompute([ra], {});
      log(rs8.activated === 3 && rs8.maxWave === 15 && rs8.byWave[0][0] === ra &&
          rs8.byWave[1][0] === rb && rs8.byWave[2].indexOf(rc) >= 0 && rs8.byWave[3][0] === rb,
          "循环网模拟：8 拍 × 2 波 = 16 个波次，a 在第一拍、c 要等到第二拍才收到回边信号",
          JSON.stringify(rs8.byWave.slice(0, 4).map(function (x) { return x.length; })) + " maxWave=" + rs8.maxWave);
      log(Math.abs(rs8.val[rc] - 1.875) < 1e-5 && Math.abs(rs8.val[rb] - 1.875) < 1e-5,
          "循环网模拟：回边读的是上一拍的值（8 拍后 b = c = 1.875）",
          "b = " + rs8.val[rb].toFixed(6) + " / c = " + rs8.val[rc].toFixed(6));
      NF.recSetSteps(1);
      const rs1 = NF.simCompute([ra], {});
      log(Math.abs(rs1.val[rb] - 1) < 1e-5 && rs1.val[rc] === 0,
          "循环网模拟：只跑 1 拍时 c 收不到东西——回边读的确实是「上一拍」，第一拍之前是 0",
          "b = " + rs1.val[rb].toFixed(3) + " / c = " + rs1.val[rc].toFixed(3));
      NF.recSetSteps(3);
      const rs3 = NF.simCompute([ra], {});
      log(Math.abs(rs3.val[rc] - 1) < 1e-5 && rs3.maxWave === 5,
          "循环网模拟：展开步数说了算（3 拍 -> c = 1，波次 = 3×2 - 1 = 5）",
          "c = " + rs3.val[rc].toFixed(4) + " / maxWave = " + rs3.maxWave);
      const rsLim = NF.simCompute([ra], { waveLimit: 1 });
      log(rsLim.limitHit === true && rsLim.maxWave === 0 && rsLim.activated === 1,
          "循环网模拟：波数上限对「每一拍」生效（限 1 波就只点亮第一拍的第一波）",
          JSON.stringify({ limitHit: rsLim.limitHit, maxWave: rsLim.maxWave, activated: rsLim.activated }));
      /* 6 计数口径：报给用户的「几个」必须是**不同的神经元个数**。
         循环网里信号源每拍重新注入一次，照波次累加会冒出「4 个神经元已点亮 10 个」
         这种鬼话（firedSeeds 也会变成 8）。前馈网里每个神经元只亮一次，
         两种口径本来就是同一个数，所以老路一个数字都没变。 */
      log(rs8.seedDistinct === 1 && rs8.seedCount === 8,
          "循环网计数：信号源报 1 个（不同神经元），不是 8 拍的 8 次注入",
          "seedDistinct=" + rs8.seedDistinct + " / 注入次数=" + rs8.seedCount);
      NF.recSetSteps(8);
      NF.simRun([ra], { speed: 40 });
      const rsPlay = await simPlayWait();
      log(rsPlay.total === 3 && rsPlay.reached === 3 && rsPlay.played > 1 && rsPlay.reached <= rsPlay.total,
          "循环网播放：已点亮按不同神经元去重（3 个神经元，跑满也只会说 3 个）",
          JSON.stringify({ 总神经元: rsPlay.total, 已点亮: rsPlay.reached, 播过波数: rsPlay.played }));
      NF.simClear();

      /* 3 自环：最短的环，走同一条路 */
      NF.clear();
      await raf();
      const sa = NF.addNode(0, 0, 0), sb = NF.addNode(20, 0, 0), sc = NF.addNode(40, 0, 0);
      const selfE = NF.addEdge(sb, sb, 0.5);
      log(selfE >= 0, "编辑器允许画自环（自环就是最短的环）", "edge=" + selfE);
      NF.addEdge(sa, sb, 1.0); NF.addEdge(sb, sc, 1.0);
      NF.setIO([sa], 1); NF.setIO([sc], 2);
      NF.setThr([sa], 0.5); NF.setThr([sb], 0.5); NF.setThr([sc], 0.5);
      await raf();
      NF.recSetSteps(8);
      const slComp = NF.compile("pytorch");
      log(slComp.errors.length === 0 && slComp.recurrent === true && slComp.selfLoops === 1,
          "自环不再当错误拒掉，报告里点名「自环 1 条」",
          slComp.errors.join(" | ") || ("自环 " + slComp.selfLoops + " 条"));
      const slSim = NF.simCompute([sa], {});
      log(Math.abs(slSim.val[sc] - 1.9921875) < 1e-5,
          "自环模拟：每一拍把上一拍的自己加回来（跟 c->b 回边同一套算法）",
          "c = " + slSim.val[sc].toFixed(7));

      /* 1 前馈回归：没有回边的工程不该被这条路碰到 */
      NF.clear();
      await raf();
      const fa = NF.addNode(0, 0, 0), fb = NF.addNode(20, 0, 0), fc = NF.addNode(40, 0, 0);
      NF.addEdge(fa, fb, 1.0); NF.addEdge(fb, fc, 1.0);
      NF.setIO([fa], 1); NF.setIO([fc], 2);
      await raf();
      const ffComp = NF.compile("pytorch");
      log(ffComp.errors.length === 0 && ffComp.recurrent === false && ffComp.numRecEdges === 0,
          "前馈工程：一个回边都没有，recurrent 如实报 false");
      log(ffComp.code.indexOf("self.recurrent") < 0 && ffComp.code.indexOf("NUM_STEPS") < 0 &&
          ffComp.code.indexOf("回边") < 0 && ffComp.code.indexOf("rsrc") < 0,
          "前馈工程：生成结果里没有一点循环网的痕迹（老路不变）");
      const ffSim = NF.simCompute([fa], {});
      log(ffSim.activated === 3 && ffSim.byWave.length === 3 && ffSim.byWave[0].length === 1 &&
          ffSim.byWave[1].length === 1 && ffSim.byWave[2].length === 1 && ffSim.maxWave === 2,
          "前馈模拟：还是「一波一波」那套（波表长度 = 层数），没被循环网改动碰到",
          JSON.stringify(ffSim.byWave.map(function (x) { return x.length; })));
      NF.simRun([fa], { speed: 40 });
      const ffPlay = await simPlayWait();
      log(ffPlay.total === 3 && ffPlay.reached === 3,
          "前馈播放：计数与以前逐字相同（3 个神经元点亮 3 个）",
          JSON.stringify({ 总神经元: ffPlay.total, 已点亮: ffPlay.reached }));
      NF.simClear();

      /* 5 展开步数：编译对话框里改得动（先把那张环网搭回来，前馈网上本来就没有 NUM_STEPS） */
      NF.clear();
      await raf();
      const d1 = NF.addNode(0, 0, 0), d2 = NF.addNode(20, 0, 0), d3 = NF.addNode(40, 0, 0);
      NF.addEdge(d1, d2, 1.0); NF.addEdge(d2, d3, 1.0); NF.addEdge(d3, d2, 0.5);
      NF.setIO([d1], 1); NF.setIO([d3], 2);
      await raf();
      NF.recSetSteps(8);
      document.querySelector("[data-cmd=compile]").click();
      await raf();
      const tabRec = document.querySelector("#dlghead .tab[data-tab=train]");
      log(!!tabRec, "编译对话框里有「训练」页");
      if (tabRec) {
        tabRec.click();
        await raf();
        const rsEl = document.getElementById("dlg-recsteps");
        log(!!rsEl && parseInt(rsEl.value, 10) === NF.recSteps(),
            "训练页里有「展开步数」，显示的就是当前值", rsEl ? ("value=" + rsEl.value) : "没找到输入框");
        if (rsEl) {
          rsEl.value = "5";
          rsEl.dispatchEvent(new Event("change", { bubbles: true }));
          await raf();
          log(NF.recSteps() === 5, "改了立刻生效", "REC.steps=" + NF.recSteps());
          const rs5 = NF.compile("pytorch");
          log(rs5.code.indexOf("NUM_STEPS = 5") >= 0, "生成的文件里 NUM_STEPS 跟着变");
          log(localStorage.getItem("nf.rec.steps") === "5", "展开步数落在本机，下次开机还是这个值",
              String(localStorage.getItem("nf.rec.steps")));
        }
      }
      const dlgClose = document.getElementById("dlgclose");
      if (dlgClose) dlgClose.click();
      await raf();
      NF.recSetSteps(8);
      log(NF.aiManual().indexOf("循环网（图里有环时）") >= 0 && NF.aiManual().indexOf("回边") >= 0 &&
          NF.aiPrompt().indexOf("循环网") >= 0,
          "手册里写清了循环网这一节（回边 / 展开步数 / 边界），提示词也带着");
    }

    /* ---- 36. 有状态神经元（记忆 / 漏电积分 / 脉冲）+ AI 思考强度（r45） ----------------
       用户要的是像生物神经元那样能把收到的信号存住的神经元。三类都不新增参数字段：
       原来的 bias 在这一类里就是保持系数 k，所以老工程 / 老文件格式一个字节都没动。
       这里既验编辑器里的模拟，也验生成出来的 .py / .c 真的带状态，还要验 ONNX 会明确警告。 */
    try {
      const acts36 = NF.acts();
      log(acts36.stateFrom === 8 && acts36.names.length === 11 &&
          acts36.names[8] === 'memory' && acts36.names[9] === 'leaky' && acts36.names[10] === 'spike',
          '有状态神经元：激活函数表末尾多了 memory / leaky / spike（stateFrom=8）',
          acts36.names.length + ' 种');

      NF.clear();
      const g36s = NF.addNode(0, 0, 0);
      const g36m = NF.addNode(20, 0, 0);
      const g36l = NF.addNode(40, 0, 0);
      const g36p = NF.addNode(60, 0, 0);
      const g36o = NF.addNode(80, 0, 0);
      NF.setIO([g36s], 1); NF.setIO([g36o], 2);
      NF.addEdge(g36s, g36m, 1.0); NF.addEdge(g36s, g36l, 1.0); NF.addEdge(g36s, g36p, 1.0);
      /* 三个都接到同一个输出上：不然「没有出边」的神经元会被编译丢掉，
         下面那几条状态断言就成了空跑（只碰到一个）。图本身也必须有个输出，否则编译直接报错。 */
      NF.addEdge(g36m, g36o, 1.0); NF.addEdge(g36l, g36o, 1.0); NF.addEdge(g36p, g36o, 1.0);
      const setm = NF.setAct(g36m, 8);
      const setl = NF.setAct(g36l, 9);
      const setp = NF.setAct(g36p, 10);
      log(setm.state === true && setm.actName === 'memory' && setm.bias > 0.89 && setm.bias < 0.91 &&
          setl.keepBumped === true && setl.bias > 0.89 && setl.bias < 0.91 &&
          setp.keepBumped === true && setp.bias > 0.89 && setp.bias < 0.91,
          '有状态神经元：设成 8/9/10 时空着的「保持系数」自动补 0.9（跟界面上单点 / 批量一致）',
          JSON.stringify({ m: setm.bias, l: setl.bias, p: setp.bias }));
      NF.setBias([g36l], 0.5); NF.setBias([g36p], 0.5);
      NF.recSetSteps(8);
      const r36 = NF.simCompute([g36s], {});
      /* 闭式解：每拍都往这三个里各送 1（权重 1）
         memory（不用 k）     ：8 拍全攒着            → 8
         leaky k=0.5          ：1 + .5 + ... + .5^7    → 2 - 2^-7 = 1.9921875
         spike k=0.5          ：每拍攒到 1 就发一个 1、再把 1 减掉 → 每拍输出 1，膜电位回 0 */
      const exp36l = 2 - Math.pow(2, -7);
      log(r36.stateful === true && r36.steps === 8 && r36.cyclicTime === false,
          '有状态神经元：图里一个环都没有也按 8 拍展开跑（stateful=true / steps=8）',
          JSON.stringify({ stateful: r36.stateful, steps: r36.steps, cyclicTime: r36.cyclicTime }));
      log(Math.abs(r36.val[g36m] - 8) < 1e-9 && Math.abs(r36.val[g36l] - exp36l) < 1e-9 &&
          Math.abs(r36.val[g36p] - 1) < 1e-9,
          '有状态神经元：模拟结果与闭式解逐位相同（保持系数真的在起作用）',
          'memory=' + r36.val[g36m] + ' leaky=' + r36.val[g36l] + ' spike=' + r36.val[g36p]);

      const py36 = NF.compile('pytorch');
      const mu36 = (py36.code.match(/USED_ACT_IDS = \\[([^\\]]*)\\]/) || [])[1];
      const mv36 = (mu36 || '').split(',').map(function (s) { return parseInt(s.trim(), 10); })
        .filter(function (x) { return !isNaN(x); });
      log(mv36.length >= 1 && mv36.every(function (x) { return x < 8; }),
          '有状态神经元：生成的 .py 里 USED_ACT_IDS 只放 0~7（状态型不进 ACTS，不会越界）',
          'USED_ACT_IDS=[' + mu36 + ']');
      log(py36.code.indexOf('keep_bias') >= 0 && py36.code.indexOf('self.st') >= 0,
          '有状态神经元：生成的 .py 里注册了状态缓冲（self.st / keep_bias）');
      const c36 = NF.compile('exe');
      log(c36.errors.length === 0 && c36.code.indexOf('static double st[') >= 0 &&
          c36.code.indexOf('h[i] = act_code[i] >= 8 ? 0.0 : (double)bias[i];') >= 0,
          '有状态神经元：生成的 C 里状态数组齐了，而且状态型的 bias 不当加法偏置',
          c36.errors.join(' / '));
      const on36 = NF.compile('onnx');
      log(on36.warnings.some(function (w) { return w.indexOf('ONNX') >= 0 && w.indexOf('态') >= 0; }),
          '有状态神经元：ONNX 目标明确警告「状态不会保留」，不静默算错',
          (on36.warnings[0] || '').slice(0, 34));

      /* 图上没有这一类时，老路一个数字都不该变 */
      NF.clear();
      const f36a = NF.addNode(0, 0, 0), f36b = NF.addNode(20, 0, 0);
      NF.setIO([f36a], 1); NF.addEdge(f36a, f36b, 1.0);
      const r36b = NF.simCompute([f36a], {});
      log(r36b.stateful === false && r36b.steps === 1 && r36b.cyclicTime === false,
          '有状态神经元：图上没有这一类时还是老样子（stateful=false / steps=1）',
          JSON.stringify({ stateful: r36b.stateful, steps: r36b.steps }));

      /* ---- AI 思考强度：用户在设置里选，AI 自己也有一条 ai_think 工具 ---- */
      const tk0 = NF.aiThinkLevel();
      log(tk0.level === 'default' && tk0.levels.join(',') === 'default,off,low,medium,high,max' &&
          tk0.bad === false,
          'AI 思考强度：默认档是 default，六档都在', tk0.label);
      const tk1 = NF.aiThinkLevel('high');
      log(tk1.level === 'high' && NF.aiThinkLevel().level === 'high' && tk1.bad === false,
          'AI 思考强度：改得动，读回来也是新档', tk1.label);
      log(NF.aiState().think === 'high' && NF.aiState().thinkLabel === tk1.label,
          'AI 思考强度：状态里同步报出档位和名字', NF.aiState().thinkLabel);
      let tkErr = '';
      try { NF.aiThinkLevel('turbo'); } catch (e) { tkErr = String((e && e.message) || e); }
      log(tkErr.indexOf('思考强度只能是') >= 0 && NF.aiThinkLevel().level === 'high',
          'AI 思考强度：乱填会被拒，而且不把当前档位改坏', tkErr);
      const tool36 = NF.aiTools().filter(function (x) { return x.name === 'ai_think'; });
      log(tool36.length === 1 && tool36[0].desc.indexOf('思考') >= 0,
          'AI 思考强度：AI 自己也有一条 ai_think 工具');
      NF.aiThinkLevel('default');
      log(NF.aiThinkLevel().level === 'default' && NF.aiState().think === 'default',
          'AI 思考强度：改回默认，不给用户留副作用');

      /* 手册 {{MV}}：两节都写进去，提示词里也要带着 */
      const man45 = NF.aiManual();
      log(NF.aiState().manualVersion === '{{MV}}' && man45.indexOf('记忆 Memory') >= 0 &&
          man45.indexOf('保持系数 k') >= 0 && man45.indexOf('ONNX 没有隐式状态') >= 0 &&
          man45.indexOf('思考强度') >= 0 && man45.indexOf('ai_think') >= 0,
          '手册 {{MV}}：把「有状态神经元」和「AI 思考强度」两节写进去了');
      const pr45 = NF.aiPrompt();
      log(pr45.indexOf('有状态') >= 0 && pr45.indexOf('思考强度') >= 0,
          '手册 {{MV}}：系统提示词里也带着这两节');
      const au45 = NF.aiAudit();
      log(au45.missing.length === 0 && au45.tools >= 96,
          '手册 {{MV}}：工具表里写的接口一个都没写错，共 ' + au45.tools + ' 个工具', au45.missing.join(','));
      NF.clear();
      await raf();
    } catch (e) {
      out.push('ERROR | ' + ((e && e.stack) || e));
    }

    /* ---- 37. 真人用界面用出来的那几个问题（r45 补丁） ------------------------------
       这一组全部是「像真实用户那样用软件」时真踩到的：
         ① place_next 明明放成功了却报 placed:0，模型以为失败又补放一遍；
         ② 有状态但没环的图，模拟的波表被截成一拍、activated 变成跨拍累加次数；
         ③ 上下文一压缩就留下落单的 tool 消息，接口 400，整轮对话断掉；
         ④ compile 工具不报产物清单，AI 只能去调 artifacts，把整段代码倒进上下文；
         ⑤ artifacts 里的 model.bin 是 Blob，字节数报 0。 */
    try {
      NF.clear();
      await NF.aiTool('set_tool', { tool: 'add' });
      const pl37 = await NF.aiTool('place_next', { count: 3 });
      const pl37r = pl37.result || pl37;
      log(pl37.ok === true && pl37r.placed === 3 && pl37r.ids.length === 3 && pl37r.ids.every(function (x) { return x >= 0; }),
          '① place_next 真的把放成功的 id 报出来了（以前一律报 placed:0）',
          JSON.stringify(pl37r));
      const ids37 = pl37r.ids.slice();
      const pl37b = await NF.aiTool('place_next', {});
      log((pl37b.result || pl37b).placed === 1, '① 一次放一个也报得对', JSON.stringify(pl37b.result || pl37b));
      const placeDirect = NF.place();
      log(placeDirect >= 0 && NF.stats().n === ids37.length + 2,
          '① NF.place() 的返回值就是新神经元的 id（脚本接口以前回 undefined）',
          'id=' + placeDirect + ' n=' + NF.stats().n);

      /* ② 有状态但没环：拍 / 波 / 计数都要分得清 */
      const g37a = ids37[0], g37b = ids37[1], g37c = ids37[2];
      NF.addEdge(g37a, g37b, 1);
      NF.setAct(g37b, 8);
      NF.setIO([g37a], 1); NF.setIO([g37b], 2);
      NF.recSetSteps(8);
      const s37 = NF.simCompute([g37a], {});
      log(s37.stateful === true && s37.steps === 8 && s37.span === 2 && s37.byWave.length === 16,
          '② 有状态没环的图真的按 8 拍展开，波表是 8×2=16 格（以前被截成一拍的 2 格）',
          JSON.stringify({ steps: s37.steps, span: s37.span, waves: s37.byWave.length }));
      log(s37.activated === 2 && s37.activatedNodes === 2 && s37.fired === 16,
          '② 点亮个数按「不同神经元」算（2 个），跨拍总次数另给 fired（16 次）',
          JSON.stringify({ activated: s37.activated, fired: s37.fired }));
      log(s37.val[g37b] === 8, '② 记忆神经元跑完 8 拍攒到 8（val 里读得到）', 'val=' + s37.val[g37b]);

      /* ③ 落单的 tool 消息：接口会判 400，发出前必须被配上骨架 */
      const orphan37 = [ { role: 'system', content: 's' },
                         { role: 'tool', tool_call_id: 'c1', content: 'r1' },
                         { role: 'tool', tool_call_id: 'c2', content: 'r2' },
                         { role: 'user', content: 'u' } ];
      const fx37 = NF.aiMsgsFix(orphan37);
      const ok37 = fx37.length === 5 && fx37[1].role === 'assistant' &&
        fx37[1].tool_calls.length === 2 && fx37[1].tool_calls[0].id === 'c1' && fx37[1].tool_calls[1].id === 'c2' &&
        fx37[2].role === 'tool' && fx37[2].tool_call_id === 'c1' &&
        fx37[3].role === 'tool' && fx37[3].tool_call_id === 'c2';
      log(ok37, '③ 落单的 tool 消息被就地配上 assistant(tool_calls) 骨架，消息数组重新合法',
          JSON.stringify(fx37.map(function (m) { return m.role; })));
      const ok37already = NF.aiMsgsFix([ { role: 'assistant', content: '', tool_calls: [ { id: 'x', type: 'function', function: { name: 'f', arguments: '{}' } } ] },
                                         { role: 'tool', tool_call_id: 'x', content: 'r' } ]);
      log(ok37already.length === 2 && ok37already[0].tool_calls.length === 1 && ok37already[1].tool_call_id === 'x',
          '③ 本来就合法的工具组原样不动（不会多补一条空壳）');

      /* ④ 压缩的切口不能落在 assistant(tool_calls) 和它的 tool 结果之间 */
      const long37 = [ { role: 'system', content: 's' } ];
      for (let i = 0; i < 40; i++) {
        long37.push({ role: 'user', content: 'u' + i });
        long37.push({ role: 'assistant', content: '', tool_calls: [ { id: 'c' + i, type: 'function', function: { name: 'f', arguments: '{}' } } ] });
        long37.push({ role: 'tool', tool_call_id: 'c' + i, content: 'r' + i });
      }
      let cutBad37 = 0, cutFirstTool = 0;
      for (let keep = 2; keep <= 40; keep += 3) {
        const cut = NF.aiTrimList(long37, keep);
        if (cut.length && cut[0].role === 'tool') cutFirstTool++;
        /* 切完之后每一组工具都必须完整：出现过 tool 消息就必须能在前面找到它的 assistant */
        const seen37 = {};
        for (const m of cut) {
          if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls) seen37[c.id] = 1;
          if (m.role === 'tool' && !seen37[m.tool_call_id]) cutBad37++;
        }
      }
      log(cutFirstTool === 0 && cutBad37 === 0,
          '④ 任何切法都不会把一组工具调用劈开（切口只落在「一轮的开头」上）',
          '开头是 tool 的 ' + cutFirstTool + ' 次 / 劈开的 ' + cutBad37 + ' 次');

      /* ⑤ 产物清单要有真字节数，AI 不用去调 artifacts */
      const cf37 = NF.compile('pytorch', { forceBin: true });
      const mb37 = cf37.files.filter(function (f) { return f.name === 'model.bin'; })[0];
      log(!!mb37 && mb37.bytes > 0, '⑤ 产物清单里 model.bin 的字节数不再是 0',
          'model.bin ' + (mb37 ? mb37.bytes : '?') + ' 字节 / 清单 ' + JSON.stringify(cf37.files.map(function (f) { return f.name + ':' + f.bytes; })));
      const ct37 = await NF.aiTool('compile', { target: 'pytorch' });
      const ctr37 = ct37.result || ct37;
      log(ct37.ok === true && Array.isArray(ctr37.files) && ctr37.files.length >= 1 &&
          typeof ctr37.files[0].bytes === 'number',
          '⑤ compile 工具直接回产物清单（名字 + 字节数），AI 不用整段代码',
          JSON.stringify(ctr37.files));

      /* ⑥ 接口返回的类型要对：连接数是数字不是字符串；list_nodes 要看得到保持系数 */
      const nd37r = (await NF.aiTool('get_node', { id: g37b })).result;
      log(!!nd37r && typeof nd37r.inEdges === 'number' && typeof nd37r.outEdges === 'number' &&
          nd37r.inEdges === 1 && nd37r.outEdges === 0 && nd37r.act === 'memory' &&
          Math.abs(nd37r.bias - 0.9) < 1e-3,
          '⑥ get_node 报的连接数是数字不是字符串，激活函数与保持系数都读得到',
          JSON.stringify({ inEdges: nd37r && nd37r.inEdges, outEdges: nd37r && nd37r.outEdges, act: nd37r && nd37r.act, bias: nd37r && nd37r.bias }));
      const ln37r = (await NF.aiTool('list_nodes', { from: g37b, count: 1 })).result;
      log(!!ln37r && ln37r.nodes.length === 1 && typeof ln37r.nodes[0].bias === 'number' &&
          Math.abs(ln37r.nodes[0].keep - 0.9) < 1e-3 && typeof ln37r.nodes[0].inDeg === 'number' &&
          typeof ln37r.nodes[0].outDeg === 'number',
          '⑥ list_nodes 一次就能看到保持系数与入出度，不用一个个 get_node',
          JSON.stringify(ln37r && ln37r.nodes[0]));
      NF.clear();
      await raf();

      /* ---- 第 38 组：真人用软件时踩出来的交互问题 ---- */
      try {
        NF.clear();
        await raf();
        const q38 = NF.addNode(0, 0, 0);
        NF.addNode(40, 0, 0);
        const id38a = (q38 && typeof q38 === 'object' && q38.id != null) ? q38.id : q38;
        log(NF.stats().n === 2, '38 前置：两个神经元摆好了', String(NF.stats().n));

        /* 切到「放置神经元」模式，点到已有神经元身上 —— 应该变成「选中」，不该再多放一个 */
        const btn38 = document.querySelector('#t-add');
        if (btn38) btn38.click();
        await raf();
        const pt38 = NF.screenOf(id38a);
        const cv38 = document.querySelector('canvas');
        cv38.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: pt38.x, clientY: pt38.y, button: 0, buttons: 1, bubbles: true, cancelable: true, pointerId: 1,
        }));
        await raf();
        const st38 = NF.stats();
        const sel38 = NF.selectedNodes();
        log(st38.n === 2 && sel38.length === 1 && sel38[0] === id38a,
          '38 放置模式下点到已有神经元 = 选中它，不会再多放一个',
          JSON.stringify({ n: st38.n, sel: sel38, want: id38a }));

        /* 点空白处照旧要能放：连续放置这条主路径不能被这次改动弄坏 */
        const before38 = NF.stats().n;
        cv38.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: pt38.x + 150, clientY: pt38.y + 130, button: 0, buttons: 1, bubbles: true, cancelable: true, pointerId: 1,
        }));
        await raf();
        log(NF.stats().n === before38 + 1, '38 点空白处照旧放下一个（连续放置没被破坏）', String(NF.stats().n));
        const back38 = document.querySelector('#t-select');
        if (back38) back38.click();
        await raf();

        /* 整图替换必须先问一句：图非空时点菜单「新建工程」要弹确认框 */
        const ni38 = NF.stats().n;
        const cmd38 = document.querySelector('[data-cmd=new]');
        if (cmd38) cmd38.click();
        await sleep(150);
        const ask38 = document.getElementById('nfask');
        const shown38 = !!ask38 && getComputedStyle(ask38).display !== 'none';
        log(shown38, '38 图非空时「新建工程」先弹确认框（不再直接清空）', shown38 ? 'shown' : 'no box');
        const no38 = document.getElementById('nfask-no');
        if (no38) no38.click();
        await sleep(150);
        log(NF.stats().n === ni38, '38 点「取消」之后图原封不动', String(NF.stats().n));

        /* 空白工程不该烦人：没有东西可丢就别弹框 */
        NF.clear();
        await raf();
        const cmd38b = document.querySelector('[data-cmd=new]');
        if (cmd38b) cmd38b.click();
        await sleep(150);
        const ask38b = document.getElementById('nfask');
        log(!(ask38b && getComputedStyle(ask38b).display !== 'none'), '38 空白工程点「新建工程」不弹框', 'ok');

        /* 标题栏那个常驻的思考强度：跟「设置」里那一项是同一个值，两边同步 */
        const top38 = document.getElementById('ai-think-top');
        const set38 = document.getElementById('ai-think');
        if (top38 && set38 && top38.options.length === 6) {
          top38.value = 'high';
          top38.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(80);
          log(NF.aiThinkLevel().level === 'high' && set38.value === 'high',
            '38 标题栏的思考强度能直接改，设置里那一行跟着同步', NF.aiThinkLevel().level + '/' + set38.value);
          set38.value = 'default';
          set38.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(80);
          log(top38.value === 'default', '38 反过来改设置，标题栏也跟着同步', top38.value);
        } else {
          log(false, '38 标题栏的思考强度下拉框在位且有 6 档',
            'top=' + !!top38 + ' set=' + !!set38 + ' opts=' + (top38 ? top38.options.length : -1));
        }

        /* 左栏「神经元」里要写清三种带状态的激活函数（用户点名要的「能存信号的神经元」） */
        const hint38 = document.querySelector('[data-i18n=h-stateful]');
        const txt38 = hint38 ? hint38.textContent : '';
        log(!!hint38 && txt38.indexOf('记忆') >= 0 && txt38.indexOf('保持系数') >= 0,
          '38 左栏写清了三种带状态的激活函数与保持系数', txt38.slice(0, 36));

        /* 对话里不该再出现「脚本切的」这种只有写代码的人看得懂的黑话：
           不拿函数源码去比对（打包器会把中文写成转义码），而是真的切一次对话，读那行提示的原文。 */
        let note38 = '';
        try {
          NF.aiSessionNew();
          await sleep(80);
          const ids38 = NF.aiSessions().sessions.map(function (s) { return s.id; });
          NF.aiSessionNew();
          await sleep(80);
          if (ids38.length) { NF.aiSessionLoad(ids38[0]); await sleep(100); }
          note38 = NF.aiLog().filter(function (e) { return e && e.role === 'note'; })
            .map(function (e) { return String(e.text); }).join(' | ');
        } catch (e) { note38 = 'ERR ' + ((e && e.message) || e); }
        log(note38.indexOf('脚本唤起的') >= 0 && note38.indexOf('脚本切的') < 0,
          '38 切对话那行提示说的是「脚本唤起的」，不再露内部黑话', note38.slice(0, 90));

        /* AI 走 menu 工具执行「新建工程」不能被模态框卡住：
           aiExec 那边已经问过（或按设置不问），这里 force 直通。人被卡住时 AI 会以为已经做完了。 */
        NF.addNode(0, 0, 0);
        await raf();
        NF.aiConfig({ autoRun: true, noAsk: true });
        await sleep(60);
        const mt38 = await NF.aiTool('menu', { cmd: 'new' });
        await sleep(200);
        const box38c = document.getElementById('nfask');
        const shown38c = !!(box38c && getComputedStyle(box38c).display !== 'none');
        log(!!mt38 && mt38.ok === true && !shown38c && NF.stats().n === 0,
          '38 AI 用 menu 工具做「新建工程」不弹模态框（不会把 AI 卡住）',
          JSON.stringify({ ok: mt38 && mt38.ok, box: shown38c, n: NF.stats().n }));
        NF.aiConfig({ noAsk: false });
        await sleep(60);

        /* 手册也得跟着写：新交互不写进手册，AI 下一轮就会按老规矩猜 */
        const man38 = NF.aiManual();
        log(NF.aiState().manualVersion === '{{MV}}' && man38.indexOf('已经有神经元') >= 0 &&
            man38.indexOf('整图替换类') >= 0,
            '38 手册升到 {{MV}}，写清了「点到已有神经元 = 选中」和整图替换会确认', '{{MV}}');

        NF.clear();
        await raf();
      } catch (e) {

        out.push('ERROR | 第 38 组：' + ((e && e.stack) || e));
      }

      /* ---- 第 39 组：手动隐藏 / 神经元列表 / 一个神经元同时在好几个组 ---- */
      try {
        NF.clear();
        await raf();
        const n39 = [];
        for (let k = 0; k < 6; k++) n39.push(NF.addNode(k * 10, 0, 0));
        const e39 = [];
        for (let k = 0; k < 5; k++) e39.push(NF.addEdge(n39[k], n39[k + 1], 1));
        log(NF.stats().n === 6 && NF.stats().e === 5, '39 前置：一排 6 个神经元串成一条链',
            NF.stats().n + ' 神经元 / ' + NF.stats().e + ' 连接');

        /* 手动隐藏：点谁藏谁；藏在神经元身上的连线也跟着算藏，不然会剩半截线头 */
        NF.setHidden([n39[1], n39[3]], [], true);
        const hc39 = NF.hiddenCount();
        log(hc39.nodes === 2 && hc39.edges === 0 && NF.hiddenNodes().join(',') === n39[1] + ',' + n39[3],
            '39 手动隐藏神经元：hiddenCount / hiddenNodes 都报得出来',
            JSON.stringify(hc39) + ' ' + NF.hiddenNodes().join(','));
        log(NF.neuronHidden(n39[1]) === true && NF.neuronHidden(n39[0]) === false,
            '39 neuronHidden 问单个神经元问得准', n39[1] + '/' + n39[0]);
        log(NF.edgeHidden(e39[0]) === true && NF.edgeHidden(e39[1]) === true &&
            NF.edgeHidden(e39[3]) === true && NF.edgeHidden(e39[4]) === false,
            '39 端点被藏了，那条连线也跟着算藏（没被藏的照常显示）',
            JSON.stringify([0, 1, 2, 3, 4].map(function (k) { return NF.edgeHidden(e39[k]); })));

        /* 藏错了要能退回来：隐藏是「一次可撤销的编辑」，跟删神经元一个待遇 */
        NF.undo();
        log(NF.hiddenCount().nodes === 0 && NF.hiddenNodes().length === 0 &&
            NF.stats().n === 6 && NF.stats().e === 5,
            '39 隐藏可撤销（Ctrl+Z 之后全回来，图本身没被动）',
            JSON.stringify(NF.hiddenCount()) + ' n=' + NF.stats().n + ' e=' + NF.stats().e);
        NF.redo();
        log(NF.hiddenCount().nodes === 2 && NF.neuronHidden(n39[3]) === true,
            '39 撤销之后还能重做回来', JSON.stringify(NF.hiddenCount()));

        /* 连线本身也能单独藏 */
        NF.setHidden([], [e39[4]], true);
        log(NF.hiddenCount().edges === 1 && NF.hiddenEdges()[0] === e39[4] && NF.edgeHidden(e39[4]) === true,
            '39 连线也能单独手动藏', JSON.stringify(NF.hiddenCount()));
        const sh39 = NF.showAllHidden();
        log(sh39.nodes === 2 && sh39.edges === 1 && NF.hiddenCount().nodes === 0 &&
            NF.hiddenCount().edges === 0 && NF.edgeHidden(e39[4]) === false && NF.edgeHidden(e39[0]) === false,
            '39「全部显示」一口气把手动隐藏清干净（线头也一起回来）', JSON.stringify(sh39));

        /* 多归属分组：一个神经元同时在几个组里（集合语义，不是单选） */
        const gA39 = NF.groupAdd([n39[0], n39[1], n39[2]], '前段');
        const gB39 = NF.groupAdd([n39[2], n39[3]], '中段');
        log(gA39 === 1 && gB39 === 2, '39 建了两个分组', gA39 + ' / ' + gB39);
        log(NF.groupsOfNode(n39[2]).join(',') === '前段,中段',
            '39 同一个神经元可以同时在两个组里', NF.groupsOfNode(n39[2]).join(','));
        log(NF.groupsOfNode(n39[0]).join(',') === '前段' && NF.groupCount('中段') === 2,
            '39 组名 / 人数报得准', NF.groupsOfNode(n39[0]).join(',') + ' / ' + NF.groupCount('中段'));
        const gm39 = NF.groupMembers('前段').slice().sort(function (a, b) { return a - b; });
        log(gm39.length === 3 && gm39[0] === n39[0] && gm39[2] === n39[2],
            '39 groupMembers 按组名拿到全部成员编号', gm39.join(','));

        /* setGroup 是「只属于它」，groupAdd 是「再加一个」：两个语义不能混 */
        NF.setGroup([n39[2]], '中段');
        log(NF.groupsOfNode(n39[2]).join(',') === '中段',
            '39 setGroup 是「只属于它」：原来的组会被摘掉', NF.groupsOfNode(n39[2]).join(','));
        NF.groupAdd([n39[2]], '前段');
        log(NF.groupsOfNode(n39[2]).join(',') === '前段,中段',
            '39 groupAdd 是「再加一个」：原来的组还在', NF.groupsOfNode(n39[2]).join(','));
        NF.groupRemove([n39[2]], '前段');
        log(NF.groupsOfNode(n39[2]).join(',') === '中段' && NF.groupCount('前段') === 2,
            '39 groupRemove 只摘掉这一个组，别的组不受影响',
            NF.groupsOfNode(n39[2]).join(',') + ' / 前段剩 ' + NF.groupCount('前段'));
        NF.undo();
        log(NF.groupsOfNode(n39[2]).join(',') === '前段,中段',
            '39 分组的增减是可撤销的（撤回到移出之前）', NF.groupsOfNode(n39[2]).join(','));
        NF.redo();
        log(NF.groupsOfNode(n39[2]).join(',') === '中段' && NF.groupCount('前段') === 2,
            '39 分组也能重做', NF.groupsOfNode(n39[2]).join(','));

        /* 神经元列表：筛选 / 状态 / 把藏起来的东西捞回来 */
        NF.setHidden([n39[5]], [], true);
        const lA39 = NF.nodeListScan({ hid: 'hid', pageSize: 20 });
        log(lA39.total === 1 && lA39.rows[0].id === n39[5] && lA39.rows[0].hidden === true,
            '39 列表筛「只看被隐藏的」正好捞出藏起来的那个', JSON.stringify(lA39.rows[0]));
        const lB39 = NF.nodeListScan({ hid: 'vis', pageSize: 50 });
        log(lB39.total === 5, '39 列表筛「只看显示的」把藏起来的排除在外', String(lB39.total));
        const lC39 = NF.nodeListScan({ grp: 1, pageSize: 50 });
        log(lC39.total === NF.groupCount(1) && lC39.total === 2 &&
            lC39.rows.every(function (r) { return r.groups.indexOf('前段') >= 0; }),
            '39 列表能按分组筛（人数跟 groupCount 对得上）', lC39.total + ' / ' + NF.groupCount(1));
        const lD39 = NF.nodeListScan({ grp: 2, pageSize: 50 });
        log(lD39.total === 2 && lD39.rows.every(function (r) { return r.groups.indexOf('中段') >= 0; }),
            '39 按「中段」筛出来的是现在真在中段里的那些人',
            JSON.stringify(lD39.rows.map(function (r) { return r.id + '=' + r.groups.join('+'); })));
        NF.showAllHidden();
        log(NF.hiddenCount().nodes === 0,
            '39 列表那边「全部显示」之后没有被藏的了', JSON.stringify(NF.hiddenCount()));

        /* 单归属（还没出现多归属）也要能过一趟 v3：这条以前是坏的——载入只把主分组号
           写回 nGroup，成员表空着，于是「按分组筛」「按组选人」全是空的。 */
        const bufOne39 = await NF.encodeV3({ chunkNeurons: 2 });
        await NF.loadBuffer(bufOne39);
        log(NF.groupCount('前段') === 2 && NF.groupCount('中段') === 2 &&
            NF.groupsOfNode(n39[0]).join(',') === '前段' && NF.groupsOfNode(n39[2]).join(',') === '中段',
            '39 v3 往返：单归属分组落回成员表（不是只把组名带回来）',
            JSON.stringify({ qian: NF.groupCount('前段'), zhong: NF.groupCount('中段'),
                             n0: NF.groupsOfNode(n39[0]), n2: NF.groupsOfNode(n39[2]) }));

        /* 载入一份「没人被隐藏」的工程时，内存里上一次的隐藏标记必须被清掉
           （留着的话新图会有一批人凭空看不见，还点不到）。 */
        const bufNoHid39 = await NF.encodeV3({ chunkNeurons: 2 });
        NF.setHidden([n39[5], n39[0]], [], true);
        await NF.loadBuffer(bufNoHid39);
        log(NF.hiddenCount().nodes === 0 && NF.hiddenCount().edges === 0 &&
            NF.neuronHidden(n39[5]) === false && NF.neuronHidden(n39[0]) === false,
            '39 载入一份没人被隐藏的工程，内存里上一次的隐藏标记被清干净',
            JSON.stringify(NF.hiddenCount()));

        /* 存盘往返：隐藏标记与多归属都得原样回来 */
        NF.groupAdd([n39[2]], '前段');   /* 造出真正的多归属：2 同时在 前段 和 中段 */
        NF.setHidden([n39[0], n39[4]], [e39[2]], true);
        const want39 = { hn: NF.hiddenNodes().slice(), he: NF.hiddenEdges().slice(),
                         gp: [0, 1, 2, 3, 4, 5].map(function (i) { return NF.groupsOfNode(i).join('+'); }) };
        const pos39 = {};
        for (const i of want39.hn) { const nd = NF.node(i); pos39[i] = [nd.x, nd.y, nd.z]; }
        const buf39 = await NF.encodeV3({ chunkNeurons: 2 });
        await NF.loadBuffer(buf39);
        log(NF.hiddenNodes().join(',') === want39.hn.join(',') &&
            NF.hiddenEdges().join(',') === want39.he.join(','),
            '39 v3 整份往返：隐藏的神经元与连线原样回来',
            NF.hiddenNodes().join(',') + ' / ' + NF.hiddenEdges().join(','));
        log(NF.groupsOfNode(n39[2]).join(',') === '前段,中段' && want39.gp[2] === '前段+中段',
            '39 v3 整份往返：多归属分组原样回来（2 同时在前段和中段）',
            NF.groupsOfNode(n39[2]).join(',') + ' / 存盘前 ' + want39.gp[2]);

        /* 空间分块（order=spatial）会把人重新编号：隐藏标记必须跟着人走，不能跟着编号走 */
        const bufSp39 = await NF.encodeV3({ order: 'spatial', chunkNeurons: 2 });
        await NF.loadBuffer(bufSp39);
        const hnSp = NF.hiddenNodes().map(function (i) {
          const nd = NF.node(i); return [nd.x, nd.y, nd.z].join('/'); }).sort();
        const wantSp = want39.hn.map(function (i) { return pos39[i].join('/'); }).sort();
        log(hnSp.join(',') === wantSp.join(','),
            '39 空间分块往返：藏起来的还是同样的那几个位置（标记跟着神经元走）',
            hnSp.join(',') + ' vs ' + wantSp.join(','));
        const heSp = NF.hiddenEdges().map(function (e) {
          const ed = NF.edge(e); const a = NF.node(ed.src), b = NF.node(ed.dst);
          return a.x + '>' + b.x; }).sort();
        log(heSp.length === 1 && heSp[0] === '20>30',
            '39 空间分块往返：藏的连线还是那条 20->30 的（边被重排过也没错位）', heSp.join(','));

        /* 只载入一部分：藏着的人只有落在这一块里才会被标上 */
        const part39 = await NF.loadBuffer(buf39, [0]);
        log(part39.n >= 1 && NF.hiddenCount().nodes === 1 && NF.hiddenNodes()[0] === 0,
            '39 只载入一块时，隐藏标记只落在这一块里真有的人身上',
            JSON.stringify({ n: part39.n, hid: NF.hiddenNodes(), hc: NF.hiddenCount() }));

        /* 老格式（v2 JSON）也得带上这两样，而且缺字段的旧文件不能炸 */
        await NF.loadBuffer(buf39);
        const doc39 = NF.serializeV2();
        log(!!doc39.hidden && doc39.hidden.n.length === 2 && doc39.hidden.e.length === 1 &&
            Array.isArray(doc39.groups.multi),
            '39 v2 JSON 里写了 hidden 段和多归属名单（不再只活在 v3 里）',
            JSON.stringify(doc39.hidden) + ' multi=' + (doc39.groups.multi ? doc39.groups.multi.length : 0));
        NF.clear();
        await raf();
        NF.loadV2(doc39);
        log(NF.hiddenNodes().length === 2 && NF.edgeHidden(e39[2]) === true &&
            NF.groupsOfNode(n39[2]).join(',') === '前段,中段',
            '39 v2 JSON 往返：隐藏 + 多归属都在',
            NF.hiddenNodes().join(',') + ' / ' + NF.groupsOfNode(n39[2]).join(','));
        const old39 = JSON.parse(JSON.stringify(doc39));
        delete old39.hidden;
        if (old39.groups) delete old39.groups.multi;
        let oldErr39 = '';
        try { NF.loadV2(old39); } catch (e) { oldErr39 = String((e && e.message) || e); }
        log(!oldErr39 && NF.hiddenCount().nodes === 0 && NF.hiddenCount().edges === 0 &&
            NF.stats().n === 6 && NF.stats().e === 5,
            '39 老格式（没有 hidden / multi 两个字段）读回来不炸，行为跟以前一样',
            oldErr39 || (NF.stats().n + ' / ' + NF.stats().e + ' / 藏 ' + NF.hiddenCount().nodes));

        /* 走真界面：按钮点得开、快捷键按得动。只调 NF.openNodeList() 会漏掉
           「按钮挂上了但命令没接线」这种毛病——本轮就真出过一次，点了没反应。 */
        const modalOn39 = () => { const m = document.getElementById('modal'); return !!(m && m.classList.contains('show')); };
        const btnNL39 = document.querySelector('[data-cmd=nodelist]');
        if (btnNL39) btnNL39.click();
        await sleep(90);
        const nlBox39 = document.getElementById('dlgbody');
        const nlTxt39 = nlBox39 ? nlBox39.textContent : '';
        log(!!btnNL39 && modalOn39() && nlTxt39.indexOf('神经元列表') >= 0 &&
            nlTxt39.indexOf('手动隐藏') >= 0 && !!document.querySelector('[data-nl-hide], [data-nl-show]'),
            '39 顶部「神经元列表」按钮点得开，里面能逐个藏 / 显示', nlTxt39.slice(0, 60));
        const nlClose39 = document.getElementById('dlgclose');
        if (nlClose39) nlClose39.click();
        await sleep(70);
        log(!modalOn39(), '39 神经元列表关得上', 'shown=' + modalOn39());

        /* 快捷键：H 藏起选中的 / Shift+H 显示回来 / Ctrl+L 打开列表 */
        NF.selectIds([n39[2]]);
        await raf();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
        await sleep(50);
        log(NF.neuronHidden(n39[2]) === true && NF.hiddenCount().nodes === 1,
            '39 按 H 把选中的神经元藏起来', JSON.stringify(NF.hiddenCount()));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'H', shiftKey: true, bubbles: true, cancelable: true }));
        await sleep(50);
        log(NF.neuronHidden(n39[2]) === false && NF.hiddenCount().nodes === 0,
            '39 按 Shift+H 又显示回来', JSON.stringify(NF.hiddenCount()));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }));
        await sleep(90);
        const nlTitle39 = (document.getElementById('dlgtitle') || {}).textContent;
        log(modalOn39() && nlTitle39 === '神经元列表', '39 Ctrl+L 也能打开神经元列表', String(nlTitle39));
        const nlClose39b = document.getElementById('dlgclose');
        if (nlClose39b) nlClose39b.click();
        await sleep(70);

        /* 「显示全部被隐藏的」这条命令也得真的挂在菜单上 */
        NF.setHidden([n39[1]], [], true);
        const cmdAll39 = document.querySelector('[data-cmd=show-all-hidden]');
        if (cmdAll39) cmdAll39.click();
        await sleep(60);
        log(!!cmdAll39 && NF.hiddenCount().nodes === 0,
            '39 菜单里的「显示全部被隐藏的」真的接上了命令', JSON.stringify(NF.hiddenCount()));
        NF.clear();
        await raf();
      } catch (e) {
        out.push('ERROR | 第 39 组：' + ((e && e.stack) || e));
      }
    } catch (e) {
      out.push('ERROR | ' + ((e && e.stack) || e));
    }
    NF.ifaceClear();
  } catch (e) {
    out.push('ERROR | ' + ((e && e.stack) || e));
  }

  /* ===== 40. 本地大模型那一套（Ollama / LM Studio / llama.cpp / vLLM）=====
     这一组验的是「配置本地模型」这条路：判定本机地址、预设、瘦身提示词、
     7 件套 + run_tool 那条「能力不缩水」的路，以及设置面板上那几个控件真的接上了。 */
  try {
    const cfg40 = NF.aiConfig();
    const st40 = NF.aiState();
    const hadKey40 = !!st40.hasKey;
    NF.aiConfig({ autoRun: true, noAsk: true });

    /* 1) 本机 / 内网判定：装在本机、装在局域网另一台机器上都算「不出网」；公网不算 */
    const cases40 = NF.aiEnv().cases;
    const got40 = cases40.map((c) => (c[1] ? 'L' : 'W')).join('');
    log(got40 === 'LLLLLWWWL', '40 本机/内网地址认得出来，公网地址不会被误判成本地', got40);
    log(cases40.length === 9 && cases40[6][0].indexOf('deepseek') > 0,
        '40 判定覆盖 localhost / 127.x / 192.168 / 10.x / 172.16-31 / *.local 与几个公网反例',
        cases40.length + ' 个样例');

    /* 2) 预设：端口是常见的那几个，地址拼对 */
    const pre40 = NF.aiLocalPresets();
    log(pre40.length === 7 && pre40.map((p) => p.port).join(',') === '11434,1234,8080,8000,9997,5001,5000',
        '40 七家常见本地推理服务的端口都对', pre40.map((p) => p.name + ':' + p.port).join(' '));
    log(pre40[0].base === 'http://127.0.0.1:11434/v1/chat/completions' && pre40[2].base.indexOf('/v1/chat/completions') > 0,
        '40 预设拼出来的接口地址是 OpenAI 兼容那一条', pre40[0].base);

    /* 3) 瘦身模式：云端默认不瘦，本机自动瘦；开关能强制 */
    NF.aiConfig({ base: 'https://api.deepseek.com/v1/chat/completions', slim: 'auto' });
    log(NF.aiEnv().local === false && NF.aiEnv().slim === false,
        '40 云端端点默认发完整提示词（不瘦身）', JSON.stringify({ local: NF.aiEnv().local, slim: NF.aiEnv().slim }));
    NF.aiConfig({ base: 'http://127.0.0.1:11434/v1/chat/completions' });
    log(NF.aiEnv().local === true && NF.aiEnv().slim === true,
        '40 换成 Ollama 的本机地址后，自动切到瘦身（小模型才塞得下）', JSON.stringify({ local: NF.aiEnv().local, slim: NF.aiEnv().slim }));
    NF.aiConfig({ slim: 'off' });
    log(NF.aiEnv().slim === false, '40 「完整」能强制覆盖自动判断', String(NF.aiEnv().slim));
    NF.aiConfig({ slim: 'on', base: 'https://api.deepseek.com/v1/chat/completions' });
    log(NF.aiEnv().slim === true, '40 「瘦身」也能强制用在云端端点上', String(NF.aiEnv().slim));
    NF.aiConfig({ slim: 'auto' });

    /* 4) 提示词真的变小了：完整 vs 瘦身，差的不是一点 */
    const full40 = NF.aiPromptFull();
    const slim40 = NF.aiPromptSlim();
    const au40 = NF.aiAudit();
    log(slim40.length < full40.length * 0.25 && slim40.length > 800,
        '40 瘦身提示词比完整提示词小一个数量级（4 万 token 那种塞不下的情况有救了）',
        slim40.length + ' / ' + full40.length + ' 字符 = ' + Math.round(slim40.length * 100 / full40.length) + '%');
    log(slim40.indexOf('【操作手册') >= 0 && slim40.indexOf('【可用工具（瘦身模式）】') >= 0 &&
        slim40.indexOf('list_tools') >= 0 && slim40.indexOf('run_tool') >= 0,
        '40 瘦身版里手册大纲和那 7 件套都在（不是把能力删了，是换成现查）', '长度 ' + slim40.length);
    log(slim40.indexOf('【脚本接口全清单】') < 0 && full40.indexOf('【脚本接口全清单】') >= 0,
        '40 瘦身版不再灌几百个脚本接口清单（那是最占地方的一段）', '—');
    log(au40.slimChars > 800 && au40.manualChars > 40000,
        '40 审计同时报了完整版和瘦身版的大小（正好量出差多少）',
        '手册 ' + au40.manualChars + ' 字符 / 瘦身提示词 ' + au40.slimChars + ' 字符');

    /* 5) 手册大纲 / 取一节：4.2 万字的手册变成能翻的大纲 */
    const out40 = NF.aiManualOutline();
    log(out40.length > 500 && out40.length < 4000 && out40.indexOf('【模拟激活') >= 0 && out40.indexOf('【接口运行时') >= 0,
        '40 手册大纲列出了各节标题（不用整本塞进上下文）', out40.length + ' 字符 / ' + au40.manualSections + ' 节');
    const sec40 = NF.aiManualSection('模拟激活');
    log(sec40.indexOf('模拟激活') >= 0 && sec40.length > 200 && sec40.length < 4000 && sec40.indexOf('【编译（把图变成模型文件）】') < 0,
        '40 按标题取手册里的某一节，只回这一节（不会把整本倒出来）', sec40.length + ' 字符');
    log(NF.aiManualSection('没有这一节xyz').indexOf('没有标题含') >= 0,
        '40 问不存在的节时，把有的节名报回去让模型自己挑', '—');

    /* 6) 瘦身模式的能力不缩水：7 件套 + run_tool 代调，真的是同一套工具 */
    const names40 = NF.aiTools().map((t) => t.name);
    log(names40.indexOf('list_tools') >= 0 && names40.indexOf('tool_help') >= 0 && names40.indexOf('run_tool') >= 0,
        '40 工具表里多了 list_tools / tool_help / run_tool 三件', names40.length + ' 个工具');
    log(au40.slimTools === 7 && names40.length > 120,
        '40 瘦身模式只发 7 件套，schema 也小得多', '瘦身 ' + au40.slimTools + ' 件');
    const lt40 = await NF.aiTool('list_tools', { q: '编译' });
    log(lt40 && lt40.ok === true && JSON.stringify(lt40.result).indexOf('compile') >= 0,
        '40 list_tools 能按关键词把工具列出来', JSON.stringify(lt40.result).slice(0, 80));
    const th40 = await NF.aiTool('tool_help', { name: 'add_node' });
    log(th40 && th40.ok === true && String(th40.result).indexOf('add_node') >= 0 && String(th40.result).indexOf('x') >= 0,
        '40 tool_help 能给出某个工具的完整参数', String(th40.result).slice(0, 70));
    const rt40 = await NF.aiTool('run_tool', { name: 'get_state' });
    log(rt40 && rt40.ok === true && rt40.result && rt40.result.ok === true,
        '40 run_tool 真的能代调别的工具（瘦身模式靠它保持完整能力）', JSON.stringify(rt40.result).slice(0, 70));
    const rtBad40 = await NF.aiTool('run_tool', { name: 'run_tool' });
    log(rtBad40 && rtBad40.ok === false && String(rtBad40.error).indexOf('不用套一层') >= 0,
        '40 run_tool 不许自己套自己（不会递归）', String(rtBad40.error).slice(0, 50));

    /* 7) 「提示词模式」：端点不认 tools 时，命令写在回复里的 json 代码块里 */
    NF.aiConfig({ toolMode: 'text' });
    const prTxt40 = NF.aiPrompt();
    log(prTxt40.indexOf('这次走文字命令') >= 0 && prTxt40.indexOf('"tool"') >= 0,
        '40 工具调用设成「文字命令」时，提示词里写清了 json 代码块怎么给', '长度 ' + prTxt40.length);
    NF.aiConfig({ toolMode: 'native' });
    log(NF.aiPrompt().indexOf('这次走文字命令') < 0, '40 设成「只用原生 tools」时那段说明就不发了', '—');
    NF.aiConfig({ toolMode: 'auto' });

    /* 8) 采样参数：本地小模型要能压最大输出、调温度 */
    NF.aiConfig({ temp: 0.7, maxTok: 1234 });
    log(NF.aiConfig().temp === 0.7 && NF.aiConfig().maxTok === 1234,
        '40 温度和最大输出存得下、读得回', JSON.stringify({ t: NF.aiConfig().temp, m: NF.aiConfig().maxTok }));
    NF.aiConfig({ temp: 9, maxTok: -5 });
    log(NF.aiConfig().temp === 2 && NF.aiConfig().maxTok === 0,
        '40 越界的采样参数会被夹回合法区间（不会把接口发炸）',
        JSON.stringify({ t: NF.aiConfig().temp, m: NF.aiConfig().maxTok }));

    /* 9) 「空 Key 也能发」的那条判断：没有 Key 时，只有本机地址放行 */
    NF.aiConfig({ base: 'https://api.openai.com/v1/chat/completions' });
    const cloudCan40 = NF.aiEnv().canSend;
    NF.aiConfig({ base: 'http://127.0.0.1:1234/v1/chat/completions' });
    const localCan40 = NF.aiEnv().canSend;
    log(localCan40 === true, '40 接口是本机地址时，没有 Key 也允许发送（Ollama 这类不校验 Key）', String(localCan40));
    log(cloudCan40 === hadKey40,
        '40 公网地址仍然要求有 Key（本地这条口子没开到公网）', '云 ' + cloudCan40 + ' / 本机 ' + localCan40 + ' / 有Key ' + hadKey40);

    /* 10) 真界面：设置面板里那几个控件在，点「填地址」真的换地址 */
    const needIds40 = ['ai-local-preset', 'ai-local-use', 'ai-local-probe', 'ai-local-models', 'ai-local-test',
      'ai-localnote', 'ai-local-mlist', 'ai-slim', 'ai-toolmode', 'ai-temp', 'ai-maxtok', 'ai-keynote'];
    const missIds40 = needIds40.filter((id) => !document.getElementById(id));
    log(missIds40.length === 0, '40 设置面板里本地模型那几个控件都在', missIds40.join(',') || needIds40.length + ' 个都在');
    const presetSel40 = document.getElementById('ai-local-preset');
    log(!!presetSel40 && presetSel40.options.length === 7,
        '40 预设下拉框把七家都列出来了', presetSel40 ? presetSel40.options.length + ' 个选项' : '没有控件');
    NF.aiConfig({ base: 'https://api.deepseek.com/v1/chat/completions' });
    if (presetSel40) presetSel40.value = 'llamacpp';
    const useBtn40 = document.getElementById('ai-local-use');
    if (useBtn40) useBtn40.click();
    await sleep(60);
    const baseNow40 = NF.aiState().base;
    log(useBtn40 && baseNow40 === 'http://127.0.0.1:8080/v1/chat/completions' && NF.aiEnv().local === true,
        '40 点「填地址」真的把预设的地址填进接口地址了', baseNow40);
    const chip40 = document.getElementById('ailocchip');
    log(!!chip40 && String(chip40.textContent).indexOf('本地') === 0,
        '40 AI 标题栏那个小标签会显示「本地 …」（一眼看出没出网）', chip40 ? chip40.textContent : '没有标签');
    const noteEl40 = document.getElementById('ai-localnote');
    log(!!noteEl40 && String(noteEl40.textContent).indexOf('不用填 Key') >= 0,
        '40 设置里的提示行说清了「本机端点不用填 Key」', String(noteEl40 ? noteEl40.textContent : '').slice(0, 40));
    const keyNote40 = document.getElementById('ai-keynote');
    log(!!keyNote40 && String(keyNote40.textContent).indexOf('不用填 Key') >= 0,
        '40 Key 下面那行也不再催着填 Key 了', String(keyNote40 ? keyNote40.textContent : '').slice(0, 40));

    /* 11) 探测本机：端口扫一圈，扫不到也要老实返回空数组（不能抛、不能卡死） */
    const t0p40 = Date.now();
    let hits40 = null, err40 = '';
    try { hits40 = await NF.aiLocalProbe(); } catch (e) { err40 = String((e && e.message) || e); }
    const dt40 = Date.now() - t0p40;
    log(!err40 && Array.isArray(hits40) && dt40 < 6000,
        '40 「探测本机」扫一圈就回来（没开服务就返回空数组，不抛也不卡）',
        (hits40 ? hits40.length + ' 个在开' : 'err') + ' / ' + dt40 + 'ms');

    /* 11b) AI 自己换接口：地址补全 / 本机判定 / 自动瘦身（r55 新增） */
    NF.aiConfig({ slim: 'auto' });
    const ep40a = await NF.aiEndpoint({ base: 'http://127.0.0.1:11434' });
    log(!!ep40a && ep40a.base === 'http://127.0.0.1:11434/v1/chat/completions' && ep40a.local === true && ep40a.slim === true,
        '40 ai_endpoint：只给「主机:端口」也会补成能直接发的地址，并判成本机 + 自动瘦身',
        JSON.stringify({ b: ep40a && ep40a.base, l: ep40a && ep40a.local, s: ep40a && ep40a.slim }));
    const ep40b = await NF.aiEndpoint({ base: 'ollama' });
    log(!!ep40b && ep40b.base === 'http://127.0.0.1:11434/v1/chat/completions' && ep40b.local === true,
        '40 ai_endpoint：也能直接给预设 id（ollama）', JSON.stringify({ b: ep40b && ep40b.base }));
    const ep40c = await NF.aiEndpoint({ base: 'https://api.deepseek.com/v1/chat/completions' });
    log(!!ep40c && ep40c.local === false && ep40c.slim === false,
        '40 ai_endpoint：换回公网地址就不算本机、也不瘦身了',
        JSON.stringify({ b: ep40c && ep40c.base, l: ep40c && ep40c.local, s: ep40c && ep40c.slim }));
    const t121 = (NF.aiTools() || []).filter((t) => t.name === 'ai_endpoint');
    log(t121.length === 1, '40 工具表里有 ai_endpoint（AI 能自己把对话切到本机模型）', (NF.aiTools() || []).length + ' 个工具');
    log(typeof NF.aiLocalTest === 'function' && typeof NF.aiLocalUse === 'function' && typeof NF.aiEndpoint === 'function',
        '40 本地大模型那几个动作对外都能直接调（测试连接 / 填地址 / 换接口）',
        [typeof NF.aiLocalTest, typeof NF.aiLocalUse, typeof NF.aiEndpoint].join(' / '));
    /* 11c) 换到本机端点后系统提示词当场换瘦身版（r55 修的漏洞） */
    if (!(NF.aiState().msgs > 0)) NF.aiSessionNew();
    NF.aiConfig({ base: 'https://api.deepseek.com/v1/chat/completions' });
    const sc40full = NF.aiState().sysChars;
    NF.aiConfig({ base: 'http://127.0.0.1:11434/v1/chat/completions' });
    const sc40slim = NF.aiState().sysChars;
    log(sc40full > 10000 && sc40slim > 500 && sc40slim * 3 < sc40full,
        '40 换到本机端点后系统提示词当场换成瘦身版（不是等到下次发请求才换）',
        sc40full + ' 字符 -> ' + sc40slim + ' 字符');
    NF.aiConfig({ base: 'https://api.deepseek.com/v1/chat/completions' });
    log(NF.aiState().sysChars > 10000 && NF.aiState().sysSlim === false,
        '40 换回公网地址又长回完整版', NF.aiState().sysChars + ' 字符');
    /* 11d) 每轮开口前补一条最新状态（r55 新增：省掉一次 get_state 往返） */
    const sl40 = NF.aiStateLine();
    let sl40j = null;
    try { sl40j = JSON.parse(sl40.slice(sl40.indexOf('】') + 1)); } catch (e) { sl40j = null; }
    log(typeof sl40 === 'string' && sl40.indexOf('【当前状态') === 0 && !!sl40j &&
        sl40j.神经元 === NF.stats().n && sl40j.连接 === NF.stats().e,
        '40 每轮开口会补一条最新状态（紧凑 JSON，当场能解析出神经元 / 连接数）',
        sl40.slice(0, 60) + '…（' + sl40.length + ' 字符）');
    /* 12) 配置能存能读：这几个新字段不许一重启就丢 */
    NF.aiConfig({ slim: 'on', toolMode: 'text', temp: 0.4, maxTok: 2048 });
    NF.aiReloadCfg();
    const back40 = NF.aiConfig();
    log(back40.slim === 'on' && back40.toolMode === 'text' && back40.temp === 0.4 && back40.maxTok === 2048,
        '40 本地模型那几项设置重新读一遍配置后还在（不会一重启就回默认）',
        JSON.stringify({ s: back40.slim, t: back40.toolMode, tp: back40.temp, m: back40.maxTok }));

    /* 收尾：接口地址 / 模型 / 开关 / 采样参数全部放回原样 */
    const rst40 = { base: st40.base, model: st40.model, slim: cfg40.slim, toolMode: cfg40.toolMode,
      temp: cfg40.temp, maxTok: cfg40.maxTok, autoRun: cfg40.autoRun };
    if (!cfg40.autoRun) rst40.autoRun = false;
    NF.aiConfig(rst40);
    log(NF.aiState().base === st40.base && NF.aiConfig().slim === cfg40.slim,
        '40 这一组跑完把接口地址和各种开关放回原处了', NF.aiState().base);
  } catch (e) {
    out.push('ERROR | 第 40 组（本地大模型）：' + ((e && e.stack) || e));
  }
  /* ==================== 41. 起步卡片 / 语言自动判定 ==================== */
  try {
    /* a) 语言自动判定：纯函数，跟跑这一页的机器是什么语言无关 */
    log(NF.langDetect(['en-US']) === 'en' && NF.langDetect(['zh-CN']) === 'zh',
      '41 界面语言跟着系统走：英文系统给 en、中文系统给 zh',
      NF.langDetect(['en-US']) + ' / ' + NF.langDetect(['zh-CN']));
    log(NF.langDetect(['fr-FR', 'en-GB']) === 'en' && NF.langDetect(['de-DE']) === 'zh' && NF.langDetect([]) === 'zh',
      '41 系统语言认不出来就按中文（主场在国内），列表里先碰上哪个算哪个',
      [NF.langDetect(['fr-FR', 'en-GB']), NF.langDetect(['de-DE']), NF.langDetect([])].join(' / '));
    log(NF.lang() === 'zh' && document.documentElement.lang === 'zh-CN',
      '41 这一页是中文界面（本机没存过语言，这是按系统语言判出来的）', NF.lang());

    /* b) 空工程：卡片自己浮出来，几条路真的都摆着 */
    NF.clear();
    await raf();
    const st41 = document.getElementById('starter');
    log(!!st41 && st41.classList.contains('show') && NF.starter().shown === true,
      '41 空工程时起步卡片自己浮出来（不再是一片黑等人猜下一步）', JSON.stringify(NF.starter()));
    const bs41 = st41 ? st41.querySelectorAll('[data-starter]') : [];
    log(bs41.length === 5, '41 卡片上摆了 5 条路（示例 / 打开 / AI 搭 / AI 导入 / 本机模型）', bs41.length + ' 个按钮');
    const oll41 = st41 ? st41.querySelector('[data-starter=ollama]') : null;
    log(!!oll41, '41 「不配 API Key 也能用」这条路就在卡片上（新手最容易卡在这一步）',
      oll41 ? oll41.textContent.trim() : '没有');
    log(!!(st41 && st41.querySelector('[data-starter=ai-import]')) && !!document.getElementById('starter-note'),
      '41 「让 AI 干」那两条 + 结果回话的位置都在（点本机模型那条要靠它说话）', 'ok');

    /* c) 从卡片上载入示例：图进来了，卡片自己收起来 */
    st41.querySelector('[data-starter=demo]').click();
    await sleep(250);
    log(NF.stats().n >= 20 && NF.starter().shown === false,
      '41 点卡片上的「载入示例网络」：图进来了、卡片自己收起来',
      NF.stats().n + ' 个神经元 / shown=' + NF.starter().shown);

    /* d) 第一次打开（图上已经有东西）也露一次头，人一动手就自己收回去 */
    const f41 = NF.starterForce();
    log(f41.shown === true && f41.force === true,
      '41 第一次打开时卡片也露一次头（这次示例网络已经在画布上）', JSON.stringify(f41));
    NF.select([0], []);
    await raf();
    log(NF.starter().shown === false && NF.starter().force === false,
      '41 一动手（选中一个神经元）卡片就自己收回去，不挡路', JSON.stringify(NF.starter()));
    NF.select([], []);
    await raf();

    /* e) × 点一次就记住：写进 nf.seen，以后不再自己冒出来 */
    NF.clear();
    await raf();
    try { localStorage.removeItem('nf.seen'); } catch (e) {}
    log(NF.starter().shown === true, '41 清空成空工程，卡片又回来（新建工程时正需要它）', JSON.stringify(NF.starter()));
    document.getElementById('starter-x').click();
    await raf();
    let seen41 = '';
    try { seen41 = String(localStorage.getItem('nf.seen') || ''); } catch (e) {}
    log(NF.starter().shown === false && seen41 === '1',
      '41 点一次 × 就收起并写进 nf.seen（以后不再自己冒出来）', 'shown=' + NF.starter().shown + ' / nf.seen=' + seen41);

    /* f) 视图栏那个「分层」按钮：大网络一眼看不懂时的低头路，真能重排 */
    const lb41 = document.querySelector('#viewbar [data-cmd=layout]');
    log(!!lb41, '41 视图栏多了「分层」按钮（不用翻菜单就能把网络排成一层一层）',
      lb41 ? lb41.textContent.trim() : '没有');
    document.querySelector('[data-cmd=demo]').click();
    await sleep(250);
    const n41 = NF.stats().n;
    const xy41 = [NF.node(0).x, NF.node(0).y, NF.node(0).z];
    const r41 = NF.relayout('layer');
    await raf();
    const moved41 = Math.abs(NF.node(0).x - xy41[0]) + Math.abs(NF.node(0).y - xy41[1]) + Math.abs(NF.node(0).z - xy41[2]);
    log(!!r41 && r41.mode === 'layer' && NF.stats().n === n41 && moved41 > 0,
      '41 「分层」重排真的动了坐标，但神经元和连接一个没多一个没少',
      JSON.stringify({ mode: r41 && r41.mode, n: NF.stats().n, moved: Math.round(moved41) }));
  } catch (e) {
    out.push('ERROR | 第 41 组（起步卡片）：' + ((e && e.stack) || e));
  }
  /* ---- 42 组：按区摆位置的那套（区重心 / 包围盒 + set_pos 认区名 + 按轴缩放） ----
     为什么单独测：AI 按区摆大脑布局时，四个约束缺一不可 ——
       ① 要能"看见"每个区在哪、多大（region_map 的 c / b），
       ② 要能不写编号就动一整个区（set_pos 的 region），
       ③ 要能改形状（set_pos 的 sx/sy/sz），
       ④ 这些参数得真出现在工具表里，AI 才看得见。 */
  try {
    NF.clear();
    await raf();
    for (let k = 0; k < 9; k++) NF.addNode((k % 3) * 10, 0, Math.floor(k / 3) * 10);
    await raf();
    const col = NF.node(0).color;
    const rm = NF.regionMap();
    const hit = rm.filter((e) => e.hexes && e.hexes.indexOf(col) >= 0)[0];
    log(!!hit && Array.isArray(hit.c) && hit.c.length === 3 && Array.isArray(hit.b) && hit.b.length === 6,
      '42 region_map 每项都带重心 c[3] 和包围盒 b[6]（按区摆位置只要这两个数，不用取几万个编号）',
      JSON.stringify(hit && { name: hit.name, n: hit.n, c: hit.c, b: hit.b }));

    const bx0 = NF.node(4).x;
    const rMove = await NF.aiTool('set_pos', { region: col, dx: 100 });
    await raf();
    const xsA = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => NF.node(i).x);
    log(Math.round(NF.node(4).x - bx0) === 100 && xsA.every((x) => x >= 100),
      '42 set_pos 给一个色号就把整个区一起挪了：不用把编号写出来，这是 AI 摆大布局的关键',
      JSON.stringify({ moved: Math.round(NF.node(4).x - bx0), ret: rMove, col: col, ids: NF.regionCells(col) ? NF.regionCells(col).ids.length : null }));

    const rScale = await NF.aiTool('set_pos', { region: col, sx: 2 });
    await raf();
    const xsB = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => NF.node(i).x);
    const w = Math.max.apply(null, xsB) - Math.min.apply(null, xsB);
    log(Math.round(w) === 40,
      '42 set_pos 的 sx 是以这一批包围盒的中心按轴缩放（3x3 本来 20 宽，2 倍后 40）',
      JSON.stringify({ width: Math.round(w), ret: rScale }));

    const t42 = NF.aiTools().filter((x) => x.name === 'set_pos')[0];
    log(!!(t42 && t42.args && t42.args.indexOf('region') >= 0 && t42.args.indexOf('sx') >= 0),
      '42 set_pos 的工具表里真的多了 region / sx / sy / sz（AI 看得见才用得上）',
      JSON.stringify(t42 && Object.keys(t42.args)));

    const st42 = NF.aiState();
    out.push('INFO 42 当前 AI | 模型=' + (st42 && st42.model) + ' 最大输出=' + (st42 && st42.maxTok) + ' 思考=' + (st42 && st42.think));
  } catch (e) {
    out.push('ERROR | 第 42 组（按区摆位置）：' + ((e && e.stack) || e));
  }

  /* ---- 43 组：改坐标不再每次全量刷新（大工程上"未响应"的根因之一） ----
     实测（born-wired-cortex，14.4 万神经元）：单个 NF.setPos 以前要 ~18ms，几乎全花在一次
     全量刷新上；脚本 / AI 按个循环改坐标就是几分钟的假死。现在刷新攒到一帧做一次。 */
  try {
    NF.clear();
    await raf();
    for (let k = 0; k < 2000; k++) NF.addNode((k % 50) * 2, Math.floor(k / 50) * 2, 0);
    await raf();
    const y0 = NF.node(1500).y, bx = NF.node(1500).x;
    NF.setPos(1500, bx + 7, y0, NF.node(1500).z);
    log(Math.abs(NF.node(1500).x - (bx + 7)) < 1e-6,
      '43 坐标改完立刻读回来就是新值（刷新可以攒，坐标不许攒）',
      JSON.stringify({ x: NF.node(1500).x }));
    NF.setPos(1500, bx, y0, NF.node(1500).z);
    log(typeof NF.flushPos === "function" && NF.flushPos() === true,
      '43 有 flushPos：截图 / 存盘前能把攒着的刷新立刻做掉（否则存到的是上一帧的场面）', 'ok');
    const t0 = performance.now();
    for (let k = 0; k < 1500; k++) NF.setPos(k, NF.node(k).x + 0.001, NF.node(k).y, NF.node(k).z);
    const ms = performance.now() - t0;
    await raf();
    log(ms < 1500,
      '43 连续 1500 次单点改坐标不再每次全量刷新（以前一次约 18ms，1500 次要二十多秒）',
      JSON.stringify({ ms: Math.round(ms) }));
  } catch (e) {
    out.push('ERROR | 第 43 组（改坐标不再全量刷新）：' + ((e && e.stack) || e));
  }

  /* ---- 44 组：区色被换过也能按区寻址（按几何认区的兜底） ----
     来历：born-wired-cortex 那份工程的颜色被换成了渐变色阶，调色板一个区都对不上，
     于是 region_cells 按区名一律返回 null，按区寻址 / 按区摆位置整套失效。 */
  try {
    NF.clear();
    await raf();
    for (let k = 0; k < 8; k++) NF.addNode((k % 4) * 5, Math.floor(k / 4) * 5, 0);
    for (let k = 0; k < 4; k++) NF.addNode(300 + (k % 2) * 5, Math.floor(k / 2) * 5, 0);
    await raf();
    const rm = NF.regionMap();
    const named = rm.filter((e) => /^区[0-9]+$/.test(e.name));
    log(rm.length >= 2 && named.length === rm.length && !!rm[0].c && !!rm[0].b,
      '44 调色板对不上时按几何认区：给 区N 编号 + 规模 + 重心 + 包围盒（不再是一片空名字）',
      JSON.stringify(rm.map((e) => e.name + ":" + e.n)));
    const big = rm[0], small = rm[rm.length - 1];
    const g1 = NF.regionCells(big.name);
    log(!!g1 && g1.geo === true && g1.total === big.n && g1.ids.length === big.n,
      '44 regionCells 能按 区N 取到细胞（以前按区名一律 null）',
      JSON.stringify({ name: g1 && g1.name, total: g1 && g1.total }));
    const idsA = g1.ids.slice();
    const before = [];
    for (let i = 0; i < NF.graph().n; i++) before.push(NF.node(i).x);
    await NF.aiTool('set_pos', { region: big.name, dx: 40 });
    await raf();
    let okMove = true, moved = 0;
    for (let i = 0; i < NF.graph().n; i++) {
      const want = (idsA.indexOf(i) >= 0) ? 40 : 0;
      const d = NF.node(i).x - before[i];
      if (Math.abs(d - want) > 1e-4) okMove = false;
      if (Math.abs(d) > 1e-4) moved++;
    }
    log(okMove && moved === big.n,
      '44 set_pos 认 区N：整块搬走，别的区块一动没动（AI 因此不用把几万个编号写进对话）',
      JSON.stringify({ moved: moved, want: big.n, small: small.name }));
  } catch (e) {
    out.push('ERROR | 第 44 组（按几何认区）：' + ((e && e.stack) || e));
  }

  /* ---- 45 组：调色板认出来的区也必须有重心 / 包围盒 ----
     为什么单独测：region_map 的手册里写着「每项都带重心 c 和包围盒 b」，但**调色板认出来的项**
     以前没有 .hex 字段（只有 hexes），而查盒子是按 .hex 查的 —— 于是一个都查不到。导入进来的
     模型（区色就是这套调色板）里 12 个有名字的区全长这样：AI 想「把视觉区挪到后面」拿不到 c / b，
     只能退回去把几万个编号拉进对话。这一组就是钉住这条路，别再退回去。 */
  try {
    NF.clear();
    await raf();
    for (let k = 0; k < 6; k++) NF.addNode(k * 10, 0, 0);
    await raf();
    /* 调色板里的数是线性空间的（导入器直接把这些数写进颜色数组），而 setColor 收的是 sRGB 色号，
       所以要先按 sRGB 传输函数编码一遍再点色。base 会让这个区被认成「视觉」，lift 是同一个区
       被提亮 0.25 的那一半（导入器给「有名字的细胞」提亮）。 */
    const srgb255 = (v) => Math.round(Math.max(0, Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)) * 255);
    const hexOfRGB = (t) => '#' + t.map((v) => srgb255(v).toString(16).padStart(2, '0')).join('');
    const base = hexOfRGB([0.20, 0.62, 1.00]);
    const lift = hexOfRGB([0.45, 0.87, 1.00]);
    NF.setColor([0, 1, 2], base);
    NF.setColor([3, 4, 5], lift);
    await raf();
    const rm45 = NF.regionMap();
    const hit45 = rm45.filter((e) => e.hexes && e.hexes.indexOf(base) >= 0)[0];
    log(!!hit45 && !hit45.geo && Array.isArray(hit45.c) && hit45.c.length === 3 && Array.isArray(hit45.b) && hit45.b.length === 6,
      '45 调色板认出来的区也带重心 c[3] 和包围盒 b[6]（以前这类区一个都没有）',
      JSON.stringify(hit45 && { name: hit45.name, n: hit45.n, geo: !!hit45.geo, hexes: hit45.hexes.length, c: hit45.c, b: hit45.b }));
    log(!!hit45 && hit45.n === 6 && hit45.hexes.length === 2,
      '45 同一个区的两个色号（原色 + 提亮）并成一项：个数是 6 不是 3，重心是整块的',
      JSON.stringify(hit45 && { n: hit45.n, hexes: hit45.hexes.length, c: hit45.c }));
    log(!!hit45 && hit45.b[0] === 0 && hit45.b[3] === 50 && hit45.b[1] === 0 && hit45.b[4] === 0,
      '45 合并后的包围盒覆盖整个区（x 从 0 到 50，y 都是 0）',
      JSON.stringify(hit45 && hit45.b));
  } catch (e) {
    out.push('ERROR | 第 45 组（调色板区的重心）：' + ((e && e.stack) || e));
  }


  /* 收尾：把用户原来的 Key 放回原处（自测绝不给用户留副作用）。
     走的是「用户明确保存」那条路，本机存储、设置文件、备份三份会一起写正确。 */
  try {
    if (KEEP19.key || KEEP19.visKey) {
      window.NF.aiConfig({ key: KEEP19.key, visKey: KEEP19.visKey });
      await sleep(500);
      const bk = window.NF.aiState();
      out.push((bk.keyLen === KEEP19.key.length ? 'PASS' : 'FAIL') + ' | 收尾：用户原来的 Key 原样放回去了 | ' + bk.keyLen + '/' + KEEP19.key.length + ' 位');
    }
  } catch (e) { out.push('ERROR | 收尾放回 Key：' + ((e && e.message) || e)); }
  /* 裁判的账：整场自测（连线 / 删点 / 剪枝 / 调参 / 隐藏 / 撤销 / 重做 / 载入都在里面）跑下来
     一次漏报都不许有。miss > 0 = 有写入点漏打了 histEdgeDirty 钩子，那条改动撤销时会静默回错格。 */
  try {
    const hm = window.NF.histMarks();
    out.push((hm.miss === 0 ? 'PASS' : 'FAIL') + ' | 裁判：整场自测的连接列写入登记没有漏报 | checks=' + hm.checks + ' miss=' + hm.miss + ' fast=' + hm.fast + ' soft=' + hm.soft + ' ' + JSON.stringify(hm.missAt));
    window.NF.histVerify(false);
  } catch (e) { out.push('ERROR | 读撤销登记状态：' + ((e && e.message) || e)); }
  const pass = out.filter(l => l.indexOf('PASS') === 0).length;
  const fail = out.filter(l => l.indexOf('FAIL') === 0 || l.indexOf('ERROR') === 0).length;
  const pre = document.createElement('pre');
  pre.id = 'nf-testout';
  pre.textContent = out.join('\\n') + '\\n\\n== ' + pass + ' PASS / ' + fail + ' FAIL ==';
  pre.setAttribute('style', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:99999;margin:0;padding:16px;background:#05070c;color:#bff5c8;font:13px/1.55 Consolas,monospace;white-space:pre-wrap;overflow:auto');
  document.body.appendChild(pre);
  /* INFO / SCALE- 开头的是「报个数」，不算失败，也不许往标题里塞——
     塞了标题就不是 P/0F 结尾了，批量校验会一直等到超时。 */
  const bad = out.filter((l) => l.indexOf('PASS') !== 0 && l.indexOf('SCALE-') !== 0 && l.indexOf('INFO') !== 0);
    document.title = 'NFTEST ' + pass + 'P/' + fail + 'F' + (bad.length ? ' || ' + bad.join(' // ') : '');
})();
<\/script>
`;

/* 自测必须从“全新安装”状态开始：上次手工切过的语言会留在 localStorage，
   不清掉的话界面语言断言就取决于本机状态，结果不可复现。 */
if (!html.includes('<head>')) throw new Error('no <head>');
const FRESH = '<' + 'script>try{["nf.lang","nf.ui","nf.ai","nf.ai.bak","nf.aiui","nf.autosave","nf.modules","nf.views","nf.seen"].forEach(function(k){localStorage.removeItem(k);});}catch(e){}<' + '/script>';
const freshLog = html.replace('<head>', '<head>' + FRESH).replace('</body>', TEST.split('{{MV}}').join(AI_MANUAL_VERSION) + '</body>');
fs.writeFileSync('prototype/_selftest.html', freshLog);
console.log('已生成自测页 prototype/_selftest.html');

