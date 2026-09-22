/* B01 回归：模型不能给自己发本机权限。
   全部离线：假 NF 对象、假 SHELL_INVOKE，不碰真配置、不发请求。 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
const lines = source.split(/\r\n|\n/);
let fails = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS | ' + name); }
  catch (e) { fails++; console.log('FAIL | ' + name + ' :: ' + ((e && e.message) || e)); }
}

/* ---- 1. 静态：aiConfig 不再写这两道门 ---- */
await check('aiConfig no longer assigns sysFs/sysRun', () => {
  const bad = lines.filter((l) => /AI\.sysFs\s*=/.test(l) && /aiConfig|o\.sysFs/.test(l));
  assert.equal(bad.length, 0, 'aiConfig 里还有写 AI.sysFs 的句子: ' + bad.join(' || '));
  assert.ok(lines.some((l) => l.includes('if (o.sysFs !== undefined || o.sysRun !== undefined) sysAskUserOnly = true;')),
    'aiConfig 里应当记下「有人想从这条路开权限」');
});

await check('the only sys flag writers are the UI handler and aiUserSetSys', () => {
  const writers = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/AI\.sys(Fs|Run)\s*=[^=]/.test(l)) continue;
    writers.push({ i: i + 1, l: l.trim() });
  }
  const allowed = writers.filter((w) =>
    w.l.includes('AI.sysFs = !!on') || w.l.includes('AI.sysRun = !!on') ||
    w.l.includes('AI.sysFs = got.fs') || w.l.includes('AI.sysRun = got.run') ||
    w.l.includes('AI.sysFs = false; AI.sysRun = false;') ||
    w.l.includes('sysFs: false, sysRun: false,'));
  assert.equal(allowed.length, writers.length,
    '还有别处在直接写这两道门：' + JSON.stringify(writers.filter((w) => !allowed.includes(w))));
  assert.ok(lines.some((l) => l.includes('function aiUserSetSys(kind, on)')), 'aiUserSetSys 不见了');
});

await check('list_api / run_api both honour the block list', () => {
  const listL = lines.find((l) => l.includes('run: () => nfKeys()'));
  assert.ok(listL && listL.includes('AI_API_BLOCK'), 'list_api 没过滤禁区名单');
  assert.ok(lines.some((l) => l.includes("if (AI_API_BLOCK[a.name]) throw new Error(")), 'run_api 没检查禁区名单');
  assert.ok(lines.some((l) => l.includes("if (a.name === 'aiConfig') {")), 'run_api 没单独看 aiConfig');
});

/* ---- 2. 运行时：把真的 aiConfig 抽出来，在沙箱里调一次 ---- */
function extractProperty(key) {
  const start = source.indexOf('\n  ' + key + ': (o) => {');
  assert.ok(start >= 0, '找不到属性 ' + key);
  const endMark = 'local: aiLocalNow() }; },';
  const end = source.indexOf(endMark, start);
  assert.ok(end > start, '找不到属性 ' + key + ' 的结尾');
  return source.slice(start + 1, end + endMark.length);
}

await check('model-supplied sysFs/sysRun are refused, real values reported', () => {
  const propSrc = extractProperty('aiConfig');
  const box = {
    AI: { key: '', base: 'https://a.invalid/v1', model: 'm', extra: '', autoRun: false, noAsk: false,
          stream: false, slim: 'auto', toolMode: 'auto', temp: 0.7, maxTok: 1024,
          visBase: '', visModel: '', visKey: '', sysFs: false, sysRun: false, keyLen: 0 },
    syncs: 0,
    aiSysSync() { box.syncs++; return Promise.resolve(null); },
    aiSaveCfg() {}, aiFillCfg() {}, aiKeyNote() {}, aiSlimOn() { return true; }, aiLocalNow() { return false; },
  };
  const ctx = vm.createContext(box);
  vm.runInContext('let sysAskUserOnly = false;\nconst NFOBJ = { ' + propSrc + ' };', ctx);
  const r = vm.runInContext("NFOBJ.aiConfig({ sysFs: true, sysRun: true, model: 'm2' })", ctx);
  assert.equal(box.AI.sysFs, false, 'sysFs 被模型打开了');
  assert.equal(box.AI.sysRun, false, 'sysRun 被模型打开了');
  assert.equal(r.sysFs, false);
  assert.equal(r.sysRun, false);
  assert.equal(box.AI.model, 'm2', '正常字段应当照常生效');
  assert.equal(vm.runInContext('sysAskUserOnly', ctx), true, '应当记下「有人从这条路要权限」');
  assert.equal(box.syncs, 0, 'aiConfig 不该再去同步那道门');
});

await check('browser build (no shell) cannot reach the dialog path', () => {
  const fn = source.slice(source.indexOf('function aiUserSetSys(kind, on) {'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  const box = { AI: { sysFs: false, sysRun: false }, SHELL_INVOKE: null,
                aiSysSync() { return Promise.resolve(null); }, aiSysNote() {}, aiInfo() {}, aiFillCfg() {},
                aiSysState() { return { ready: false, fs: box.AI.sysFs, run: box.AI.sysRun }; } };
  const ctx = vm.createContext(box);
  vm.runInContext(body + '\nvar S = aiUserSetSys;', ctx);
  return vm.runInContext("S('fs', true)", ctx).then((s) => {
    assert.equal(s.fs, false, '无壳时不该开出任何权限');
    assert.equal(box.AI.sysFs, false);
  });
});

console.log(fails ? ('B01 PERM CHECKS: ' + fails + ' failed') : 'B01 PERM CHECKS: all passed');
if (fails) process.exit(1);
