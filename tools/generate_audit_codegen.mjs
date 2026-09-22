/* Export tiny graphs through the production analyzer/IR/code generators.
 * No browser/build output is touched. The caller supplies a temporary directory.
 * UI-only state is stubbed; adjacency is built from the fixture edges/blocks.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2];
if (!out) throw new Error('usage: node tools/generate_audit_codegen.mjs OUTPUT_DIR [MAIN_JS]');
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

function setup(n, inputs, outputs, edges = [], blocks = []) {
  Object.assign(ctx, {
    G: { name: 'codegen regression', n, e: edges.length, groups: [] },
    nIO: Array.from({ length: n }, (_, i) => (inputs.includes(i) ? 1 : 0) | (outputs.includes(i) ? 2 : 0)),
    nAct: Array(n).fill(0), nBias: Array(n).fill(0), nLock: Array(n).fill(0),
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
function block(src, dst, weights, lock = null) {
  return { k: src.length, n: dst.length, src, dst, w: weights, lock };
}
const manifest = [];
function emit(name, options = {}) {
  const a = ctx.analyzeGraph();
  if (a.errors.length) throw new Error(name + ': ' + a.errors.join('; '));
  const m = ctx.buildModel();
  if (!m) throw new Error(name + ': buildModel failed');
  const dir = path.join(out, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hand_built_net.py'), ctx.generatePyTorch(m, { target: 'pytorch', ...options }));
  if (ctx.needsBin(m) || options.forceBin) fs.writeFileSync(path.join(dir, 'model.bin'), ctx.weightsBinBytes(m));
  manifest.push({ name, nodes: m.N, edges: m.E, blocks: m.blocks.length, recurrent: m.recurrent });
}

setup(2, [0], [1], [[0, 1, 2]]);
ctx.nPlast[0] = 1;
ctx.PLAST.list.push({ name: 'hebb', rule: 'hebb', lr: 0.1, tau: 20, wmin: -4, wmax: 4, decay: 0 });
emit('plastic');

setup(3, [0, 1], [2], [[0, 2, 2], [1, 2, 3]]);
ctx.nHard[0] = 1;
emit('hard_input');

// Two hard sources share a destination, with an intervening wave before it is evaluated.
setup(7, [0, 1], [5], [[0, 2, 1], [1, 3, 0], [1, 4, 1], [4, 6, 1], [6, 5, 5], [2, 5, 0], [3, 5, 0]]);
ctx.nHard[2] = ctx.nHard[3] = 1;
emit('hard_hidden');

setup(3, [0, 1], [2], [[0, 2, 0], [1, 2, 1]]);
ctx.nHard[0] = 1;
ctx.nAct[2] = 8;
emit('hard_state');

setup(2, [0], [1], [[1, 1, 0.5]], [block([0], [1], [2])]);
emit('recblock_only');
setup(2, [0], [1], [[0, 1, 1], [1, 1, 0.5]], [block([0], [1], [2])]);
emit('recblock_mixed');
setup(2, [0], [1], [[0, 1, 2], [1, 1, 0.5]]);
emit('recurrent_sparse');

setup(2, [0], [1], [], [block([0], [1], [2])]);
ctx.nBias[1] = 3;
ctx.nLock[1] = 1;
emit('frozen_biasbin');

setup(3, [0], [1, 2], [[0, 1, 2, 1], [0, 2, 4]]);
ctx.nBias = [0, 3, 5];
ctx.nLock[1] = 1;
emit('frozen_inline');
emit('frozen_bin', { forceBin: true });

setup(3, [0], [1, 2], [], [block([0], [1, 2], [2, 4], [1, 0])]);
ctx.nBias = [0, 3, 5];
ctx.nLock[1] = 1;
emit('frozen_block');

fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Exported ' + manifest.length + ' regression graphs to ' + out);
