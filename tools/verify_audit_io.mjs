/* 2026-09-22：原始前端编解码与桌面命令参数的回归。Rust 分帧/真实 TCP 回环另由 cargo test 检验。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../prototype/src/main.js', import.meta.url), 'utf8');
function extract(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing function: ' + name);
  // 这些函数都在顶层；下一处顶层 function 即边界，不重写被测实现。
  const next = source.slice(start + 1).search(/^function /m);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}
const calls = [];
let configured = null;
const ctx = vm.createContext({
  DataView, Uint8Array, Float32Array, Int16Array, TextDecoder, TextEncoder,
  renderIfacePanel() {}, renderIfaceLog() {}, ifaceLogPush() {},
  ifaceRearm() {}, ifaceChanById: (id) => configured?.id === id ? configured : null,
  setTimeout,
  SHELL_INVOKE: (command, args) => { calls.push({command, args}); return Promise.resolve('ok'); },
});
for (const name of ['ifaceParseSlots', 'ifaceDecode', 'ifaceNativeFrameBytes', 'ifaceChanSetFormat', 'ifaceChanConfigure', 'ifaceChanOpen', 'ifaceChanClose']) {
  vm.runInContext(extract(name), ctx);
}
let passed = 0;
async function check(name, test) {
  await test();
  passed++;
  console.log('PASS | ' + name);
}
await check('f32 TCP 多信号位按 4 字节/值传给原生层；i16 按 2 字节/值', async () => {
  for (const xp of ['tcp', 'tcpc', 'serial']) {
    for (const codec of ['f32', 'i16']) {
      const c = {id: 7, xp, codec, slots:'12, 13*2, 20*0.5+0.1', dir:'in', open:false};
      assert.equal(ctx.ifaceChanOpen(c, true), true);
      await c.nativePending;
      const call = calls.at(-1);
      assert.equal(call.command, 'nf_io_open');
      assert.equal(call.args.frameBytes, codec === 'f32' ? 12 : 6);
      assert.equal(c.open, true);
    }
  }
});
await check('无信号位的二进制流拒绝打开，避免无法确定帧长', () => {
  const before = calls.length;
  const c = {id:7, xp:'tcp', codec:'f32', slots:'', dir:'in', open:false};
  assert.equal(ctx.ifaceChanOpen(c, true), false);
  assert.match(c.err, /信号位/);
  assert.equal(calls.length, before);
});
await check('UDP 和文本流保持原有帧协议', () => {
  assert.equal(ctx.ifaceNativeFrameBytes({xp:'udp', codec:'f32', slots:''}), 0);
  assert.equal(ctx.ifaceNativeFrameBytes({xp:'tcp', codec:'json', slots:''}), 0);
});
await check('正常二进制帧保留 0x0A 数值，不丢信号位', () => {
  const bytes = new Uint8Array(new Float32Array([1, 0.54]).buffer);
  assert.ok(bytes.includes(10));
  const out = ctx.ifaceDecode({codec:'f32'}, bytes);
  assert.equal(out.vals.length, 2);
  assert.equal(out.vals[0], 1);
  assert.ok(Math.abs(out.vals[1] - 0.54) < 1e-6);
});
await check('不完整二进制帧报错，不能静默忽略尾字节', () => {
  assert.match(ctx.ifaceDecode({codec:'f32'}, new Uint8Array(3)).error, /不完整/);
  assert.match(ctx.ifaceDecode({codec:'i16'}, new Uint8Array(3)).error, /不完整/);
});
await check('更改编码/信号位关闭旧连接，重新打开时使用新帧长', async () => {
  const c = {id:7, xp:'tcpc', codec:'f32', slots:'0', dir:'in', open:true};
  ctx.ifaceChanSetFormat(c, 'slots', '0,1');
  assert.equal(c.open, false);
  await c.nativePending;
  assert.equal(calls.at(-1).command, 'nf_io_close');
  ctx.ifaceChanOpen(c, true);
  await c.nativePending;
  assert.equal(calls.at(-1).args.frameBytes, 8);
  ctx.ifaceChanSetFormat(c, 'codec', 'i16');
  assert.equal(c.open, false);
  ctx.ifaceChanOpen(c, true);
  await c.nativePending;
  assert.equal(calls.at(-1).args.frameBytes, 4);
});
await check('脚本 API 改信号位同样关闭旧流，随后打开使用新帧长', async () => {
  configured = {id:7, xp:'tcp', codec:'f32', slots:'0', dir:'in', open:true};
  assert.equal(ctx.ifaceChanConfigure(7, {slots:'0,1'}), true);
  assert.equal(configured.open, false);
  await configured.nativePending;
  assert.equal(calls.at(-1).command, 'nf_io_close');
  ctx.ifaceChanOpen(configured, true);
  await configured.nativePending;
  assert.equal(calls.at(-1).args.frameBytes, 8);
});
await check('打开尚未完成时修改帧长，旧连接清理完才打开新连接', async () => {
  const invoke = ctx.SHELL_INVOKE;
  let finish;
  const events = [];
  ctx.SHELL_INVOKE = (command, args) => {
    events.push({command, args});
    if (events.length === 1) return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve('ok');
  };
  try {
    const c = {id:7, xp:'tcp', codec:'f32', slots:'0', dir:'in', open:false};
    ctx.ifaceChanOpen(c, true);
    for (let i = 0; i < 5 && !finish; i++) await Promise.resolve();
    assert.equal(c.opening, true);
    assert.equal(events[0].args.frameBytes, 4);
    ctx.ifaceChanSetFormat(c, 'slots', '0,1');
    assert.equal(c.open, false);
    ctx.ifaceChanOpen(c, true);
    finish('opened old format');
    await c.nativePending;
    assert.deepEqual(events.map((x) => x.command), ['nf_io_open', 'nf_io_close', 'nf_io_open']);
    assert.equal(events[2].args.frameBytes, 8);
    assert.equal(c.open, true);
    assert.equal(c.opening, false);
  } finally { ctx.SHELL_INVOKE = invoke; }
});
console.log(`== ${passed} PASS / 0 FAIL ==`);
