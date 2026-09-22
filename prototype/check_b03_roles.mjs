import fs from 'node:fs';

/* B03 回归：脚本接口的角色表必须完整、自洽，而且列进 read / flat 的接口，
   源码里不能出现「写工程数据」的动作。
   为什么要这道闸：名单里少写一格，模型的修改就撤不回来了（那是本项要修的原始缺陷）；
   多写一格只是白拍一次快照。所以两个方向都要盯着。 */
const source = fs.readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
const lines = source.split(/\r\n|\n/);
let fails = 0;
function check(name, fn) {
  try { fn(); console.log('PASS | ' + name); }
  catch (e) { fails++; console.log('FAIL | ' + name + ' :: ' + ((e && e.message) || e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* NF 对象字面量里每个顶层属性：顶格两个空格、以标识符开头的那一行 */
function nfProps() {
  const startLine = lines.findIndex((l) => l.includes('window.NF = {'));
  assert(startLine >= 0, '找不到 window.NF');
  const re = /^ {2}([A-Za-z_$][\w$]*)\s*[:(]/;
  const marks = [];
  for (let i = startLine + 1; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) marks.push({ name: m[1], line: i });
    if (lines[i] === '};' && i > startLine + 5) break;
  }
  const out = new Map();
  for (let k = 0; k < marks.length; k++) {
    const a = marks[k].line, b = k + 1 < marks.length ? marks[k + 1].line : a + 1;
    if (!out.has(marks[k].name)) out.set(marks[k].name, lines.slice(a, b).join('\n'));
  }
  return out;
}
function listOf(constName) {
  const i = lines.findIndex((l) => l.startsWith('const ' + constName + ' = ('));
  assert(i >= 0, '找不到 ' + constName);
  const parts = [];
  for (let j = i; j < lines.length; j++) {
    parts.push(lines[j]);
    if (lines[j].includes(".split(' ')")) break;
  }
  const text = parts.join('\n');
  const strs = text.match(/'[^']*'|"[^"]*"/g) || [];
  const all = strs.map((s) => s.slice(1, -1)).filter((s) => s.trim() !== '').join(' ');
  return all.split(/\s+/).filter(Boolean);
}

/* 「写工程数据」的判据：快照抓得住的那几列 / 那几个表的直接写入，以及明摆着的增删改调用 */
const WRITE_COL = /\b(nPos|nCol|nColOn|nThr|nAct|nBias|nLock|nIO|nHid|nPlast|nHard|nGroup|eSrc|eDst|eId|eLock|eHid|eW|selE|selN)\s*\[[^\]]*\]\s*(?:[+\-*/]?=(?!=)|((\+\+|--)\s*$))/m;
const WRITE_MISC = [
  /\bnName\s*\.\s*(set|delete)\s*\(/,
  /\bnName\s*\[[^\]]*\]\s*=/,
  /\bG\s*\.\s*(n|e|name|groups|gsets|dirty|source|pid|seed)\s*=(?!=)/,
  /\bPLAST\s*\.\s*list\s*(=|\.\s*(push|splice|shift|pop|unshift)\s*\()/,
  /\bPLAST\s*\.\s*list\s*\[[^\]]*\]\s*=(?!=)/,
  /\bblocks\s*\.\s*(push|splice|shift|pop|unshift)\s*\(/,
  /\bblocks\s*\.\s*length\s*=(?!=)/,
  /\bopList\s*\.\s*(push|splice|shift|pop|unshift)\s*\(/,
  /\bselBlocks\s*=(?!=)/,
  /\bselOps\s*=(?!=)/,
  /\bsnapshot\s*\(\s*\)/,
  /\b(addNeuron|deleteNeurons|addEdge|setColorBatch|rainbowColors|setIOBatch|setGroupBatch|groupAddBatch|groupRemoveBatch|groupCompact|setHiddenBatch|showAllHidden|placeBulk|placeNext|tuneWeights|pruneByWeight|pruneRandom|pruneUnused|pruneOrphans|distPrune|selectIds|selectNodesOnly|applyEdgeSelection|clearSelection|relayout|deserialize|nforge3Apply|streamOpenFromSource|streamLoadChunks|streamLoadAll|streamLoadBlocks|streamResetToSummary|groupEnsure|makeBlock|deleteBlocks|setBlockShare|unshareBlocks|packEdgesIntoBlock|expandBlockById|makeOp|opDelete|instantiateModule|moduleImportObj|histAdopt)\s*\(/,
];
function writesProject(body) {
  if (WRITE_COL.test(body)) return '数组元素赋值';
  for (const re of WRITE_MISC) if (re.test(body)) return re.source.slice(0, 40);
  return '';
}

const props = nfProps();
const MUT = listOf('AI_API_ROLE_MUT');
const FLAT = listOf('AI_API_ROLE_FLAT');
const EXT = listOf('AI_API_ROLE_EXT');
const READ = listOf('AI_API_ROLE_READ');

check('角色表里的四个名单都能读出来', () => {
  assert(props.size > 300, 'NF 属性只解析出 ' + props.size + ' 个，切法可能失效了');
  for (const [n, l] of [['MUT', MUT], ['FLAT', FLAT], ['EXT', EXT], ['READ', READ]]) {
    assert(l.length > 0, n + ' 是空的');
  }
  assert(READ.length > 150, 'READ 只有 ' + READ.length + ' 个，太少了');
});

check('四个名单两两不重名（重名会让角色随遍历顺序变）', () => {
  const seen = new Map();
  const dup = [];
  for (const [role, l] of [['mut', MUT], ['flat', FLAT], ['ext', EXT], ['read', READ]]) {
    for (const n of l) { if (seen.has(n)) dup.push(n + '(' + seen.get(n) + '/' + role + ')'); else seen.set(n, role); }
  }
  assert(dup.length === 0, '重名：' + dup.join('、'));
});

check('名单里每个名字都是真实存在的接口（防手滑写错名字）', () => {
  const bad = [];
  for (const [role, l] of [['mut', MUT], ['flat', FLAT], ['ext', EXT], ['read', READ]]) {
    for (const n of l) if (!props.has(n)) bad.push(role + ':' + n);
  }
  assert(bad.length === 0, '不存在的接口：' + bad.join('、'));
});

check('read / flat 名单里的接口，源码里不许出现写工程数据的动作', () => {
  const bad = [];
  for (const n of READ.concat(FLAT)) {
    const why = writesProject(props.get(n));
    if (why) bad.push(n + '（' + why + '）');
  }
  assert(bad.length === 0, '名单把它们当只读/非快照，但源码在写工程数据：' + bad.join('、'));
});

check('关键修改接口都在 mut 名单里（漏一个就是「改完撤不回来」）', () => {
  const must = ['setBias', 'setThr', 'setW', 'setPos', 'setName', 'addEdge', 'addNode', 'delNodes',
                'setGroup', 'groupAdd', 'groupRemove', 'addOp', 'delOps', 'setColor', 'setIO',
                'setPlast', 'setHidden', 'clear', 'loadBuffer', 'setAct', 'setLock', 'setEdgeLock'];
  const miss = must.filter((n) => MUT.indexOf(n) < 0);
  assert(miss.length === 0, '不在 mut 名单里：' + miss.join('、'));
});

check('碰外部世界的接口都挂在 ext 上', () => {
  const must = ['saveTo', 'exportFiles', 'exportArtifacts', 'wireMujoco', 'aiSend', 'aiCfgBoot', 'aiSaveCfg'];
  const miss = must.filter((n) => EXT.indexOf(n) < 0);
  assert(miss.length === 0, '不在 ext 名单里：' + miss.join('、'));
});

check('没列进表的接口按 mut 处理（默认必须是保守的那一边）', () => {
  const i = lines.findIndex((l) => l.includes("function aiApiRole(name)"));
  assert(i >= 0, '找不到 aiApiRole');
  assert(lines.slice(i, i + 3).join(' ').includes("AI_API_ROLE[name] || 'mut'"), '默认角色不是 mut 了');
  let unclassified = 0;
  for (const k of props.keys()) if ([MUT, FLAT, EXT, READ].every((l) => l.indexOf(k) < 0)) unclassified++;
  console.log('      （信息）没显式列角色、按 mut 兜底的接口：' + unclassified + ' / ' + props.size);
});

check('run_api 真的过了事务外壳，snapshot() 把那一格交了出来', () => {
  const i = lines.findIndex((l) => l.includes("name: 'run_api'"));
  assert(i >= 0, '找不到 run_api');
  const body = lines.slice(i, i + 20).join('\n');
  assert(body.includes('aiApiTx(aiApiRole(a.name)'), 'run_api 没有走 aiApiTx');
  const s = lines.findIndex((l) => l.startsWith('function snapshot() {'));
  assert(s >= 0, '找不到 snapshot');
  const sb = lines.slice(s, s + 16).join('\n');
  assert(/return s;/.test(sb), 'snapshot() 没有返回推上去的那一格');
});

check('list_api 会告诉模型每个接口能不能撤销', () => {
  const i = lines.findIndex((l) => l.includes("name: 'list_api'"));
  assert(i >= 0, '找不到 list_api');
  const body = lines.slice(i, i + 3).join('\n');
  assert(body.includes('aiRoleMark(k)'), 'list_api 没标角色');
  assert(body.includes('撤销撤不回'), 'list_api 的图例没说清楚');
});

console.log(fails ? ('B03 ROLE CHECKS: ' + fails + ' failed') : 'B03 ROLE CHECKS: all passed');
process.exit(fails ? 1 : 0);
