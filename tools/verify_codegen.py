# -*- coding: utf-8 -*-
"""把「模型编译」生成的产物真跑一遍，证明它们不是只能看的花架子。

验三件事：
  1. hand_built_net.py 能被 PyTorch import、能 forward，
     而且 forward 的结果跟「按定义逐节点求值」的独立参考实现一致。
  2. hand_built_net.py 能导出 ONNX，ONNX 推理结果与 PyTorch 对拍。
  3. model.c 能用 gcc 编成可执行文件，喂同样的输入，输出与 PyTorch 对拍。

用法:  py -3 tools/verify_codegen.py
       py -3 tools/verify_codegen.py <生成的.py> <生成的.c>
"""
from __future__ import annotations

import ast
import importlib.util
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUMP = os.path.join(ROOT, "_dump")

OUT = []
def log(ok, name, detail=""):
    OUT.append(("PASS" if ok else "FAIL") + " | " + name + " | " + str(detail))


def load_module(path):
    spec = importlib.util.spec_from_file_location("nf_gen_" + str(abs(hash(path)) % 100000), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def parse_net(src):
    g = {}
    g["num_waves"] = int(re.search(r"self\.num_waves = (\d+)", src).group(1))
    g["nptr"] = ast.literal_eval(re.search(r"self\.nptr = (\[[^\]]*\])", src).group(1))
    g["ptr"] = ast.literal_eval(re.search(r"self\.ptr = (\[[^\]]*\])", src).group(1))
    for nm in ("input_nodes", "output_nodes", "src", "dst", "node_order", "act_code"):
        m = re.search(
            r'register_buffer\("%s", torch\.tensor\(\[([\s\S]*?)\], dtype=torch\.long\)\)' % nm, src)
        g[nm] = list(ast.literal_eval("[" + m.group(1) + "]")) if m else []
    return g


ACTS = [
    lambda t: t,
    lambda t: np.maximum(t, 0.0),
    lambda t: np.where(t > 0, t, 0.01 * t),
    lambda t: 1.0 / (1.0 + np.exp(-t)),
    lambda t: np.tanh(t),
    lambda t: 0.5 * t * (1.0 + np.tanh(0.7978845608028654 * (t + 0.044715 * t * t * t))),
    lambda t: np.where(t > 0, t, np.exp(t) - 1.0),
    lambda t: t / (1.0 + np.exp(-t)),
]


def ref_forward(g, W, B, x):
    """独立参考实现：按拓扑波次求值，但用 numpy 自己写一遍，不碰 PyTorch。"""
    N = len(B)
    h = np.array(B, dtype=np.float64)
    for i, v in zip(g["input_nodes"], x):
        h[i] = float(v)
    for k in range(g["num_waves"]):
        na, nb = g["nptr"][k], g["nptr"][k + 1]
        if nb <= na:
            continue
        idx = g["node_order"][na:nb]
        pre = h[idx].copy()
        ea, eb = g["ptr"][k], g["ptr"][k + 1]
        if eb > ea:
            d = np.zeros(N, dtype=np.float64)
            for j in range(ea, eb):
                d[g["dst"][j]] += h[g["src"][j]] * float(W[j])
            pre = pre + d[idx]
        code = [g["act_code"][i] for i in idx]
        for t, i in enumerate(idx):
            h[i] = ACTS[int(code[t])](pre[t])
    return np.array([h[i] for i in g["output_nodes"]], dtype=np.float64)


def check_python(py_path, tag):
    src = open(py_path, encoding="utf-8").read()
    g = parse_net(src)
    log(True, f"{tag} 结构可解析",
        f"N={len(g['act_code'])} E={len(g['src'])} waves={g['num_waves']} "
        f"in={len(g['input_nodes'])} out={len(g['output_nodes'])}")

    mod = load_module(py_path)
    net = mod.HandBuiltNet().eval()
    W = net.weight.detach().numpy().astype(np.float64)
    B = net.bias.detach().numpy().astype(np.float64)

    rng = np.random.default_rng(20260912)
    nin = len(g["input_nodes"])
    worst = 0.0
    for _ in range(12):
        x = rng.uniform(-2.0, 2.0, size=nin)
        import torch
        with torch.no_grad():
            got = net(torch.tensor(x, dtype=torch.float32)[None, :]).numpy()[0]
        want = ref_forward(g, W, B, x)
        worst = max(worst, float(np.max(np.abs(got - want))))
    log(worst < 1e-5, f"{tag} PyTorch forward 与参考实现一致", f"最大偏差 {worst:.3e}")

    acts_used = sorted(set(g["act_code"]))
    log(True, f"{tag} 用到的激活函数编号", str(acts_used))
    return mod, net, g, acts_used


def check_onnx(onnx_py, tag, tmp):
    """ONNX 只在「ONNX 目标」那份文件里才带导出函数，所以这里单独载入它。"""
    if not onnx_py or not os.path.exists(onnx_py):
        log(False, f"{tag} 找不到 ONNX 目标的 .py", str(onnx_py))
        return
    mod = load_module(onnx_py)
    path = os.path.join(tmp, tag + ".onnx")
    try:
        mod.export_onnx(path, 1, 17)
    except Exception as e:
        log(False, f"{tag} 导出 ONNX", type(e).__name__ + ": " + str(e)[:200])
        return
    size = os.path.getsize(path)
    try:
        err = mod.check_onnx(path, 3)
    except Exception as e:
        log(False, f"{tag} ONNX 对拍", type(e).__name__ + ": " + str(e)[:200])
        return
    log(err < 1e-5, f"{tag} ONNX 与 PyTorch 对拍", f"最大偏差 {err:.3e}，文件 {size / 1024:.1f} KB")


def find_cc():
    for name in ("gcc", "cc", "clang", "tcc"):
        p = shutil.which(name)
        if p:
            return name, p
    p = r"C:\mingw64\bin\gcc.exe"
    if os.path.exists(p):
        return "gcc", p
    return None, None


def check_c(c_path, net, g, tag, tmp):
    name, cc = find_cc()
    if not cc:
        log(True, f"{tag} 跳过 C 编译（本机没有 C 编译器）", "")
        return
    exe = os.path.join(tmp, tag + (".exe" if os.name == "nt" else ""))
    cmd = [cc, "-O2", "-o", exe, c_path]
    if name != "tcc":
        cmd.append("-lm")
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        log(False, f"{tag} gcc 编译 model.c", (r.stderr or r.stdout or "")[:300])
        return
    log(True, f"{tag} gcc 编译 model.c", f"{os.path.getsize(exe) / 1024:.1f} KB 可执行文件")

    import torch
    rng = np.random.default_rng(4242)
    nin, nout = len(g["input_nodes"]), len(g["output_nodes"])
    lines, want = [], []
    for _ in range(9):
        x = rng.uniform(-2.0, 2.0, size=nin)
        lines.append(" ".join("%.17g" % v for v in x))
        with torch.no_grad():
            want.append(net(torch.tensor(x, dtype=torch.float32)[None, :]).numpy()[0])
    r2 = subprocess.run([exe], input="\n".join(lines) + "\n",
                        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r2.returncode != 0:
        log(False, f"{tag} 运行可执行文件", (r2.stderr or "")[:300])
        return
    rows = [l for l in r2.stdout.strip().split("\n") if l.strip()]
    worst = 0.0
    for i, row in enumerate(rows[:len(want)]):
        got = np.array([float(v) for v in row.split()])
        worst = max(worst, float(np.max(np.abs(got - want[i]))))
    log(len(rows) >= len(want) and worst < 2e-5, f"{tag} 可执行文件输出与 PyTorch 对拍",
        f"{len(rows)} 组输入，最大偏差 {worst:.3e}")


def main():
    args = sys.argv[1:]
    if len(args) >= 2:
        cases = [(os.path.abspath(args[0]), os.path.abspath(args[1]))]
    else:
        cases = [(os.path.join(DUMP, "gen_tiny.py"), os.path.join(DUMP, "model_tiny.c")),
                 (os.path.join(DUMP, "gen_allact.py"), os.path.join(DUMP, "model_allact.c"))]

    for py_path, c_path in cases:
        tag = os.path.splitext(os.path.basename(py_path))[0]
        if not os.path.exists(py_path):
            log(False, f"{tag} 找不到文件", py_path)
            continue
        with tempfile.TemporaryDirectory() as tmp:
            mod, net, g, acts = check_python(py_path, tag)
            check_onnx(py_path.replace(".py", "_onnx.py"), tag, tmp)
            if len(acts) >= 8:
                log(True, f"{tag} 八种激活函数全覆盖", "linear/relu/leaky/sigmoid/tanh/gelu/elu/silu")
            if os.path.exists(c_path):
                check_c(c_path, net, g, tag, tmp)
            else:
                log(False, f"{tag} 找不到 C 文件", c_path)

    for l in OUT:
        print(l)
    fails = [l for l in OUT if l.startswith("FAIL")]
    print("\n== %d PASS / %d FAIL ==" % (len(OUT) - len(fails), len(fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())