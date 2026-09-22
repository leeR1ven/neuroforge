"""B04 / B07 / B08 的端到端回归：用真 PyTorch 跑一遍编译产物，证明参数角色真的生效。

  B04 BatchNorm 的 running mean/var 是 buffer（不可训练），带梯度的前向不再报
      "not differentiable with respect to running_mean"；.train() / .eval() 行为正确。
  B07 ONNX 字面常量编译成 buffer，不出现在 named_parameters 里，优化器一步之后数值不变。
  B08 多处引用的同一个初始化器在生成代码里是**同一个 Parameter 对象**，梯度自动相加。

用法: py -3 -B -X utf8 tools/verify_param_roles.py [工作目录]
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = []
FAILS = [0]


def log(ok, name, detail=""):
    if not ok:
        FAILS[0] += 1
    OUT.append(("PASS" if ok else "FAIL") + " | " + name + (" | " + str(detail) if detail else ""))


def load_module(path, tag):
    spec = importlib.util.spec_from_file_location("nf_roles_" + tag, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def gen_fixtures(work):
    r = subprocess.run(["node", os.path.join("tools", "gen_param_roles_fixture.mjs"), work],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise SystemExit("生成夹具失败：\n" + (r.stderr or "") + (r.stdout or ""))
    return json.loads(r.stdout.strip().splitlines()[-1])


def check_b04(work):
    import torch
    d = os.path.join(work, "bn_op")
    mod = load_module(os.path.join(d, "hand_built_net.py"), "bn")
    net = mod.HandBuiltNet()
    params = dict(net.named_parameters())
    buffers = dict(net.named_buffers())
    log("o0_p0" in params and "o0_p1" in params, "B04 scale / B 是可训练参数")
    log("o0_p2" not in params and "o0_p3" not in params, "B04 running mean / var 不是可训练参数")
    log("o0_p2" in buffers and "o0_p3" in buffers, "B04 running mean / var 注册成 buffer",
        "mean=%s var=%s" % (float(buffers["o0_p2"]), float(buffers["o0_p3"])))

    x = torch.tensor([[1.0, 2.0, 3.0, 4.0]])   # (batch, num_inputs) -> NCHW (1,1,2,2)

    # eval：用运行统计量 -> (x - 0.5) / sqrt(4 + 1e-5) * 2 + 0.1 ≈ x - 0.4
    net.eval()
    with torch.no_grad():
        y = net(x)
    want = ((x - 0.5) / torch.sqrt(torch.tensor(4.0) + 1e-5) * 2.0 + 0.1).reshape(1, -1)
    err = float(torch.max(torch.abs(y - want)))
    log(err < 1e-5, "B04 .eval() 用运行统计量（跟 ONNX 推理一致）", "最大偏差 %.3e" % err)
    log(float(buffers["o0_p2"]) == 0.5 and float(buffers["o0_p3"]) == 4.0,
        "B04 eval 不动运行统计量")

    # train：带梯度的前向 + 反向（这就是原来直接报错的路径）
    net.train()
    before = (float(net.o0_p2), float(net.o0_p3))
    out = net(x)
    loss = (out ** 2).sum()
    try:
        loss.backward()
        ok = True
        err = ""
    except Exception as exc:                       # noqa: BLE001
        ok, err = False, type(exc).__name__ + ": " + str(exc)[:200]
    log(ok, "B04 .train() 带梯度前向 / 反向不报错", err)
    log(net.o0_p0.grad is not None and net.o0_p1.grad is not None, "B04 scale / B 拿到梯度")
    after = (float(net.o0_p2), float(net.o0_p3))
    log(after != before, "B04 .train() 更新运行统计量", "%s -> %s" % (before, after))


def check_b07(work):
    import torch
    d = os.path.join(work, "const_scale")
    mod = load_module(os.path.join(d, "hand_built_net.py"), "const")
    net = mod.HandBuiltNet()
    params = dict(net.named_parameters())
    buffers = dict(net.named_buffers())
    log("o0_p0" not in params, "B07 字面常量不出现在 named_parameters 里")
    log("o0_p0" in buffers, "B07 字面常量注册成 buffer")
    log(float(buffers["o0_p0"]) == 0.5, "B07 常量初值 0.5")

    net.train()
    x = torch.tensor([[2.0]])
    y = net(x)
    log(abs(float(y) - 1.0) < 1e-6, "B07 首次推理 Y = 0.5 * X", "Y=%s" % float(y))
    loss = (y ** 2).sum()
    trainable = list(net.parameters())
    if trainable:
        loss.backward()
        torch.optim.SGD(trainable, lr=0.1).step()
    log(float(net.o0_p0) == 0.5, "B07 一步 SGD 之后常量没被改动", "值=%s" % float(net.o0_p0))


def check_b08(work):
    import torch
    d = os.path.join(work, "shared_param")
    mod = load_module(os.path.join(d, "hand_built_net.py"), "shared")
    net = mod.HandBuiltNet()
    log(net.o1_p0 is net.o0_p0, "B08 两个算子参数是同一个 Parameter 对象")
    names = [n for n, _ in net.named_parameters()]
    log(names.count("o0_p0") + names.count("o1_p0") == 1,
        "B08 named_parameters 里去重成一份", ",".join(names))

    x = torch.tensor([[2.0, 3.0]])
    y = net(x)
    # 两个 head 读同一路输入、各写一处落点，输出是四处之和 -> grad_W 必须是 2 * x
    # （两份独立参数的话这里只会得到 1 * x）。
    y.sum().backward()
    g = net.o0_p0.grad
    log(g is not None, "B08 共享参数拿到梯度")
    if g is not None:
        want = 2.0 * x[0].detach()
        log(torch.allclose(g, want), "B08 共享参数的梯度是两处之和（不是各存一份）",
            "grad=%s 期望=%s" % (g.tolist(), want.tolist()))


def main():
    work = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "nf_param_roles")
    os.makedirs(work, exist_ok=True)
    info = gen_fixtures(work)
    log(info.get("legacy_mean_role") == "stat" and info.get("legacy_scale_role") == "weight"
        and info.get("explicit_winning_role") == "weight",
        "角色兜底：老文件里 BN 的 mean/var 按名字落成 stat，其余浮点仍是 weight",
        json.dumps(info, ensure_ascii=False))
    try:
        import torch  # noqa: F401
    except ImportError as exc:
        raise SystemExit("本机没有 PyTorch，无法跑参数角色回归：" + str(exc))
    check_b04(work)
    check_b07(work)
    check_b08(work)
    print("\n".join(OUT))
    print("PARAM ROLE CHECKS: %d failed" % FAILS[0] if FAILS[0] else "PARAM ROLE CHECKS: all passed")
    return 1 if FAILS[0] else 0


if __name__ == "__main__":
    raise SystemExit(main())
