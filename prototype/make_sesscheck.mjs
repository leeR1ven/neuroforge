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
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const pre = document.createElement('pre');
  pre.id = 'nf-sessout';
  pre.style.display = 'none';
  document.body.appendChild(pre);
  const done = (t) => { pre.textContent = out.join('\\n'); document.title = t; };
  try {
    await raf();
    const NF = window.NF;
    if (!NF) throw new Error('NF 未挂载');
    if (document.readyState !== 'complete') await new Promise(r => addEventListener('load', r));

    const S = () => NF.aiSessions();
    const sess = (id) => S().sessions.filter(x => x.id === id)[0] || null;

    /* ---------- 1) 起点：一个工程里就是一段对话 ---------- */
    NF.aiSessionReset('自测起点');
    const s0 = S(), id0 = s0.当前;
    log(!!id0 && s0.sessions.length === 1 && s0.sessions[0].正在用 === true,
        '一开始就有一段对话，并且标出正在用的是哪一段', s0.sessions.length + ' 段 · id=' + id0);

    /* ---------- 2) 新开一段：旧的留着，能改名、能切回去 ---------- */
    const id1 = NF.aiSessionNew('自测第二段');
    const s1 = S();
    log(s1.sessions.length === 2 && s1.当前 === id1 && !!sess(id0), '新开一段不会把旧的那段丢掉', s1.sessions.length + ' 段');
    NF.aiSessionRename(id0, '第一段（改过名）');
    log(sess(id0) && sess(id0).标题 === '第一段（改过名）', '能给对话改名', sess(id0) ? sess(id0).标题 : '(没找到)');
    log(NF.aiSessionLoad(id0) === true && S().当前 === id0, '能切回旧的那一段', '当前=' + S().当前);

    /* ---------- 3) 删 ---------- */
    let delErr = '';
    try { NF.aiSessionDel(id0); } catch (e) { delErr = String((e && e.message) || e); }
    log(delErr.indexOf('先切') >= 0, '正在用的那一段不给删，而且说清为什么', delErr);
    const id2 = NF.aiSessionNew('待删的一段');
    NF.aiSessionLoad(id0);
    log(NF.aiSessionDel(id2) === true && !sess(id2), '切走之后就能删掉另一段', '还剩 ' + S().sessions.length + ' 段');

    /* ---------- 4) 换工程（新建）之前，上一个工程的对话先落到本机那份 ---------- */
    const put0 = await NF.aiArchivePut();
    const preN = S().sessions.length;
    NF.clear();
    log(S().sessions.length === 1 && !sess(id0), '新建工程 = 一段全新的对话（旧工程那几段不跟过来）',
        S().sessions.length + ' 段');
    let flushed = false;
    for (let i = 0; i < 24 && !flushed; i++) {
      await sleep(60);
      const a = await NF.aiArchive();
      const rec = a.filter(x => x.pid === put0.pid)[0];
      if (rec && rec.段数 === preN) {
        flushed = true;
        log(true, '换工程之前，上一个工程的对话已经落到本机那份里', rec.段数 + ' 段 · ' + rec.name);
      }
    }
    if (!flushed) log(false, '换工程之前，上一个工程的对话已经落到本机那份里',
        '没等到（本机存档里没有 ' + put0.pid + ' 的 ' + preN + ' 段）');

    /* ---------- 5) 核心：对话跟着工程文件走 ---------- */
    const sid0 = S().当前;
    NF.aiSessionRename(sid0, '这段对话要跟着工程走');
    const A = NF.addNode(0, 0, 0), B = NF.addNode(10, 0, 0), C = NF.addNode(20, 0, 0);
    NF.addEdge(A, B, 0.5); NF.addEdge(B, C, 0.25);
    const doc = NF.aiSessionDoc();
    log(doc.sessions.length === S().sessions.length && doc.sid === S().当前,
        '要写进文件的那一份跟面板上看到的完全一致', doc.sessions.length + ' 段 · sid=' + doc.sid);
    const put = await NF.aiArchivePut();
    log(!!(put && put.ok), '本机那份对话存档写得进去（IndexedDB）', 'pid=' + (put && put.pid));

    const buf = await NF.encodeV3({ chunkNeurons: 4 });
    const H = NF.inspectFile(buf);
    log(!!H.ai && H.ai.count === doc.sessions.length && H.ai.len > 0,
        '工程文件头里写下了对话那一段的索引', JSON.stringify(H.ai));
    log(H.version === 3 && (H.layout === undefined || H.layout === 3),
        '字节布局版本没动（老软件照样打得开这份文件）', 'version=' + H.version);
    log(!!H.pid && H.pid === put.pid, '工程自己的记号跟着文件走（本机存档靠它认工程）', H.pid);

    /* 模拟「换台电脑打开」：把会话清干净，再从文件读回来 */
    NF.aiSessionReset('自测：模拟另一台电脑打开');
    const fresh = S();
    log(fresh.sessions.length === 1 && fresh.当前 !== doc.sid, '重置=一段全新的对话', fresh.sessions.length + ' 段');
    const r = await NF.loadBuffer(buf);
    const back = S();
    log(back.sessions.length === doc.sessions.length && back.当前 === doc.sid,
        '从工程文件读回来：整份对话都回来了，连「正在用的那段」都对上',
        back.sessions.length + ' 段 · 当前=' + back.当前);
    log(!!sess(doc.sid) && sess(doc.sid).标题 === '这段对话要跟着工程走', '每段的标题也在',
        sess(doc.sid) ? sess(doc.sid).标题 : '(没找到)');
    const qrow = NF.aiSessions().sessions.filter(x => x.id === doc.sid)[0] || {};
    log(String(qrow.最后 || '').indexOf(String(new Date().getFullYear())) === 0,
        '读回来的时间还是今年（不是 1969——那是时间戳被 32 位挤爆的样子）', qrow.最后);
    log(r.n === 3 && r.e === 2, '图本身照样读回来', r.n + ' 神经元 / ' + r.e + ' 连接');
    const rd = NF.aiSessionRead(doc.sid, 10);
    log(rd.id === doc.sid && rd.标题 === '这段对话要跟着工程走', 'AI 能把某一段对话的内容读出来',
        rd.读了 + ' 条 · ' + rd.标题);
    const arch = await NF.aiArchive();
    log(arch.filter(x => x.pid === H.pid && x.current).length === 1,
        '本机存档认得出来这是同一个工程（记号对上了）', arch.length + ' 条存档');

    /* ---------- 6) 对话那段的两条解码路：raw / deflate ---------- */
    const rewrite = (buf2, fn) => {
      const u8 = buf2 instanceof Uint8Array ? buf2 : new Uint8Array(buf2);
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
    const deflate = async (u8) => {
      const cs = new CompressionStream('deflate'), w = cs.writable.getWriter();
      w.write(u8); w.close();
      return new Uint8Array(await new Response(cs.readable).arrayBuffer());
    };
    const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
    const synth = { v: 1, sid: 'sx-1', seq: 90, sessions: [
      { id: 'sx-1', n: 88, title: '外面拼出来的对话', at: Date.now(), created: Date.now(), mv: 'r1',
        msgs: [{ role: 'user', content: '这句话是从别的机器上带过来的' },
               { role: 'assistant', content: '收到' }],
        log: [{ role: 'user', text: '这句话是从别的机器上带过来的' }], did: [] } ] };
    for (const codec of ['raw', 'deflate']) {
      /* ai:false = 先造一份「没有对话那一段」的文件，再把外面拼的那段接在最末尾 */
      const base = await NF.encodeV3({ chunkNeurons: 4, ai: false });
      let body = enc(synth);
      if (codec === 'deflate') body = await deflate(body);
      const withAi = rewrite(base, (h) => { h.ai = { off: 0, len: body.length, raw: 0, codec: codec, count: 1 }; });
      const u8 = new Uint8Array(withAi.length + body.length);
      u8.set(withAi, 0); u8.set(body, withAi.length);
      NF.aiSessionReset('自测：' + codec);
      const rr = await NF.loadBuffer(u8);
      const st = S();
      log(st.当前 === 'sx-1' && st.sessions.length === 1 && st.sessions[0].标题 === '外面拼出来的对话',
          '对话那段按 ' + codec + ' 存的：读得出来', st.sessions.length + ' 段 · 当前=' + st.当前);
      log(rr.n === 3 && rr.e === 2, codec + ' 那份的图也照样读回来', rr.n + '/' + rr.e);
    }

    /* ---------- 7) 老文件没这一段 / 字节缺了 ---------- */
    NF.aiSessionReset('自测：老文件');
    const idBefore = S().当前;
    const noAi = rewrite(await NF.encodeV3({ chunkNeurons: 4, ai: false }), (h) => { delete h.ai; });
    const r3 = await NF.loadBuffer(noAi);
    log(r3.n === 3 && S().sessions.length === 1 && S().当前 === idBefore,
        '老文件里没有对话这一段：图照读，正在用的那段不动', S().sessions.length + ' 段');

    const cut = rewrite(await NF.encodeV3({ chunkNeurons: 4 }), (h) => { h.ai = { off: 0, len: 999999, codec: 'raw', count: 1 }; });
    const r4 = await NF.loadBuffer(cut);
    log(r4.n === 3 && r4.e === 2 && S().sessions.length === 1,
        '文件说这里有一段对话、字节却缺了：图照样读出来，只留一句说明', r4.n + '/' + r4.e);

    /* ---------- 8) 旧版 JSON 工程也带着 ---------- */
    const j = NF.serializeV2();
    log(!!j.ai && j.ai.sessions.length >= 1, 'v2 JSON 工程里也带着对话', j.ai ? j.ai.sessions.length + ' 段' : '(没有)');
    NF.aiSessionReset('自测：JSON 载入');
    NF.loadV2(JSON.parse(JSON.stringify(j)));
    log(S().sessions.length === j.ai.sessions.length && S().当前 === j.ai.sid,
        'v2 JSON 读回来对话也在', S().sessions.length + ' 段');

    /* ---------- 9) 本机那份：能拿回来、能删 ---------- */
    NF.aiSessionReset('自测：本机存档');
    const n0 = S().sessions.length;
    const got = await NF.aiArchiveLoad(put.pid);
    log(got.added >= 1 && S().sessions.length === n0 + got.added,
        '本机那份能拿回列表里（不动正在用的这段）', '拿回 ' + got.added + ' 段');
    log(await NF.aiArchiveDel(put.pid) === true, '本机那份能删掉', 'pid=' + put.pid);
    const arch2 = await NF.aiArchive();
    log(arch2.filter(x => x.pid === put.pid).length === 0, '删完本机列表里就没有了', arch2.length + ' 条');

    /* ---------- 10) 工具表：四个新工具都真的接在活着的 NF 上 ---------- */
    const tools = NF.aiTools().map(x => x.name);
    const want = ['ai_sessions', 'ai_session_new', 'ai_session_switch', 'ai_session_read'];
    log(want.every(w => tools.indexOf(w) >= 0), '四个对话工具都挂上了', want.join(' / '));
    const audit = NF.aiAudit();
    log(audit.missing.length === 0, '手册/工具里写的接口在活着的 NF 上都能找到', audit.missing.join('; ') || '—');
    log(S().sessions.length >= 1, '忙完这一圈，对话表还是好好的', S().sessions.length + ' 段');

    /* ---------- 11) 界面：标题栏那个「对话」键真的能拉开面板 ---------- */
    const btn = document.querySelector('[data-aicmd="sessions"]');
    log(!!btn, 'AI 框标题栏里有「对话」这个键');
    const panel = document.getElementById('aisess');
    log(!!panel && getComputedStyle(panel).display === 'none', '这块面板默认是收着的（不占地方）');
    btn.click();
    await raf();
    const rows = document.querySelectorAll('#aislist .aisrow').length;
    const info = (document.getElementById('aisinfo') || {}).textContent || '';
    log(getComputedStyle(panel).display === 'flex' && rows >= 1,
        '点一下拉开，里面列着这个工程的几段对话', rows + ' 行 · ' + info);
    log(!!document.querySelector('#aisess .aishead button[data-aicmd="new"]') && !!document.getElementById('aisarch'),
        '面板上有「新开一段」，下面还有本机兜底那份的位置',
        document.querySelectorAll('#aisarch .aisrow').length + ' 条本机记录');
    btn.click();
    await raf();
    log(getComputedStyle(panel).display === 'none', '再点一下收回去');
    /* 设置面板和对话面板是并列的两块抽屉：开一个另一个要让位 */
    document.querySelector('[data-aicmd="set"]').click();
    await raf();
    const setDisp = getComputedStyle(document.getElementById('aiset')).display;
    document.querySelector('[data-aicmd="sessions"]').click();
    await raf();
    log(setDisp === 'flex' && getComputedStyle(document.getElementById('aiset')).display === 'none',
        '开「对话」的时候「设置」自己让位（两块抽屉不会叠在一起）',
        '设置面板：开时 ' + setDisp + ' → 现在 ' + getComputedStyle(document.getElementById('aiset')).display);

    /* ---------- 12) 老版本写坏的日志行（1969 那种）载入时清掉 ---------- */
    const jj = JSON.parse(JSON.stringify(NF.serializeV2()));
    const badNote = '这段对话是跟着这份工程一起存下来的（打开工程）：用 add_node …（1969/12/19 12:06:54，13 条上下文）。';
    const goodNote = '已经切到这段对话（脚本切的）：…（2026/9/20 16:33:43，13 条上下文）。';
    const userLine = { role: 'user', text: '用户自己说的话里写了（1969/12/19）这几个字，得原样留着' };
    jj.ai.sessions[0].log = [{ role: 'note', text: badNote }, { role: 'note', text: goodNote }, userLine];
    NF.aiSessionReset('自测：坏日志行');
    NF.loadV2(jj);
    const docBack = NF.aiSessionDoc();
    let lg = null;
    for (const x of docBack.sessions) if ((x.log || []).length >= 2) { lg = x.log; break; }
    const has = (frag) => (lg || []).some(e => String((e && e.text) || '').indexOf(frag) >= 0);
    log(!!lg && !has('1969/12/19 12:06:54'),
        '老版本 32 位溢出写坏的 1969 那行日志，载入时清掉',
        lg ? JSON.stringify(lg.map(e => String(e.role))) : '(没读到日志)');
    log(!!lg && has('2026/9/20 16:33:43'), '同一段里正常的日志行不受影响');
    log(!!lg && has('得原样留着'), '只有自动生成的提示行会被清，人和 AI 说的话一个字都不动');
    /* ---------- 13) 同一条提示不叠：以前每打开一次工程追一条，日志被一句话刷屏 ---------- */
    const dupNote = (n) => ({ role: 'note', k: 'sess-file',
      text: '这段对话是跟着这份工程一起存下来的（打开工程）：A，共 ' + n + ' 条上下文。接着往下说就行。' });
    const cleaned = NF.aiLogCleanTest([dupNote(3), { role: 'user', text: '这是人说的话' },
      dupNote(4), dupNote(5)]);
    const dupLeft = cleaned.filter(e => e && e.k === 'sess-file').length;
    log(dupLeft === 1 && cleaned.length === 2,
        '同一类提示只留一条（其余就地换掉，不是往后追）', dupLeft + ' 条提示 / 共 ' + cleaned.length + ' 条');
    log(cleaned.length && String(cleaned[0].text).indexOf('共 5 条上下文') >= 0, '留下的是最新那一条',
        String(cleaned.length && cleaned[0].text).slice(0, 34) + '…');
    log(cleaned[1] && cleaned[1].role === 'user', '人和 AI 说过的话不受影响', cleaned[1] && cleaned[1].role);
    /* 老存档里那两条没有 k（按文本前缀认），普通提示重复出现照留 */
    const legacy = NF.aiLogCleanTest([
      { role: 'note', text: '这段对话是跟着这份工程一起存下来的（打开工程）：A，共 3 条上下文。' },
      { role: 'note', text: '这段对话是跟着这份工程一起存下来的（打开工程）：A，共 4 条上下文。' },
      { role: 'note', text: '已经切到这段对话：B，共 2 条上下文。' },
      { role: 'note', text: '已经切到这段对话：B，共 2 条上下文。' },
      { role: 'note', text: '普通提示，重复出现也要留着' },
      { role: 'note', text: '普通提示，重复出现也要留着' }]);
    log(legacy.length === 4, '老存档里的重复提示也认（没有 k 就按文本前缀），普通提示原样不动',
        legacy.length + ' 条');
    /* 真·现场：走一遍「打开工程」，文件里那份日志带着一堆重复提示 */
    const baseDoc = NF.serializeV2();
    const spamDoc = (times) => {
      const d = JSON.parse(JSON.stringify(baseDoc));
      d.ai.sid = d.ai.sessions[0].id;
      d.ai.sessions[0].log = [];
      for (let k = 0; k < times; k++) d.ai.sessions[0].log.push({ role: 'note',
        text: '这段对话是跟着这份工程一起存下来的（打开工程）：A，共 3 条上下文。接着往下说就行。' });
      return d;
    };
    const spamCount = () => NF.aiLog().filter(e =>
      String((e && e.text) || '').indexOf('这段对话是跟着这份工程一起存下来的') === 0).length;
    NF.aiSessionReset('自测：提示不叠');
    NF.loadV2(spamDoc(6));
    log(spamCount() === 1, '载入一份被重复提示刷屏的老工程，只留一条', spamCount() + ' 条');
    const lLen0 = NF.aiLog().length;
    NF.loadV2(spamDoc(6));
    NF.loadV2(spamDoc(6));
    log(spamCount() === 1 && NF.aiLog().length === lLen0,
        '再打开几次也不会又追一条（这才是「每次打开都刷一句」的根源）',
        spamCount() + ' 条 · 日志 ' + lLen0 + ' -> ' + NF.aiLog().length);
    NF.loadV2(spamDoc(1));
    log(spamCount() === 1 && NF.aiLog().length === lLen0,
        '文件里本来就只有一条时，也不会变成两条',
        spamCount() + ' 条 · 日志 ' + NF.aiLog().length);
    /* ---------- 14) AI 对话框里的字能选中、能复制 ---------- */
    const logEl = document.getElementById('ailog');
    const rowEl = document.querySelector('#ailog .airow');
    const taEl = document.getElementById('aitext');
    log(!!logEl && getComputedStyle(logEl).userSelect === 'text',
        'AI 对话框里的字可以选中（全站默认是 none，够不到这里就永远复制不了）',
        logEl ? getComputedStyle(logEl).userSelect : '(没有 #ailog)');
    log(!!rowEl && getComputedStyle(rowEl).userSelect === 'text', '每一行内容也能选中',
        rowEl ? getComputedStyle(rowEl).userSelect : '(面板里还没有行)');
    log(!!taEl && getComputedStyle(taEl).userSelect === 'text', '打字框里也能选中',
        taEl ? getComputedStyle(taEl).userSelect : '(没有 #aitext)');
    log(getComputedStyle(document.body).userSelect === 'none',
        '别处还是不可选中（拖视角不该拖出一片蓝）', getComputedStyle(document.body).userSelect);
    /* 选中一段文字后来一次重画：选中的东西不能被抹掉（以前 innerHTML 一换就没了） */
    const sel = window.getSelection();
    const rng = document.createRange();
    rng.selectNodeContents(rowEl);
    sel.removeAllRanges(); sel.addRange(rng);
    const picked = String(sel.toString());
    NF.aiSessionLoad(S().当前);        /* 内部会调 aiRender，正是会抹掉选择的那一下 */
    log(picked.length > 0 && String(sel.toString()) === picked,
        '选中文字时来一次重画，选中的东西还在（推迟到选择清掉之后再画）',
        picked.length + ' 字 -> ' + String(sel.toString()).length + ' 字');
    sel.removeAllRanges();
    const fails = out.filter(l => l.startsWith('FAIL')).length;
    done('NFSESS ' + (out.length - fails) + 'P/' + fails + 'F' + (fails ? ' BAD' : ''));
  } catch (e) {
    done('NFSESS ERR ' + String((e && e.stack) || e));
  }
})();
<\/script>
`;
fs.writeFileSync('prototype/_sesscheck.html', html.replace('</body>', TEST + '</body>'));
console.log('generated prototype/_sesscheck.html');
