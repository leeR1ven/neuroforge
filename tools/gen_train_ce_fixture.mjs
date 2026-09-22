/* B11 / B12 的夹具：用**生产代码生成器**建两个小网（前馈 3 分类 / 循环 3 分类），
   连同生成的 .py 一起落盘，交给 tools/verify_train_ce.py 用真 PyTorch 跑训练。
   只读源码、只写给定的临时目录，不碰任何构建产物。

   用法：node tools/gen_train_ce_fixture.mjs OUTPUT_DIR [MAIN_JS]
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2];
if (!out) throw new Error('usage: node tools/gen_train_ce_fixture.mjs OUTPUT_DIR [MAIN_JS]');
const source = fs.readFileSync(process.argv[3] || path.join(root, 'prototype/src/main.js'), 'utf8');
const ctx = {
  ACT_STATE_FROM: 8, IO_IN: 1, IO_OUT: 2, CAP_HARD_N: 16777216,
  fmt: String,
  PLAST_RULE_ID: { none: 0, hebb: 1, stdp: 2, anti: 3, decay: 4, stdpd: 5 },
  adjEnsure() {}, streamSaveBlocked: () => false,
  hiddenCount: () => ({ nodes: 0, edges: 0 }),
};
vm.createContext(ctx);
function include(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('generator source boundary missing: ' + from);
  vm.runInContext(source.slice(a, b), ctx, { filename: 'main.js:' + from });
}
include('function computeLayers(', 'function cFloat(');
include('function frozenIndexPlan(', 'function buildWeightsBin(');
include('function blockWeightCount(', 'function blockRepIndex(');

function setup(n, inputs, outputs, edges = [], blocks = [], acts = null) {
  Object.assign(ctx, {
    G: { name: 'train ce fixture', n, e: edges.length, groups: [] },
    nIO: Array.from({ length: n }, (_, i) => (inputs.includes(i) ? 1 : 0) | (outputs.includes(i) ? 2 : 0)),
    nAct: Array.from({ length: n }, (_, i) => (acts && acts[i]) | 0), nBias: Array(n).fill(0), nLock: Array(n).fill(0),
    nPlast: Array(n).fill(0), nHard: Array(n).fill(0),
    eSrc: edges.map(e => e[0]), eDst: edges.map(e => e[1]),
    eW: edges.map(e => e[2]), eLock: edges.map(e => e[3] || 0),
    blocks, opList: [],
    PLAST: { list: [{ name: 'none', rule: 'none', lr: 0, tau: 20, wmin: -4, wmax: 4, decay: 0 }] },
  });
  const adj = Array.from({ length: n }, () => []), rows = Array.from({ length: n }, () => []);
  edges.forEach(([s, d], i) => {
    adj[s].push(i);
    if (s !== d) adj[d].push(i);
  });
  blocks.forEach((b, i) => b.src.forEach(s => rows[s].push(i)));
  function csr(lists) {
    const start = [0];
    lists.forEach(a => start.push(start.at(-1) + a.length));
    return [start, lists.flat()];
  }
  [ctx.adjStart, ctx.adjList] = csr(adj);
  [ctx.bRowStart, ctx.bRowList] = csr(rows);
}
function emit(name, options = {}) {
  const a = ctx.analyzeGraph();
  if (a.errors.length) throw new Error(name + ': ' + a.errors.join('; '));
  const m = ctx.buildModel();
  if (!m) throw new Error(name + ': buildModel failed');
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hand_built_net.py'),
                   ctx.generatePyTorch(m, { target: 'pytorch', ...options }));
  if (ctx.needsBin(m) || options.forceBin) {
    fs.writeFileSync(path.join(dir, 'model.bin'), ctx.weightsBinBytes(m));
  }
  return { name, nodes: m.N, edges: m.E, recurrent: !!m.recurrent,
           inputs: m.inputNodes.length, outputs: m.outputNodes.length };
}

const TRAIN = { optimizer: 'adam', lr: 0.05, weight_decay: 0, loss: 'ce',
                epochs: 120, batch_size: 6, data: 'unused.npz', device: 'cpu', seed: 7 };

/* 前馈 3 分类：4 个输入 → 3 个输出 */
setup(7, [0, 1, 2, 3], [4, 5, 6],
      [[0, 4, 1.1], [1, 4, 0.7], [1, 5, 1.3], [2, 5, 0.9], [2, 6, 1.2], [3, 6, 0.8], [3, 4, -0.6]]);
const ff = emit('feed_ce', { train: TRAIN });

/* 循环 3 分类：2 个输入 → 3 个输出，输出层里有一对回边（4 ↔ 5） */
setup(6, [0, 1], [3, 4, 5],
      [[0, 3, 1.0], [1, 4, 1.0], [3, 4, 0.6], [4, 5, 0.9], [5, 4, 0.7], [4, 3, 0.5]]);
const rc = emit('rec_ce', { train: Object.assign({}, TRAIN, { batch_size: 3 }) });

/* 有「记忆」神经元（激活类型 8）的前馈图：状态存在 self.st 里，跨 forward 调用保留。
   用来验证 B09 —— reset_state() 能真的把它清掉，训练骨架按 state 策略复位。 */
setup(4, [0, 1], [3],
      [[0, 2, 1.0], [1, 3, 1.0], [2, 3, 1.0]], [], [0, 0, 8, 0]);
const st = emit('state_ce', { train: TRAIN });

fs.writeFileSync(path.join(out, 'manifest.json'),
                 JSON.stringify({ feed: ff, rec: rc, state: st }, null, 1));
console.log(JSON.stringify({ feed: ff, rec: rc, state: st }));
