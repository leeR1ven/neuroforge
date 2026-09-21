# -*- coding: utf-8 -*-
"""可塑性稀疏表搬进 model.bin 之后的端到端对拍。

用法：node prototype/make_plastbin.mjs && node prototype/run_checks.mjs --only=plastbin
      py -3 tools/verify_plastic.py

链条：
  编辑器自己学一步（NF.plastApply，界面上「模拟激活」走的就是这段代码）
    → 「学之前」和「学之后」各编译一份 model.bin
    → 学之前那份读进生成的 .py（可塑性表是从 bin 的整型段里切出来的）
    → 按编辑器给的 waveOf 调 net.nf_plastic_step(act, wave)
    → 三方互比：编辑器 / 生成的产物 / 照 plastRuleDelta 独立重写的一份
"""
import importlib.util, json, os, shutil, sys
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

OK = True
def check(cond, msg):
    global OK
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        OK = False
    return cond

D = "_dump"
exp = json.load(open(os.path.join(D, "plastbin_expect.json"), encoding="utf-8"))
work = os.path.join(D, "_plastbin_work")
if os.path.isdir(work):
    shutil.rmtree(work)
os.makedirs(work)
shutil.copyfile(os.path.join(D, "plastbin_net.py"), os.path.join(work, "hand_built_net.py"))
shutil.copyfile(os.path.join(D, "plastbin_before.bin"), os.path.join(work, "model.bin"))

before = np.fromfile(os.path.join(D, "plastbin_before.bin"), dtype="<f4")
after = np.fromfile(os.path.join(D, "plastbin_after.bin"), dtype="<f4")

spec = importlib.util.spec_from_file_location("hbn_plastbin", os.path.join(work, "hand_built_net.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
net = mod.HandBuiltNet()
N, E = int(net.num_neurons), int(net.num_edges)
src = np.asarray(net.src)
dst = np.asarray(net.dst)
profOf = np.asarray(exp["profOf"], dtype=np.int64)
profs = exp["profiles"]
print("规模 N=%d E=%d  可塑边=%d  档位=%d  生成源码=%d 字节" %
      (N, E, exp["plastEdges"], len(profs), exp["codeLen"]))
check(N == exp["N"] and E == exp["E"], "规模与编译器报的一致")
check(exp["codeLen"] < 100000, "生成源码只有 %d 字节（可塑性表没写进源码）" % exp["codeLen"])

# ---- 1) 可塑性表：照编辑器的判据重新推一遍（源神经元挂了档位的那几条边）----
edgeLock = np.asarray(exp["edgeLock"], dtype=np.int64)
nodeLock = np.asarray(exp["nodeLock"], dtype=np.int64)
want = [k for k in range(E)
        if profOf[int(src[k])] > 0 and not edgeLock[k]
        and not nodeLock[int(src[k])] and not nodeLock[int(dst[k])]]
check(len(want) == exp["plastEdges"], "重推出来的可塑边条数 = 编辑器 plastStats().plasticEdges（%d）" % len(want))
check(net.plast_ix.tolist() == want, "产物里的 plast_ix 与重推出来的下标逐个一致")
check(net.plast_prof.tolist() == [int(profOf[int(src[k])]) for k in want], "每条可塑边的档位号 = 源神经元的档位号")
check(np.array_equal(net.plast_src.numpy(), src[want]) and np.array_equal(net.plast_dst.numpy(), dst[want]),
      "plast_src / plast_dst 现取出来的就是那两条连接的两端")
check(not bool(net.plast_frozen.any()), "被冻结的边一条都没进可塑性表（所以 plast_frozen 全为 False）")
check(np.array_equal(np.asarray(net.w_frozen, dtype=np.int64), edgeLock),
      "bin 里冻结清单还原出来的权重冻结掩码 == 编辑器里逐条边的锁（那一段就排在可塑性表后面）")
check(np.array_equal(np.asarray(net.b_frozen, dtype=np.int64), nodeLock),
      "偏置冻结掩码 == 编辑器里神经元的锁")

# ---- 2) dt：用 nptr / node_order 自己算拓扑波次，跟产物里的 dt 比 ----
nptr = list(net.nptr)
order = np.asarray(net.node_order)
wave = np.full(N, -1, dtype=np.int64)
for k in range(len(nptr) - 1):
    wave[order[nptr[k]:nptr[k + 1]]] = k
check(net.plast_dt.tolist() == [float(wave[int(dst[k])] - wave[int(src[k])]) for k in want],
      "dt 就是拓扑层差（用 nptr / node_order 独立算了一遍）")
check(np.array_equal(net.weight.detach().numpy(), before[:E]), "学之前：产物读出来的权重逐位等于 bin")

# ---- 3) 独立实现：照 plastRuleDelta 的六条规则重写一遍 ----
waveOf = np.asarray(exp["waveOf"], dtype=np.int64)
def delta(p, w, dt):
    lr, tau, dc = p["lr"], p["tau"], p["decay"]
    r = p["rule"]
    if r == "hebb":
        return lr * (p["wmax"] - w)
    if r == "anti":
        return lr * (p["wmin"] - w)
    if r == "decay":
        return -dc * w
    if r == "stdp":
        if dt > 0:
            return lr * np.exp(-dt / tau)
        if dt < 0:
            return -lr * 0.5 * np.exp(dt / tau)
        return 0.0
    if r == "stdpd":
        if dt > 0:
            return lr * np.exp(-dt / tau) - dc * w
        if dt < 0:
            return -lr * 0.5 * np.exp(dt / tau) - dc * w
        return -dc * w
    return 0.0

w0 = before[:E].astype(np.float64)
ref = w0.copy()
nRef = 0
for t, k in enumerate(want):
    ws, wd = int(waveOf[int(src[k])]), int(waveOf[int(dst[k])])
    if ws < 0 or wd < 0:
        continue                      # 两头没同时亮过，这一拍不算
    p = profs[int(net.plast_prof[t])]   # 档位号从产物的表里读，不是从源码里读
    nw = min(max(float(w0[k]) + float(delta(p, float(w0[k]), wd - ws)), float(p["wmin"])), float(p["wmax"]))
    if nw != w0[k]:
        ref[k] = nw
        nRef += 1

# ---- 4) 生成的产物跑一步 ----
import torch
act = torch.tensor(np.asarray(exp["val"], dtype=np.float32)).unsqueeze(0)
wv = torch.tensor(waveOf).unsqueeze(0)
ed = after[:E].astype(np.float64)

netw = mod.HandBuiltNet()
nWave = int(netw.nf_plastic_step(act, wv))
gotWave = netw.weight.detach().numpy().astype(np.float64)
netA = mod.HandBuiltNet()
nAct = int(netA.nf_plastic_step(act))
gotAct = netA.weight.detach().numpy().astype(np.float64)

print("改了几条边：编辑器 %d / 独立实现 %d / 产物(带 wave) %d / 产物(只给 act) %d" % (exp["learned"], nRef, nWave, nAct))
check(nRef == exp["learned"], "独立实现改的条数 = 编辑器报的条数")
check(nWave == nRef, "产物（带 wave）改的条数 = 独立实现的条数")
d1 = float(np.abs(gotWave - ed).max())
d2 = float(np.abs(ref - ed).max())
d3 = float(np.abs(gotAct - ed).max())
print("最大偏差：产物(带 wave) vs 编辑器 %.3e ｜ 独立实现 vs 编辑器 %.3e ｜ 产物(只给 act) vs 编辑器 %.3e" % (d1, d2, d3))
check(d1 <= 1e-5, "★ 产物（带 wave）与编辑器学出来的权重逐位一致")
check(d2 <= 1e-5, "独立实现与编辑器一致（公式没抄错）")
check(d3 <= 1e-5, "这张纯前馈单拍图里，不带 wave 的退化路径也等于编辑器（waveOf 就是拓扑层）")
check(int(np.count_nonzero(np.abs(after[:E] - before[:E]) > 0)) == nRef,
      "编辑器那次编译写出来的 bin 里，只有 %d 条权重变了" % nRef)

print()
# ---- 5) 多拍图：证明编辑器的 dt 里确实带「第几拍」的偏移 ----
m = json.load(open(os.path.join(D, "plastbin_multi.json"), encoding="utf-8"))
print("多拍图：span=%d 步数=%d 有状态=%s waveOf=%s" % (m["span"], m["steps"], m["stateful"], m["waveOf"]))
check(bool(m["stateful"]) and m["late"] > 0,
      "多拍图里确有神经元是「第 1 拍以后」才亮的（waveOf 带拍号偏移：%d 个）" % m["late"])
if m["late"] > 0:
    ws = m["waveOf"][0]
    wd = max(m["waveOf"])
    print("      -> 编辑器那次学习用的 dt = %d - %d = %d；编译期只有拓扑层差 1（所以不传 wave 会不一样）" % (wd, ws, wd - ws))
print()
print("结论:", "PASS" if OK else "FAIL")
sys.exit(0 if OK else 1)
