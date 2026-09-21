import fs from 'node:fs';
const SRC = 'prototype/神经元编辑器原型.html';
const html = fs.readFileSync(SRC, 'utf8');
if (!html.includes('</body>')) throw new Error('no </body>');

const TEST = `
<script>
(async () => {
  const out = [];
  const log = (ok, name, detail) => out.push((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + (detail == null ? '' : detail));
  const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const pre = document.createElement('pre');
  pre.id = 'nf-compatout';
  pre.style.display = 'none';
  document.body.appendChild(pre);
  const done = (t) => { pre.textContent = out.join('\\n'); document.title = t; };
  try {
    await raf();
    const NF = window.NF;
    if (!NF) throw new Error('NF 未挂载');
    if (document.readyState !== 'complete') await new Promise(r => addEventListener('load', r));

    /* 把容器头的 JSON 换掉、后面照样接着原字节：offset 全是相对的，所以能这么干 */
    const rewrite = (buf, fn) => {
      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      const headLen = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(8, true);
      const head = JSON.parse(new TextDecoder().decode(u8.subarray(16, 16 + headLen)));
      fn(head);
      const json = new TextEncoder().encode(JSON.stringify(head));
      const o = new Uint8Array(16 + json.length + (u8.length - 16 - headLen));
      o.set(u8.subarray(0, 16), 0);
      new DataView(o.buffer).setUint32(8, json.length, true);
      o.set(json, 16);
      o.set(u8.subarray(16 + headLen), 16 + json.length);
      return o;
    };
    const why = (buf) => { try { NF.inspectFile(buf); return null; } catch (e) { return String((e && e.message) || e); } };

    /* ---------- 1) 真样本：每个 .nforge 都要能读，且键集合本来就五花八门 ---------- */
    const names = ['torch_demo.nforge', '_blockdemo_raw.nforge', '_impdemo.nforge', '_opdemo.nforge',
                   '_streamdemo_raw.nforge', '_tieddemo.nforge', 'cross_from_py.nforge',
                   'cross_from_py_spatial.nforge', 'cross_from_py_whole.nforge'];
    const shapes = new Map();
    let bad = 0, minKeys = null, maxKeys = null, readOk = 0;
    for (const nm of names) {
      const r = await fetch('/' + nm);
      if (!r.ok) { bad++; continue; }
      const u8 = new Uint8Array(await r.arrayBuffer());
      const e = why(u8);
      if (e) { bad++; log(false, '样本能读：' + nm, e); continue; }
      readOk++;
      const h = NF.inspectFile(u8);
      const ks = Object.keys(h).sort().join(',');
      shapes.set(ks, (shapes.get(ks) || 0) + 1);
      if (!minKeys || Object.keys(h).length < minKeys.n) minKeys = { n: Object.keys(h).length, nm };
      if (!maxKeys || Object.keys(h).length > maxKeys.n) maxKeys = { n: Object.keys(h).length, nm };
    }
    log(bad === 0, '历史样本全部能读', readOk + '/' + names.length + ' 个文件');
    log(shapes.size >= 4, '历史样本的文件头本来就形态各异', shapes.size + ' 种键集合 / ' + names.length + ' 个文件');
    log(!!minKeys && !!maxKeys && maxKeys.n > minKeys.n,
        '字段最少 / 最多的样本都能读（靠可选键扩展）',
        minKeys.nm + ' 有 ' + minKeys.n + ' 个键 · ' + maxKeys.nm + ' 有 ' + maxKeys.n + ' 个');

    /* ---------- 2) 拿真容器做实验 ---------- */
    NF.clear();
    const L = [];
    for (let l = 0; l < 3; l++) { const row = []; for (let i = 0; i < 8; i++) row.push(NF.addNode(i * 3, l * 5, 0)); L.push(row); }
    NF.setIO(L[0], 1); NF.setIO(L[2], 2);
    for (let l = 0; l + 1 < 3; l++) for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if ((i + j + l) % 3 !== 0) NF.addEdge(L[l][i], L[l + 1][j], ((i - j) / 8));
    const c0 = await NF.encodeV3({ chunkNeurons: 8 });
    const g0 = NF.graph();
    log(g0.n === 24 && g0.e > 0, '造出一份 v3 容器做实验', g0.n + ' 神经元 / ' + g0.e + ' 连接 / ' + c0.length + ' 字节');

    const load = async (buf) => { await NF.loadBuffer(buf); return { n: NF.graph().n, e: NF.graph().e, p: [NF.node(0).x, NF.node(0).y, NF.node(0).z, NF.node(9).x, NF.node(23).y] }; };
    const base = await load(c0);
    log(base.n === g0.n && base.e === g0.e, '原样重载：图对得上', base.n + '/' + base.e);

    /* 未知键 + 未知尾巴分区 = 将来加功能的样子 */
    const c1 = rewrite(c0, (h) => { h.xFutureThing = { note: '将来加的键' }; h.counts.zzFutureCount = 0; });
    const withTail = new Uint8Array(c1.length + 8192);
    withTail.set(c1, 0);
    for (let i = c1.length; i < withTail.length; i++) withTail[i] = (i * 37) & 255;
    log(why(withTail) === null, '文件头多一个没见过的键，照样认', why(withTail) || '—');
    const r1 = await load(withTail);
    log(r1.n === base.n && r1.e === base.e && r1.p.join() === base.p.join(),
        '文件末尾多一段没见过的分区，照样读得一模一样',
        r1.n + '/' + r1.e + ' 坐标 ' + r1.p.join(',') + ' vs ' + base.p.join(','));

    /* layout：给"加键但布局没变"留的前向门 */
    const v4ok = rewrite(c0, (h) => { h.version = 4; h.layout = 3; });
    log(why(v4ok) === null, 'v4 文件声明了 layout:3 -> 敢读', why(v4ok) || '—');
    const r2 = await load(v4ok);
    log(r2.n === base.n && r2.e === base.e, 'layout:3 的 v4 文件读出来跟 v3 一致', r2.n + '/' + r2.e);

    const v4 = rewrite(c0, (h) => { h.version = 4; delete h.layout; });
    const e4 = why(v4);
    log(!!e4 && e4.indexOf('v4') >= 0, 'v4 且没说布局 -> 拒绝，并且点明是 v4', e4);
    const v2 = why(rewrite(c0, (h) => { h.version = 2; }));
    log(!!v2 && v2.indexOf('v2') >= 0, 'v2 布局 -> 拒绝，并且点明是 v2', v2);
    const ef = why(rewrite(c0, (h) => { h.format = 'other-thing'; }));
    log(!!ef && ef.indexOf('format') >= 0, 'format 不对 -> 拒绝，并且点明 format', ef);
    const ev = why(rewrite(c0, (h) => { delete h.version; }));
    log(!!ev && ev.indexOf('版本号') >= 0, '没写版本号 -> 拒绝，说人话', ev);

    /* ---------- 3) 更老的 JSON 工程（v1/v2）也还得能开 ---------- */
    const doc = NF.serializeV2();
    const gj = NF.graph();
    const back = NF.loadV2(JSON.parse(JSON.stringify(doc)));
    log(back.n === gj.n && back.e === gj.e, '旧版 JSON 工程还能读回来', back.n + '/' + back.e);
    log(NF.detectFile(new TextEncoder().encode(JSON.stringify(doc))) === false &&
        NF.detectFile(c0) === true, 'JSON 工程和分块容器分得清', '—');

    const fails = out.filter((l) => l.startsWith('FAIL')).length;
    done('NFCOMPAT ' + (out.length - fails) + 'P/' + fails + 'F' + (fails ? ' BAD' : ''));
  } catch (e) {
    done('NFCOMPAT ERR ' + String((e && e.stack) || e));
  }
})();
<\/script>
`;
fs.writeFileSync('prototype/_compatcheck.html', html.replace('</body>', TEST + '</body>'));
console.log('generated prototype/_compatcheck.html');
