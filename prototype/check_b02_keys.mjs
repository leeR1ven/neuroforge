/* B02 回归：备份补 Key 必须绑定服务地址。
   全离线：假 localStorage / 假配置，不读用户设置、不发请求。 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
let fails = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS | ' + name); }
  catch (e) { fails++; console.log('FAIL | ' + name + ' :: ' + ((e && e.message) || e)); }
}
function block(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}

function harness() {
  const store = new Map();
  const box = {
    AI: { key: '', visKey: '', base: '', visBase: '', model: 'm', msgs: [], cfgAt: 0, keyLen: 0 },
    AI_STORE: 'nf.ai', AI_BAK: 'nf.ai.bak',
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    SHELL_INVOKE: null,
    aiMsgsSysSync() {}, aiModelListRender() {},
    aiAdoptCfg() { return false; },
  };
  box.aiCfgJson = () => ({ key: box.AI.key, base: box.AI.base, model: box.AI.model,
    visBase: box.AI.visBase, visModel: '', visKey: box.AI.visKey, at: box.AI.cfgAt });
  const ctx = vm.createContext(box);
  vm.runInContext(block('aiSvcOf') + '\n' + block('aiSvcSame') + '\n' + block('aiSaveCfg') +
    '\nvar SAVE = aiSaveCfg; var SVC = aiSvcSame;', ctx);
  box.store = store;
  return box;
}

await check('aiSvcOf normalises provider addresses', () => {
  const b = harness();
  const f = vm.runInContext('aiSvcOf', vm.createContext(b));
  assert.equal(f('https://API.DeepSeek.com/v1/chat/completions'), 'https://api.deepseek.com/v1');
  assert.equal(f(' https://api.deepseek.com/v1/// '), 'https://api.deepseek.com/v1');
  assert.equal(f(''), '');
});

await check('a key from provider A never lands on provider B', () => {
  const b = harness();
  b.store.set('nf.ai.bak', JSON.stringify({ key: 'FAKE-PROVIDER-A-KEY', base: 'https://a.invalid/v1' }));
  b.AI.base = 'https://b.invalid/v1'; b.AI.key = '';
  vm.runInContext('SAVE(false)', vm.createContext(b));
  assert.equal(b.AI.key, '', 'A 的 Key 被填进 B 了');
});

await check('a key is restored for the same provider (tail differences forgiven)', () => {
  const b = harness();
  b.store.set('nf.ai.bak', JSON.stringify({ key: 'FAKE-A-KEY', base: 'https://a.invalid/v1/chat/completions' }));
  b.AI.base = 'https://a.invalid/v1'; b.AI.key = '';
  vm.runInContext('SAVE(false)', vm.createContext(b));
  assert.equal(b.AI.key, 'FAKE-A-KEY');
});

await check('vision keys pair with visBase, falling back to base', () => {
  const b = harness();
  b.store.set('nf.ai.bak', JSON.stringify({ key: '', base: 'https://a.invalid/v1', visKey: 'FAKE-VIS', visBase: '' }));
  b.AI.base = 'https://a.invalid/v1'; b.AI.visBase = ''; b.AI.visKey = '';
  vm.runInContext('SAVE(false)', vm.createContext(b));
  assert.equal(b.AI.visKey, 'FAKE-VIS');
  const b2 = harness();
  b2.store.set('nf.ai.bak', JSON.stringify({ key: '', base: 'https://a.invalid/v1', visKey: 'FAKE-VIS', visBase: '' }));
  b2.AI.base = 'https://b.invalid/v1'; b2.AI.visBase = ''; b2.AI.visKey = '';
  vm.runInContext('SAVE(false)', vm.createContext(b2));
  assert.equal(b2.AI.visKey, '', '视觉 Key 跨服务被填上了');
});

await check('an explicit clear stays cleared and is not revived by the backup', () => {
  const b = harness();
  b.store.set('nf.ai.bak', JSON.stringify({ key: 'FAKE-A-KEY', base: 'https://a.invalid/v1' }));
  b.AI.base = 'https://a.invalid/v1'; b.AI.key = '';
  vm.runInContext('SAVE(true)', vm.createContext(b));
  assert.equal(b.AI.key, '');
  const bak = JSON.parse(b.store.get('nf.ai.bak'));
  assert.equal(bak.key, '', '明确清空后备份里还留着 Key');
  vm.runInContext('SAVE(false)', vm.createContext(b));
  assert.equal(b.AI.key, '', '旧的 Key 又从备份里复活了');
});

await check('boot merge and the Rust writer use the same address rule', () => {
  const boot = source.slice(source.indexOf('async function aiCfgBoot()'));
  const bootBody = boot.slice(0, boot.indexOf('\n}\n'));
  assert.ok(bootBody.includes('aiSvcSame(sBase, fBase)'), 'aiCfgBoot 补 Key 没比对地址');
  const rs = fs.readFileSync(new URL('../desktop/src-tauri/src/sys_exec.rs', import.meta.url), 'utf8');
  assert.ok(rs.includes('fn svc_of(') && rs.includes('fn svc_same('), 'Rust 没有 svc_of/svc_same');
  assert.ok(rs.includes('if !svc_same(&cfg_svc_of(src, f), &want_base) { continue; }'), 'Rust 补 Key 没比对地址');
});

console.log(fails ? ('B02 KEY CHECKS: ' + fails + ' failed') : 'B02 KEY CHECKS: all passed');
if (fails) process.exit(1);
