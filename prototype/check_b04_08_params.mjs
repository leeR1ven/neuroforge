import fs from "node:fs";
import vm from "node:vm";

/* B04 / B07 / B08 的参数角色回归（快查版）。
   真 PyTorch 的行为在 tools/verify_param_roles.py（要 Python 环境，跑得慢）；
   这里只查「改错了会当场报」的那几条：角色判定、文件头目录写法、生成代码的分支、
   序列化有没有把角色带过去、导入器有没有把角色算出来。 */
const source = fs.readFileSync(new URL("./src/main.js", import.meta.url), "utf8");
const src = source.replace(/\r\n/g, "\n");
let fails = 0;
function check(name, fn) {
  try { fn(); console.log("PASS | " + name); }
  catch (e) { fails++; console.log("FAIL | " + name + " :: " + ((e && e.message) || e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function count(s) { return src.split(s).length - 1; }
function has(s) { return src.includes(s); }
function slice(from, to, label) {
  const a = src.indexOf(from);
  assert(a >= 0, label + "：找不到起点");
  const b = src.indexOf(to, a);
  assert(b > a, label + "：找不到终点");
  return src.slice(a, b);
}

/* ---- 1. 角色判定表（跑真函数，不是看源码） ---- */
const roleSrc = slice("/* 参数的角色：", "/* 参数张量。形状", "角色表");
const dirSrc = slice("function opDirParams(o) {", "\n}\n", "opDirParams") + "\n}\n";
const ctx = {};
vm.createContext(ctx);
vm.runInContext(roleSrc + dirSrc, ctx, { filename: "roles.js" });
const R = ctx.opParamRole, D = ctx.opDirParams;

check("角色判定：浮点默认 weight，整型默认 int", () => {
  assert(R("", "f32", "Conv", "W") === "weight", "f32 默认不是 weight");
  assert(R("", "f16", "Mul", "c0") === "weight", "f16 默认不是 weight");
  assert(R("", "i64", "Reshape", "c1") === "int", "i64 默认不是 int");
  assert(R("", "bool", "X", "c0") === "int", "bool 默认不是 int");
});

check("角色判定：老文件里 BN / LN 的 mean、var 落成 stat", () => {
  assert(R("", "f32", "BatchNormalization", "mean") === "stat", "BN mean 不是 stat");
  assert(R("", "f32", "BatchNormalization", "var") === "stat", "BN var 不是 stat");
  assert(R("", "f32", "BatchNormalization", "scale") === "weight", "BN scale 不该是 stat");
  assert(R("", "f32", "BatchNormalization", "B") === "weight", "BN B 不该是 stat");
  assert(R("", "f32", "LayerNormalization", "mean") === "stat", "LN mean 不是 stat");
  assert(R("", "f32", "Conv", "mean") === "weight", "普通算子的 mean 不该变成 stat");
});

check("角色判定：显式写的合法角色优先，乱写 / 原型链上的名字一律回落", () => {
  assert(R("weight", "f32", "BatchNormalization", "mean") === "weight", "显式 weight 没被尊重");
  assert(R("stat", "f32", "Conv", "W") === "stat", "显式 stat 没被尊重");
  assert(R("const", "f32", "Mul", "c0") === "const", "显式 const 没被尊重");
  assert(R("int", "i32", "X", "c0") === "int", "显式 int 没被尊重");
  assert(R("bogus", "f32", "Conv", "W") === "weight", "乱写的角色没回落到 weight");
  assert(R("__proto__", "f32", "Conv", "W") === "weight", "原型链上的名字不该被当成合法角色");
  assert(R("constructor", "f32", "Conv", "W") === "weight", "constructor 不该被当成合法角色");
});

/* ---- 2. 文件头目录：非默认才写 role，same 有就写 ---- */
check("文件头目录只写需要写的键（老软件读到不认识的键会忽略）", () => {
  const a = D({ params: [{ name: "W", dtype: "f32", shape: [2], role: "weight", same: "" }] })[0];
  assert(JSON.stringify(a) === JSON.stringify({ name: "W", dtype: "f32", shape: [2] }), "weight 不该写出来：" + JSON.stringify(a));
  const b = D({ params: [{ name: "mean", dtype: "f32", shape: [1], role: "stat", same: "" }] })[0];
  assert(b.role === "stat" && b.same === undefined, "stat 没写出来");
  const c = D({ params: [{ name: "W", dtype: "f32", shape: [2], role: "weight", same: "tied0" }] })[0];
  assert(c.same === "tied0" && c.role === undefined, "same 没写出来：" + JSON.stringify(c));
  const d = D({ params: [{ name: "c", dtype: "f32", shape: [] }] })[0];
  assert(d.role === undefined && d.same === undefined, "完全默认的参数不该多写键");
});

/* ---- 3. 生成代码：可训练才 nn.Parameter，其余 buffer ---- */
check("生成代码按角色分支：role = weight 才有 nn.Parameter", () => {
  assert(count("if (pe.f && prole === 'weight') {") === 1, "找不到按角色分流的判据");
  assert(has("role: opParamRole(role, d.name, op, name)"), "opMakeParam 没有算角色");
  assert(has("opMakeParam(p.name, p.dtype, p.shape, p.data, p.role, op, p.same)"), "makeOp 没有把角色 / same 传下去");
  assert(has("opMakeParam(p.name, p.dtype, p.shape, data, p.role, o.op, p.same)"), "opSetParam 改数值时会把角色丢掉");
});

check("生成代码：同一个 same 只建一份参数，后面的直接指过去", () => {
  assert(count("sharedParam.get(psame)") === 1, "找不到共享去重的判据");
  assert(has("+ pn + ' = self.' + prev.name +"), "找不到「指向既有参数」的那一行");
});

check("生成代码：BN 跟着 self.training 走，mean/var 不再按 Parameter 建", () => {
  assert(count("training=self.training") === 1, "BN 没有跟 self.training 走");
  assert(count("training=False") === 0, "还有硬编码 training=False 的残留");
});

/* ---- 4. 序列化 / 反序列化带着角色走 ---- */
check("v2 JSON 与 .nforge 都把角色 / 共享带过去、读回来", () => {
  assert(has("role: p.role || 'weight', same: p.same || ''"), "opsSerial 没写角色");
  assert(has("role: p.role, same: p.same"), "deserialize 没传角色");
  assert(has("params: opDirParams(o)"), "nf3OpDirEntry 没走 opDirParams");
  assert(count("dpOf.get(String(p.name))") === 1, "makeOpFromDir 没把角色对回去");
});

/* ---- 5. NF 接口：能改角色，且进了 mut 名单 ---- */
check("NF.opSetParamRole 存在且被列为可撤销接口", () => {
  assert(count("opSetParamRole: (id, name, role) => {") === 1, "找不到 NF.opSetParamRole");
  assert(has("const OP_ROLES = { weight: 1, stat: 1, const: 1, int: 1 };"), "OP_ROLES 表不对");
  assert(has("function opRoleKnown(tbl, v)"), "角色查表没有走 hasOwnProperty 守卫");
  const mut = slice("const AI_API_ROLE_MUT = (", ".split(' ')", "MUT 名单");
  assert(/\bopSetParamRole\b/.test(mut), "opSetParamRole 不在 mut 名单里");
});

/* ---- 6. 导入器：字面常量 = const，具名参数 = weight/stat，共享带 same ---- */
check("导入器按输入位算角色，并把共享键带上", () => {
  const py = fs.readFileSync(new URL("../tools/import_model.py", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert(has, "");
  assert(py.includes("def param_role_for(op, name, named):"), "导入器没有 param_role_for");
  assert(py.includes('if not named:\n        return "const"'), "导入器没把非具名常量算成 const");
  assert(py.includes("role=role, same=b.share_key(nm, a32, label)"), "op_refs_for 没带角色 / 共享键");
  assert(py.includes("def share_key(self, name, arr, label):"), "Builder 没有 share_key");
  assert(py.includes("op_refs_for(b, ins, label, params, OP_NAMED_IN.get(op), op)"), "build_op_node 没把算子类型传下去");
  assert(py.includes('1.0 - float(A.get("momentum", 0.9))'), "BN 的 momentum 没换算成 PyTorch 语义");
});

check("Python 侧容器 / 文件头读写作法与前端一致", () => {
  const py = fs.readFileSync(new URL("../tools/nforge.py", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert(py.includes('OP_ROLES = ("weight", "stat", "const", "int")'), "nforge.py 没有角色表");
  assert(py.includes('role: str = "weight"') && py.includes('same: str = ""'), "OpParam 没有 role / same 字段");
  assert(py.includes('if p.role != "weight":\n        d["role"] = p.role'), "param_dir_entry 写法跟前端不一致");
  assert(py.includes('if p.same:\n        d["same"] = str(p.same)'), "param_dir_entry 没写 same");
  assert(py.includes('p.role = str(dp.get("role") or "weight")'), "op_node_from_dir 没把角色读回来");
});

console.log(fails ? ("B04/07/08 PARAM ROLE CHECKS: " + fails + " failed") : "B04/07/08 PARAM ROLE CHECKS: all passed");
process.exit(fails ? 1 : 0);
