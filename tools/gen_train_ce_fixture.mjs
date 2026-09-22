/* B11 / B12 的夹具：用**生产代码生成器**建两个小网（前馈 3 分类 / 循环 3 分类），
   连同生成的 .py 一起落盘，交给 tools/verify_train_ce.py 用真 PyTorch 跑训练。
   只读源码、只写给定的临时目录，不碰任何构建产物。
   每个夹具另外落一份 editor_weights.json：编辑器侧算出来的权重文档，用来跟 --export-weights 对账。

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
/* 算子节点这条路：analyzeGraph 要按算子之间的引用跑一遍拓扑序。这个函数只读 opList，自足。 */
include('function opTopoOrder(', 'function opDelete(');

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
  /* F09：编辑器那一侧的权重文档（结构指纹 + 稳定 ID + 数值）。verify_weights_roundtrip.py
     拿它跟生成脚本 --export-weights 导出的那一份逐字对：两边必须是同一张图、同一条边序。 */
  fs.writeFileSync(path.join(dir, 'editor_weights.json'),
                   JSON.stringify(ctx.weightsDocOf(m, { what: '夹具：编辑器侧导出的权重' })));
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

/* 权重块：块一出现就一定走 model.bin 那条路（权重从二进制里切，源码不带数值）。
   验 F09 的块权重导出：只有共享组的代表块存一份，bwoff 指向的那一段就是它。 */
setup(6, [0, 1], [4, 5], [],
      [{ id: 1, k: 2, n: 2, src: [0, 1], dst: [4, 5], w: [0.5, -1.25, 2.0, 0.75], sg: 0 }]);
const blk = emit('block_ce', { train: TRAIN });

/* 算子节点：参数张量在 model.bin 里，导出按 o<i>_p<k> 取回来。 */
setup(6, [0, 1], [4, 5], []);
ctx.opList = [{ id: 1, op: 'MatMul', name: 'mm1', ins: [{ k: 'n', ids: [0, 1], shape: [1, 2] }, { k: 'c', p: 'W', shape: [2, 2] }],
                outShape: [1, 2], land: Uint32Array.from([4, 5]), attrs: {}, fold: [],
                params: [{ name: 'W', dtype: 'f32', shape: [2, 2],
                           data: [1.0, 0.5, -0.25, 2.0], role: 'weight', same: '' }],
                note: '', color: 0, colOn: 0, pos: null, mesh: null, tex: null, texTag: '',
                cx: 0, cy: 0, cz: 0 }];
const opc = emit('op_ce', { train: TRAIN });

fs.writeFileSync(path.join(out, 'manifest.json'),
                 JSON.stringify({ feed: ff, rec: rc, state: st, block: blk, op: opc }, null, 1));
console.log(JSON.stringify({ feed: ff, rec: rc, state: st, block: blk, op: opc }));
