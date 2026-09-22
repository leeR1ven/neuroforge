/* B04 / B07 / B08 回归的第一步：用生产代码里的真函数生成三种图，落盘成
   hand_built_net.py + model.bin，交给 tools/verify_param_roles.py 用真 PyTorch 跑。

   为什么不让浏览器自检来跑：这三项要在**真 PyTorch** 里验证梯度 / 优化器行为，
   自检页跑不了 Python。所以这里复用 tools/generate_audit_codegen.mjs 的生产函数
   提取器（它把 main.js 里的真函数抽进 Node 的 vm 里跑，不碰任何构建产物）。

   用法：node tools/gen_param_roles_fixture.mjs OUTPUT_DIR [MAIN_JS]
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2];
if (!out) throw new Error("usage: node tools/gen_param_roles_fixture.mjs OUTPUT_DIR [MAIN_JS]");

/* 借生成器前面那一半（去掉了它自带的用例），再补上算子那一套函数。 */
let harness = fs.readFileSync(path.join(root, "tools/generate_audit_codegen.mjs"), "utf8");
harness = harness.slice(0, harness.indexOf("\nsetup(2, [0], [1], [[0, 1, 2]]);"));
harness = harness
  .replace("const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));", "const root = process.cwd();")
  .replace("const out = process.argv[2];", "const out = nfOutDir;")
  .replace("const source = fs.readFileSync(process.argv[3] || path.join(root, 'prototype/src/main.js'), 'utf8');",
           "const source = fs.readFileSync(nfMainJs, 'utf8');");

harness += String.raw`
/* 算子那一套：参数张量 / 角色 / 二进制排布 / 拓扑 */
include('const OP_MAGIC_BLOB', 'let opList =');
include('function opNumel(', '/* 谁在用这个算子的输出');
include('function opTopoOrder(', 'function opDelete(');
Object.assign(ctx, { opSeq: 1, opParamSeq: 1, invalidateOpRefs() {} });

const F = [
  { name: 'const_scale', n: 2, inputs: [0], outputs: [1], edges: [], ops: [
    { op: 'Mul', name: 'scale', ins: [{ k: 'n', ids: [0], shape: [1, 1] }, { k: 'c', p: 'c0', shape: [1] }],
      outShape: [1, 1], land: [1], params: [{ name: 'c0', dtype: 'f32', shape: [1], data: [0.5], role: 'const' }] },
  ] },
  { name: 'bn_op', n: 8, inputs: [0, 1, 2, 3], outputs: [4, 5, 6, 7], edges: [], ops: [
    { op: 'BatchNormalization', name: 'bn', ins: [{ k: 'n', ids: [0, 1, 2, 3], shape: [1, 1, 2, 2] }],
      outShape: [1, 1, 2, 2], land: [4, 5, 6, 7], attrs: { epsilon: 1e-5 }, params: [
        { name: 'scale', dtype: 'f32', shape: [1], data: [2.0] },
        { name: 'B', dtype: 'f32', shape: [1], data: [0.1] },
        { name: 'mean', dtype: 'f32', shape: [1], data: [0.5] },
        { name: 'var', dtype: 'f32', shape: [1], data: [4.0] },
      ] },
  ] },
  /* 同一个初始化器被两个算子引用：编译出来必须是同一个 Parameter，梯度自动相加。
     W 的形状取 [2]（逐元素广播），别用 [2,2]——那在 batch=1 时会广播成 (2,2)，是夹具的错。 */
  { name: 'shared_param', n: 6, inputs: [0, 1], outputs: [2, 3, 4, 5], edges: [], ops: [
    { op: 'Mul', name: 'head_a', ins: [{ k: 'n', ids: [0, 1], shape: [1, 2] }, { k: 'c', p: 'W', shape: [2] }],
      outShape: [1, 2], land: [2, 3],
      params: [{ name: 'W', dtype: 'f32', shape: [2], data: [1.5, 0.5], role: 'weight', same: 'tied0' }] },
    { op: 'Mul', name: 'head_b', ins: [{ k: 'n', ids: [0, 1], shape: [1, 2] }, { k: 'c', p: 'W', shape: [2] }],
      outShape: [1, 2], land: [4, 5],
      params: [{ name: 'W', dtype: 'f32', shape: [2], data: [1.5, 0.5], role: 'weight', same: 'tied0' }] },
  ] },
];

for (const fx of F) {
  setup(fx.n, fx.inputs, fx.outputs, fx.edges, []);
  for (const o of fx.ops) ctx.makeOp(o.op, o.name, o);
  emit(fx.name);
}
/* 角色兜底：老文件（没有 role 字段）里 BN 的 mean/var 必须回落到 stat */
/* 老文件：参数没有 role 字段，但算子类型是 BatchNormalization -> mean/var 必须落成 stat */
const legacy = ctx.opMakeParam('mean', 'f32', [1], [0], undefined, 'BatchNormalization', undefined);
const legacyW = ctx.opMakeParam('scale', 'f32', [1], [1], undefined, 'BatchNormalization', undefined);
/* 显式写了合法角色就以它为准 */
const explicit = ctx.opMakeParam('mean', 'f32', [1], [0], 'weight', 'BatchNormalization', 'mean');
console.log(JSON.stringify({
  legacy_mean_role: legacy.role, legacy_scale_role: legacyW.role, explicit_winning_role: explicit.role,
  saved: F.map((f) => f.name),
}));
`;

await import("data:text/javascript;base64," + Buffer.from(
  "const nfOutDir = " + JSON.stringify(path.resolve(out)) + ";\n" +
  "const nfMainJs = " + JSON.stringify(process.argv[3] || path.join(root, "prototype/src/main.js")) + ";\n" +
  harness).toString("base64"));
