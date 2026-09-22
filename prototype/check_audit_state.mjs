/* Run the state algorithms from current source without building HTML or writing
   browser storage. Only rendering/UI effects are stubbed; state, history,
   module-copy and stream decoding functions are the production implementations. */
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

const source = fs.readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, 'missing production function ' + name);
  const lineEnd = source.indexOf('\n', match.index);
  const firstLine = source.slice(match.index, lineEnd).trimEnd();
  if (firstLine.endsWith('}')) return firstLine;
  const end = source.indexOf('\n}', lineEnd);
  assert.ok(end > lineEnd, 'missing function end ' + name);
  return source.slice(match.index, end + 2);
}
function install(c, names) {
  vm.runInContext(names.map(functionSource).join('\n'), c);
}
function context(cap = 64) {
  const c = {
    console, Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array,
    DataView, Map, Set, TextEncoder, TextDecoder, performance, setTimeout,
    G: { n: 0, e: 0, name: 'test', groups: [], gsets: [] },
    nName: new Map(), edgeSeq: 1, adjCount: 0, adjStart: new Uint32Array(cap + 1),
    DEF_THR: 0.5, CAP_HARD_N: cap, CAP_HARD_E: cap,
    IO_NONE: 0, IO_IN: 1, IO_OUT: 2,
    PLAST_NONE: { name: '固定（不学习）', rule: 'none', lr: 0, tau: 20, wmin: -4, wmax: 4, decay: 0 },
    PLAST_RULE_ID: { none: 0, hebb: 1, stdp: 2, anti: 3, decay: 4, stdpd: 5 },
    plastVer: 0, blocks: [], opList: [], selBlocks: new Set(), selOps: new Set(),
    MODLIB: { list: [] }, PLACE: { x: 0, y: 0, z: 0, axis: 0, step: 1 }, AXV_KEY: ['x', 'y', 'z'],
    histLockDirty: 1, histHidDirty: 1, histSelDirty: 1, histWDirty: 1, histTopoDirty: 1,
  };
  for (const name of ['nPos', 'nCol']) c[name] = new Float32Array(cap * 3);
  for (const name of ['nBias', 'nThr', 'eW']) c[name] = new Float32Array(cap);
  for (const name of ['nAct', 'nIO', 'nLock', 'nColOn', 'nHid', 'nPlast', 'nHard', 'selN', 'selE', 'eLock', 'eHid']) c[name] = new Uint8Array(cap);
  for (const name of ['eSrc', 'eDst', 'eId']) c[name] = new Uint32Array(cap);
  c.nGroup = new Uint16Array(cap);
  c.PLAST = { list: [{ ...c.PLAST_NONE }] };
  c.messages = [];
  c.toast = (message) => c.messages.push(message);
  c.fmt = String;
  c.fmtBytes = String;
  c.ensureNeuronCapacity = (n) => n <= c.nAct.length;
  c.ensureEdgeCapacity = (n) => n <= c.eW.length;
  c.selectedNodes = () => Array.from({ length: c.G.n }, (_, i) => i).filter((i) => c.selN[i]);
  for (const name of ['snapshot', 'adjEnsure', 'writeNeuron', 'writeEdge', 'syncSceneCounts', 'rebuildAdjacency',
    'invalidatePick', 'onGraphTopologyChanged', 'clearSelection', 'refreshPlacementUI', 'rebuildSelMesh',
    'refreshAll', 'markDirty', 'requestRender', 'rebuildScene', 'gbTouch', 'dropBlockMesh', 'disposeOp',
    'invalidateOpRefs', 'updateUndoButtons', 'streamCommit', 'setStatus', 'updateStreamHint']) c[name] = () => {};
  vm.createContext(c);
  install(c, ['plastBump', 'plastNormRule', 'plastNormProf', 'plastProf', 'plastOf', 'addNeuron',
    'groupName', 'groupEnsure', 'groupCount', 'groupHas', 'groupsOfNode', 'groupSetMany', 'gsyncPrimary',
    'modNextId', 'moduleFromSelection', 'instantiateModule']);
  return c;
}
function historyContext() {
  const c = context();
  Object.assign(c, {
    HIST: { cols: [] }, HIST_MIN_CHUNK: 4, HIST_TARGET_CHUNKS: 4, HIST_VERIFY: true,
    HISTV: { checks: 0, miss: 0, missAt: [], fast: 0, soft: 0 }, histForceAll: 0,
    history: { stack: [], head: -1, limit: 60 }, histOnCp: false,
    adjStale: true, adjBasisSeq: -1, topoChgSeq: 0, histObsSrc: null, histObsDst: null,
    histCopyChunks: 0, histSkipChunks: 0,
    fastRestoreRanges: () => null,
    nameCapture: () => new Map(c.nName), nameRestore: (names) => { c.nName = new Map(names); },
  });
  install(c, ['histChunkSize', 'histGrpDirty', 'histReg', 'histRebind', 'histSame', 'histCaptureCol',
    'histDiffChunks', 'histAdopt', 'sameHistList', 'captureState', 'snapshot', 'restore', 'undo', 'redo', 'resetHistory']);
  vm.runInContext(source.match(/^histReg\([^\r\n]+/gm).join('\n') + '\n' +
    source.match(/^const HIST_(?:CI|FAST)_[^\r\n]+/gm).join('\n'), c);
  return c;
}
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log('PASS | ' + name);
}

await test('undo/redo restores learning assignments, inhibition and independent profile definitions', () => {
  const c = historyContext();
  c.G.n = 2;
  c.PLAST.list.push(c.plastNormProf({ name: 'STDP', rule: 'stdp', lr: 0.2 }));
  c.resetHistory();
  c.snapshot();
  c.nPlast[0] = 1; c.nHard[0] = 1; c.PLAST.list[1].lr = 0.8;
  c.undo();
  assert.equal(c.nPlast[0], 0); assert.equal(c.nHard[0], 0); assert.equal(c.PLAST.list[1].lr, 0.2);
  c.redo();
  assert.equal(c.nPlast[0], 1); assert.equal(c.nHard[0], 1); assert.equal(c.PLAST.list[1].lr, 0.8);
  c.undo(); c.redo();
  assert.equal(c.PLAST.list[1].lr, 0.8);
  assert.equal(c.HISTV.miss, 0);
});
await test('profile deletion and neuron compaction can be undone without assigning another node’s learning settings', () => {
  const c = historyContext();
  c.G.n = 2;
  c.PLAST.list.push(c.plastNormProf({ name: 'Hebb', rule: 'hebb', lr: 0.1 }));
  c.nPlast[0] = 1; c.nHard[0] = 1;
  c.resetHistory(); c.snapshot();
  c.G.n = 1; c.nPlast[0] = c.nPlast[1]; c.nHard[0] = c.nHard[1]; c.PLAST.list.splice(1, 1);
  c.undo();
  assert.equal(c.G.n, 2); assert.equal(c.nPlast[0], 1); assert.equal(c.nHard[0], 1);
  assert.equal(c.nPlast[1], 0); assert.equal(c.PLAST.list[1].rule, 'hebb');
  c.redo();
  assert.equal(c.G.n, 1); assert.equal(c.nHard[0], 0); assert.equal(c.PLAST.list.length, 1);
});
await test('learning history survives typed-array growth and history chunk-width changes', () => {
  const c = historyContext(); c.G.n = 2; c.nHard[0] = 1;
  c.resetHistory(); c.snapshot();
  c.nHard = new Uint8Array(1024); c.nHard[1] = 1;
  c.nPlast = new Uint8Array(1024); c.nPlast[1] = 2;
  c.histRebind();
  c.undo();
  assert.deepEqual(Array.from(c.nHard.slice(0, 2)), [1, 0]);
  assert.deepEqual(Array.from(c.nPlast.slice(0, 2)), [0, 0]);
  c.redo();
  assert.deepEqual(Array.from(c.nHard.slice(0, 2)), [0, 1]);
  assert.deepEqual(Array.from(c.nPlast.slice(0, 2)), [0, 2]);
});
await test('learning-only edits remain eligible for the existing fast neuron restore path', () => {
  const c = historyContext(); c.G.n = 1;
  Object.assign(c, { BIG: { on: true, buf: {}, layer: {} }, BUILD: { active: false }, SIM: { active: false },
    LOD: { tier: 0 }, LAYER_N: 1, LAYER_EBIG: 2, builtMask: 3, S: { hoverEdge: -1 },
    nLayer: { cap: 64 }, layerMaskForTier: () => 3, adjStale: false });
  install(c, ['sameIdSet', 'mergeRanges', 'fastRestoreRanges']);
  const before = c.captureState(); c.nHard[0] = 1; c.nPlast[0] = 1; c.captureState();
  const ranges = c.fastRestoreRanges(before, c.histDiffChunks(before), true);
  assert.ok(ranges); assert.equal(ranges.edges.length, 0);
  assert.deepEqual(Array.from(ranges.neurons[0]), [0, 1]);
});
await test('module round trip preserves self-loops, inhibition, learning parameters and multiple groups across projects', () => {
  const original = context(); original.G.n = 1; original.G.e = 1; original.selN[0] = 1;
  original.eW[0] = 0.75; original.eLock[0] = 1; original.nHard[0] = 1; original.nPlast[0] = 1;
  original.PLAST.list.push(original.plastNormProf({ name: 'source', rule: 'stdp', lr: 0.3, tau: 7 }));
  for (const name of ['A', 'B']) original.groupSetMany(original.groupEnsure(name), [0], true);
  original.gsyncPrimary();
  const template = JSON.parse(JSON.stringify(original.moduleFromSelection('test', true)));
  const c = historyContext();
  c.PLAST.list.push(c.plastNormProf({ name: 'different target #1', rule: 'hebb', lr: 0.9 }));
  c.MODLIB.list.push(template); c.resetHistory();
  const copy = c.instantiateModule(0, { x: 10, y: 0, z: 0 });
  assert.equal(copy.edges, 1); assert.equal(c.eSrc[0], c.eDst[0]); assert.equal(c.eW[0], 0.75); assert.equal(c.eLock[0], 1);
  assert.equal(c.nHard[0], 1); assert.equal(c.nPlast[0], 2);
  assert.equal(c.plastProf(0).rule, 'stdp'); assert.equal(c.plastProf(0).lr, 0.3); assert.equal(c.PLAST.list[1].rule, 'hebb');
  assert.deepEqual(Array.from(c.groupsOfNode(0), (g) => c.groupName(g)), ['A', 'B']);
  assert.equal(c.nGroup[0], 1);
  c.undo(); assert.equal(c.G.n, 0); assert.equal(c.G.e, 0); assert.equal(c.PLAST.list.length, 2);
  c.redo(); assert.equal(c.nHard[0], 1); assert.equal(c.plastProf(0).rule, 'stdp'); assert.equal(c.groupCount(2), 1);
  c.instantiateModule(0, { x: 20, y: 0, z: 0 });
  assert.equal(c.PLAST.list.length, 3); assert.equal(c.groupCount(1), 2); assert.equal(c.groupCount(2), 2);
});
await test('legacy modules retain their single group and default to fixed, non-inhibitory nodes', () => {
  const c = context();
  c.MODLIB.list.push({ name: 'legacy', nodes: [{ x: 0, y: 0, z: 0, act: 1, bias: 0, grp: 'old' }], edges: [] });
  c.instantiateModule(0, { x: 0, y: 0, z: 0 });
  assert.equal(c.nHard[0], 0); assert.equal(c.nPlast[0], 0); assert.equal(c.groupCount(1), 1); assert.equal(c.nGroup[0], 1);
});
await test('a 255-entry profile table rejects new module profiles without changing the graph or table', () => {
  const c = context();
  for (let i = 1; i < 255; i++) c.PLAST.list.push(c.plastNormProf({ name: 'existing ' + i, rule: 'hebb' }));
  c.MODLIB.list.push({ name: 'needs another profile', nodes: [{ x: 0, y: 0, z: 0, act: 1, prof: 1 }], edges: [],
    plast: { list: [c.PLAST_NONE, c.plastNormProf({ name: 'new profile', rule: 'stdp' })] } });
  const before = JSON.stringify(c.PLAST.list);
  assert.equal(c.instantiateModule(0, { x: 0, y: 0, z: 0 }), null);
  assert.equal(c.G.n, 0); assert.equal(c.G.e, 0); assert.equal(c.PLAST.list.length, 255);
  assert.equal(JSON.stringify(c.PLAST.list), before);
});
await test('a 255-entry profile table can still reuse an identical module profile', () => {
  const c = context();
  for (let i = 1; i < 255; i++) c.PLAST.list.push(c.plastNormProf({ name: 'existing ' + i, rule: 'hebb' }));
  c.MODLIB.list.push({ name: 'reuse last profile', nodes: [{ x: 0, y: 0, z: 0, act: 1, prof: 1 }], edges: [],
    plast: { list: [c.PLAST_NONE, { ...c.PLAST.list[254] }] } });
  const before = JSON.stringify(c.PLAST.list);
  assert.ok(c.instantiateModule(0, { x: 0, y: 0, z: 0 }));
  assert.equal(c.G.n, 1); assert.equal(c.nPlast[0], 254); assert.equal(c.PLAST.list.length, 255);
  assert.equal(JSON.stringify(c.PLAST.list), before);
});

function streamContext(count = 1, cap = 64) {
  const c = context(cap);
  Object.assign(c, {
    NF3_HEAD_OFF: 16, streamQuiet: false, document: { getElementById: () => null },
    nf3Align4: (n) => (n + 3) & ~3, nf3Inflate: async (raw) => raw,
    STREAM: { on: true, done: 0, pending: new Map(), total: { n: count },
      chunks: Array.from({ length: count }, (_, i) => ({ n0: i, n1: i + 1, e0: 0, e1: 0, codec: 'raw' })),
      resident: new Uint8Array(count), nBase: new Int32Array(count).fill(-1), eBase: new Int32Array(count).fill(-1),
      parked: Array.from({ length: count }, () => []), header: { chunkNeurons: 1 }, headLen: 0, readBytes: 0, droppedEdges: 0,
    },
    streamState: () => ({ n: c.G.n, e: c.G.e, done: c.STREAM.done }),
    streamLoadBlocks: async () => ({ loaded: 0 }),
  });
  install(c, ['nf3Layout', 'streamChunkOf', 'streamLiveN', 'streamChunkBytes', 'streamPlastApplyChunk',
    'streamMaterialize', 'streamMaterializeRead', 'streamSaveBlocked', 'streamLoadChunks', 'streamLoadAll']);
  const size = c.nf3Layout(1, 0).total;
  c.STREAM.chunks.forEach((chunk, i) => Object.assign(chunk, { off: i * size, len: size }));
  c.STREAM.src = { chunk: async () => new Uint8Array(size) };
  return c;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
await test('failed reads do not change resident counts and can be retried', async () => {
  const c = streamContext();
  c.STREAM.src.chunk = async () => { throw new Error('I/O failure'); };
  await assert.rejects(c.streamMaterialize(0), /I\/O failure/);
  assert.equal(c.STREAM.done, 0); assert.equal(c.STREAM.resident[0], 0); assert.equal(c.STREAM.nBase[0], -1);
  assert.equal(c.G.n, 0); assert.equal(c.STREAM.pending.size, 0); assert.equal(c.streamSaveBlocked(), true);
  c.STREAM.src.chunk = async () => new Uint8Array(c.nf3Layout(1, 0).total);
  assert.equal(await c.streamMaterialize(0), 1); assert.equal(c.G.n, 1); assert.equal(c.STREAM.done, 1);
});
await test('capacity failures leave a stream chunk retryable', async () => {
  const c = streamContext(); c.ensureNeuronCapacity = () => false;
  await assert.rejects(c.streamMaterialize(0));
  assert.equal(c.STREAM.done, 0); assert.equal(c.STREAM.nBase[0], -1); assert.equal(c.G.n, 0);
  c.ensureNeuronCapacity = () => true;
  assert.equal(await c.streamMaterialize(0), 1);
});
await test('truncated, corrupt-compression, wrong-size and invalid-edge chunks fail before any graph mutation', async () => {
  for (const kind of ['truncated', 'compression', 'size', 'endpoint']) {
    const c = streamContext();
    let raw = new Uint8Array(c.nf3Layout(1, kind === 'endpoint' ? 1 : 0).total);
    if (kind === 'truncated') raw = raw.subarray(0, raw.length - 1);
    if (kind === 'compression') { c.STREAM.chunks[0].codec = 'deflate'; c.nf3Inflate = async () => { throw new Error('bad compressed data'); }; }
    if (kind === 'size') raw = new Uint8Array(raw.length + 4);
    if (kind === 'endpoint') {
      const chunk = c.STREAM.chunks[0]; chunk.e1 = 1; chunk.len = raw.length;
      new Uint32Array(raw.buffer, c.nf3Layout(1, 1).dst, 1)[0] = 999;
    }
    if (kind === 'size') Object.assign(c.STREAM.chunks[0], { len: raw.length, raw: raw.length - 4 });
    c.STREAM.src.chunk = async () => raw;
    await assert.rejects(c.streamMaterialize(0));
    assert.equal(c.G.n, 0, kind); assert.equal(c.G.e, 0, kind); assert.equal(c.STREAM.done, 0, kind);
    assert.equal(c.STREAM.nBase[0], -1, kind); assert.equal(c.streamSaveBlocked(), true, kind);
  }
});
await test('simultaneous requests for the same stream chunk read and append it only once', async () => {
  const c = streamContext(), gate = deferred(); let reads = 0;
  c.STREAM.src.chunk = () => { reads++; return gate.promise; };
  const a = c.streamMaterialize(0), b = c.streamMaterialize(0);
  assert.equal(reads, 1); assert.equal(c.STREAM.done, 0); assert.equal(c.streamSaveBlocked(), true);
  gate.resolve(new Uint8Array(c.nf3Layout(1, 0).total));
  await Promise.all([a, b]);
  assert.equal(c.G.n, 1); assert.equal(c.STREAM.done, 1); assert.equal(c.STREAM.pending.size, 0);
});
await test('different chunks completed out of order append to separate neuron ranges', async () => {
  const c = streamContext(2), gates = [deferred(), deferred()];
  const size = c.nf3Layout(1, 0).total;
  c.STREAM.src.chunk = (start) => gates[(start - 16) / size].promise;
  const a = c.streamMaterialize(0), b = c.streamMaterialize(1);
  const first = new Uint8Array(size), second = new Uint8Array(size);
  new Float32Array(first.buffer)[0] = 10; new Float32Array(second.buffer)[0] = 20;
  gates[1].resolve(second); await b; gates[0].resolve(first); await a;
  assert.equal(c.G.n, 2); assert.equal(c.STREAM.done, 2);
  assert.deepEqual(Array.from(c.STREAM.nBase), [1, 0]);
  assert.equal(c.nPos[0], 20); assert.equal(c.nPos[3], 10);
});
await test('a read from a reset or replaced stream cannot append to the new graph', async () => {
  const c = streamContext(), gate = deferred();
  c.STREAM.src.chunk = () => gate.promise;
  const read = c.streamMaterialize(0);
  c.STREAM.pending = new Map();
  gate.resolve(new Uint8Array(c.nf3Layout(1, 0).total));
  assert.equal(await read, 0); assert.equal(c.G.n, 0); assert.equal(c.STREAM.done, 0);
  assert.equal(c.STREAM.readBytes, 0);
});
await test('load-all terminates when overlapping automatic reads finish other pending chunks', async () => {
  const c = streamContext(2), gates = [deferred(), deferred()];
  const size = c.nf3Layout(1, 0).total;
  c.STREAM.src.chunk = (start) => gates[(start - 16) / size].promise;
  const automatic = c.streamMaterialize(1);
  const all = c.streamLoadAll();
  gates[1].resolve(new Uint8Array(size)); await automatic;
  gates[0].resolve(new Uint8Array(size));
  await all;
  assert.equal(c.G.n, 2); assert.equal(c.STREAM.done, 2); assert.equal(c.streamQuiet, false);
});
await test('a later chunk failure still publishes the earlier successful chunks to the scene', async () => {
  for (const entry of ['streamLoadChunks', 'streamLoadAll', 'streamTick']) {
    const c = streamContext(2); let commits = 0;
    c.streamCommit = () => { commits++; };
    c.STREAM.src.chunk = async (start) => { if (start !== 16) throw new Error('second chunk failed'); return new Uint8Array(c.nf3Layout(1, 0).total); };
    if (entry === 'streamTick') {
      Object.assign(c, { streamPickChunks: () => [0, 1], streamPlanEvict: () => null, streamHoldOn: false });
      Object.assign(c.STREAM, { auto: true, budgetMs: 10000, batches: 0 });
      install(c, ['streamTick']);
    }
    if (entry === 'streamLoadChunks') await assert.rejects(c[entry]([0, 1]), /second chunk failed/);
    else await c[entry]();
    assert.equal(commits, 1, entry); assert.equal(c.G.n, 1, entry); assert.equal(c.STREAM.done, 1, entry);
    assert.equal(c.streamSaveBlocked(), true, entry); assert.equal(c.STREAM.nBase[1], -1, entry);
  }
});
await test('streaming preserves self-loops and resolves edges parked on a later chunk', async () => {
  const c = streamContext(2), layout = c.nf3Layout(1, 2), first = new Uint8Array(layout.total);
  Object.assign(c.STREAM.chunks[0], { e1: 2, len: first.length });
  Object.assign(c.STREAM.chunks[1], { e0: 2, e1: 2, off: first.length });
  new Uint32Array(first.buffer, layout.src, 2).set([0, 0]);
  new Uint32Array(first.buffer, layout.dst, 2).set([0, 1]);
  new Float32Array(first.buffer, layout.w, 2).set([0.5, 0.75]);
  c.nHard.fill(1); c.nPlast.fill(1); c.nHid.fill(1);
  c.STREAM.src.chunk = async (start) => start === 16 ? first : new Uint8Array(c.nf3Layout(1, 0).total);
  await c.streamLoadChunks([0]);
  assert.equal(c.G.e, 1); assert.equal(c.STREAM.parked[1].length, 1);
  await c.streamLoadChunks([1]);
  assert.equal(c.G.e, 2); assert.equal(c.STREAM.droppedEdges, 0); assert.equal(c.STREAM.parked[1].length, 0);
  assert.deepEqual(Array.from(c.eDst.slice(0, 2)), [0, 1]);
  assert.deepEqual(Array.from(c.eW.slice(0, 2)), [0.5, 0.75]);
  for (const name of ['nHard', 'nPlast', 'nHid']) assert.deepEqual(Array.from(c[name].slice(0, 2)), [0, 0]);
});
await test('the existing Python stream fixture with legacy trailing padding loads all 24 chunks', async () => {
  const file = fs.readFileSync(new URL('./_streamdemo_raw.nforge', import.meta.url));
  const headLen = file.readUInt32LE(8), header = JSON.parse(file.subarray(16, 16 + headLen));
  const c = streamContext(header.chunks.length, Math.max(header.counts.neurons, header.counts.edges) + 16);
  Object.assign(c.STREAM, { header, headLen, chunks: header.chunks, total: { n: header.counts.neurons, e: header.counts.edges } });
  c.STREAM.src.chunk = async (start, end) => Uint8Array.from(file.subarray(start, end));
  c.nf3Inflate = async (raw) => Uint8Array.from(inflateSync(raw));
  assert.ok(header.chunks[0].raw > c.nf3Layout(header.chunks[0].n1, header.chunks[0].e1).total,
    'the compatibility fixture must cover trailing padding, not only current writer output');
  await c.streamLoadChunks(header.chunks.map((_, i) => i));
  assert.equal(c.STREAM.done, 24); assert.equal(c.G.n, header.counts.neurons); assert.equal(c.G.e, header.counts.edges);
  assert.equal(c.STREAM.droppedEdges, 0); assert.equal(c.streamSaveBlocked(), false);
});
console.log('STATE AUDIT: ' + passed + ' passed');
