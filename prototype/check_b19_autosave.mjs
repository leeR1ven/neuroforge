/* B19 回归：删掉本机自动保存之后，删除**之前**启动的那一轮保存不许把记录写回来。
   全离线：假的 IndexedDB（单事务串行，和真库一样）、可控的编码耗时，不碰用户的真实存档。 */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
let fails = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => console.log('PASS | ' + name),
    (e) => { fails++; console.log('FAIL | ' + name + ' :: ' + ((e && e.message) || e)); });
}
function block(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        /* async function 的 async 在 function 关键字前面，别把它切掉（切掉就变成在非 async 里用 await） */
        const head = source.slice(start - 6, start) === 'async ' ? start - 6 : start;
        return source.slice(head, i + 1);
      }
    }
  }
  throw new Error('unbalanced ' + name);
}
function autosaveLiteral() {
  const start = source.indexOf('const AUTOSAVE = {');
  assert.ok(start >= 0, 'missing AUTOSAVE');
  const end = source.indexOf('\n};', start);
  return source.slice(start, end + 3);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const store = new Map();
  const box = {
    AUTOSAVE_OPTS: {},
    setTimeout, clearTimeout, Date, Promise, JSON, Math, String, Number,
    store,
    fmtBytes: (n) => n + 'B',
    posFlushNow() {},
    streamSaveBlocked: () => false,
    S: {}, AI: {}, G: { n: 3, name: 'reg', seed: 1 },
    document: { getElementById: () => null },
    console,
  };
  /* 真库同一时刻只跑一个事务；这里也串行，并留一个可调的写库耗时。
     串行是关键：删除的事务排在在途写入的后面，最终结果必须是被删掉。 */
  let queue = Promise.resolve();
  box.idbOp = (mode, fn) => {
    const run = queue.then(async () => {
      await sleep(box.writes || 0);
      const st = {
        put: (v, k) => { store.set(k, v); return { result: k }; },
        get: (k) => ({ result: store.get(k) }),
        delete: (k) => { store.delete(k); return { result: true }; },
      };
      const rq = fn(st);
      return rq && rq.result;
    });
    queue = run.catch(() => {});
    return run;
  };
  box.encodes = [];
  box.encodeGate = null;
  box.nforge3Encode = () => {
    if (!box.encodeGate) return Promise.resolve(new Uint8Array([1, 2, 3]));
    return new Promise((res) => { box.encodes.push(res); });
  };
  const ctx = vm.createContext(box);
  vm.runInContext(autosaveLiteral() + '\n' + block('autosaveRun') + '\n' + block('autosaveForget') +
    '\nvar RUN = autosaveRun, FORGET = autosaveForget, OBJ = AUTOSAVE;', ctx);
  box.run = (force) => vm.runInContext('RUN', ctx)(force);
  box.forget = () => vm.runInContext('FORGET', ctx)();
  box.obj = vm.runInContext('OBJ', ctx);
  return box;
}

await check('正常一轮自动保存：记录真的写进去了', async () => {
  const b = harness();
  const r = await b.run(true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(b.store.get('last'), '没有记录');
});

await check('编码进行中删掉：编码完那一轮不许把记录写回来', async () => {
  const b = harness();
  const gate = b.encodeGate = true;
  const p = b.run(true);                       /* 卡在编码里 */
  await sleep(5);
  assert.ok(b.obj.busy, '这一轮应该正在写');
  assert.equal(await b.forget(), true, '删除失败');
  assert.equal(b.store.has('last'), false, '删除后记录还在');
  b.encodes.shift()(new Uint8Array([9, 9, 9]));  /* 编码这才完成 */
  const r = await p;
  await sleep(10);
  assert.equal(b.store.has('last'), false, '在途的那一轮把删掉的记录复活了');
  assert.equal(r.stale, true, '应当明确报「过期放弃」，而不是假装存成功');
  assert.equal(b.obj.savedRev, -1, '删除后不该留下「已保存」状态');
});

await check('写库进行中删掉：最终结果是被删掉（真库也是这个顺序）', async () => {
  const b = harness();
  b.writes = 40;                               /* 写库慢一点，好在这中间删 */
  const p = b.run(true);
  await sleep(10);
  assert.equal(await b.forget(), true);
  await p;
  await sleep(60);
  assert.equal(b.store.has('last'), false, '在途写入把删掉的记录复活了');
});

await check('删除之后的新编辑照样能存（不是把自动保存关了）', async () => {
  const b = harness();
  await b.run(true);
  await b.forget();
  assert.equal(b.store.has('last'), false);
  const r = await b.run(true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(b.store.get('last'), '删除之后新的一轮没存上');
});

await check('删除会撤掉已排队的那一轮（不再自动续跑）', async () => {
  const b = harness();
  let fired = false;
  b.obj.timer = setTimeout(() => { fired = true; }, 60);
  b.obj.later = true;
  await b.forget();
  assert.equal(b.obj.timer, 0, '排队的定时器没撤掉');
  assert.equal(b.obj.later, false, 'later 没清，后面还会自己续跑一轮');
  await sleep(120);
  assert.equal(fired, false, '撤掉的定时器还是跑了');
});

await check('世代号只在删除时前进（普通保存不会误伤）', async () => {
  const b = harness();
  const g0 = b.obj.gen;
  await b.run(true);
  assert.equal(b.obj.gen, g0, '普通保存不该动世代号');
  await b.forget();
  assert.equal(b.obj.gen, g0 + 1, '删除要推进世代号');
});

console.log(fails ? '\nB19 AUTOSAVE CHECKS: ' + fails + ' 项失败' : 'B19 AUTOSAVE CHECKS: all passed');
process.exit(fails ? 1 : 0);
