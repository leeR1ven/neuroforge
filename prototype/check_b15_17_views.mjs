/* B15 / B17 回归：视角书签的坐标必须严格校验，且不能把标签拼进 HTML。
   全离线：假 localStorage / 假相机，不动用户视角、不读用户存储。 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
let fails = 0;
function check(name, fn) {
  try { fn(); console.log('PASS | ' + name); }
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
function harness(stored) {
  const store = new Map();
  if (stored !== undefined) store.set('nf.views', stored);
  const toasts = [];
  const cam = { pos: { x: 1, y: 2, z: 3 }, tgt: { x: 4, y: 5, z: 6 } };
  const box = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    toast: (m, k) => toasts.push(String(m)),
    requestRender() {},
    camera: { position: { x: 1, y: 2, z: 3, set(a, b, c) { cam.pos = { x: a, y: b, z: c }; this.x = a; this.y = b; this.z = c; } } },
    controls: { target: { x: 4, y: 5, z: 6, set(a, b, c) { cam.tgt = { x: a, y: b, z: c }; this.x = a; this.y = b; this.z = c; } }, update() {} },
  };
  box.cam = cam; box.toasts = toasts; box.store = store;
  const ctx = vm.createContext(box);
  vm.runInContext("const VIEW_LS = 'nf.views';\nconst VIEWS = { list: [] };\n" +
    block('viewNum') + '\n' + block('viewNorm') + '\n' + block('viewsLoad') + '\n' +
    block('viewsPersist') + '\n' + block('viewGoto') + '\n' +
    'var VIEWSOBJ = VIEWS; var LOAD = viewsLoad; var GOTO = viewGoto;', ctx);
  return box;
}

check('a bookmark missing any of the six coordinates is rejected', () => {
  const b = harness();
  const norm = vm.runInContext('viewNorm', vm.createContext(b));
  assert.equal(norm({ name: 'bad', px: 0, tx: 0 }), null, '缺 4 个坐标却过关了');
  assert.equal(norm({ px: 1, py: 2, pz: 3, tx: 4, ty: 5 }), null, '缺 tz 却过关了');
  assert.equal(norm({ px: 1, py: 2, pz: 3, tx: 4, ty: 5, tz: 6 }).tz, 6);
  assert.equal(norm({ px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 }).px, 0, '合法 0 不该被拒');
  assert.equal(norm({ px: -3, py: 0, pz: 1, tx: 0.5, ty: -0.5, tz: 2 }).py, 0);
});

check('non-numeric / non-finite coordinates never become HTML', () => {
  const b = harness();
  const norm = vm.runInContext('viewNorm', vm.createContext(b));
  const tag = '<mark>AUDIT</mark>';
  assert.equal(norm({ px: 1, py: tag, pz: 3, tx: 0, ty: 0, tz: 0 }), null, '标签被当数字收了');
  assert.equal(norm({ px: 1, py: '2', pz: 3, tx: 0, ty: 0, tz: 0 }), null, '字符串数字被收了');
  assert.equal(norm({ px: 1, py: null, pz: 3, tx: 0, ty: 0, tz: 0 }), null, 'null 被收了');
  assert.equal(norm({ px: 1, py: [2], pz: 3, tx: 0, ty: 0, tz: 0 }), null, '数组被收了');
  assert.equal(norm({ px: Infinity, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 }), null, 'Infinity 被收了');
  assert.equal(norm({ px: NaN, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 }), null, 'NaN 被收了');
});

check('loading a poisoned store drops the bad rows but keeps the good ones', () => {
  const b = harness(JSON.stringify([
    { name: 'ok', px: 1, py: 2, pz: 3, tx: 4, ty: 5, tz: 6 },
    { name: 'bad', px: 0, tx: 0 },
    { name: 'tag', px: 1, py: '<mark>AUDIT</mark>', pz: 3, tx: 0, ty: 0, tz: 0 },
  ]));
  vm.runInContext('LOAD()', vm.createContext(b));
  const list = vm.runInContext('VIEWSOBJ.list', vm.createContext(b));
  assert.equal(list.length, 1, '应该只剩 1 条合法书签，实际 ' + list.length);
  assert.equal(list[0].name, 'ok');
});

check('jumping to a broken bookmark leaves the camera alone', () => {
  const b = harness();
  const r = vm.runInContext("GOTO({ name: 'bad', px: 0, tx: 0 })", vm.createContext(b));
  assert.equal(r, false);
  assert.deepEqual(b.cam.pos, { x: 1, y: 2, z: 3 }, '相机被动了');
  assert.deepEqual(b.cam.tgt, { x: 4, y: 5, z: 6 }, '注视点被动了');
  assert.ok(b.toasts.length === 1, '应该提示一句');
});

check('a legal bookmark still jumps', () => {
  const b = harness();
  const r = vm.runInContext("GOTO({ name: 'ok', px: 7, py: 8, pz: 9, tx: 1, ty: 2, tz: 3 })", vm.createContext(b));
  assert.equal(r, true);
  assert.deepEqual(b.cam.pos, { x: 7, y: 8, z: 9 });
  assert.deepEqual(b.cam.tgt, { x: 1, y: 2, z: 3 });
});

check('the panel escapes every rendered coordinate', () => {
  const panel = source.slice(source.indexOf('function openViewPanel()'));
  const body = panel.slice(0, panel.indexOf('\nfunction '));
  assert.ok(!/\+ v\.p[xyz] \+/.test(body), '位置还在直接拼 v.px/v.py/v.pz');
  assert.ok(!/\+ v\.t[xyz] \+/.test(body), '看向还在直接拼 v.tx/v.ty/v.tz');
  assert.ok(body.includes('esc(String(v.px)'), '位置没有转义');
  assert.ok(body.includes('esc(String(v.tx)'), '看向没有转义');
});

console.log(fails ? ('B15/B17 VIEW CHECKS: ' + fails + ' failed') : 'B15/B17 VIEW CHECKS: all passed');
if (fails) process.exit(1);
