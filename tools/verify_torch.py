"""真实导出器的端到端验证：PyTorch -> onnx.export -> import_model -> .nforge。

verify_import.py 用的是手工搭的 ONNX 图，验的是"折的语义对不对"；
这里补的是另一半：**真导出器吐出来的图长什么样**（Gemm 还是 MatMul+Add、
权重是不是初始化器、有没有多出来的 Reshape/Constant）。手工图再像也不算数。

顺带把导出的 .nforge 丢进 prototype/，可以拿去浏览器里肉眼看一眼。
"""
from __future__ import annotations

import os
import sys
import tempfile

import numpy as np
import torch
import torch.nn as nn

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nforge               # noqa: E402
import import_model         # noqa: E402
from verify_import import ir_forward   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROTO = os.path.join(ROOT, "prototype")
torch.manual_seed(20260911)
OUT = []


def log(ok, name, detail=""):
    OUT.append(("PASS" if ok else "FAIL") + " | " + name + " | " + str(detail))


def export(model, x, path, **kw):
    torch.onnx.export(model, (x,), path, export_params=True,
                      input_names=["X"], output_names=["Y"],
                      dynamic_axes={"X": {0: "batch"}, "Y": {0: "batch"}},
                      opset_version=17, **kw)
    return path


def run_case(tag, model, exporter, tmp, expect_err=None, save_as=None):
    x = torch.randn(1, model.in_f, dtype=torch.float32)
    path = os.path.join(tmp, tag + ".onnx")
    try:
        export(model, x, path, **exporter)
    except Exception as e:
        log(True, f"{tag} 导出器不可用（跳过）", type(e).__name__ + ": " + str(e)[:90])
        return
    opts = import_model.argparse.Namespace(
        model=path, out=None, name=tag, chunk_neurons=4096,
        max_neurons=import_model.MAX_N, max_edges=import_model.MAX_E,
        prune_below=0.0, spacing=26.0, names=True, compress=True)
    try:
        b, _ = import_model.import_onnx(path, opts)
        neu, edg, blk, _ = import_model.build_arrays(b, opts)
    except import_model.Unsupported as e:
        if expect_err is None:
            log(False, tag, "本不该报错：" + str(e)[:160])
        else:
            log(expect_err in str(e), f"{tag} 明确报错", str(e).replace("\n", " ")[:120])
        return
    if expect_err is not None:
        log(False, tag, "本该报错却通过了")
        return

    nfile = save_as or os.path.join(tmp, tag + ".nforge")
    nforge.write(nfile, neu, edg, name=tag, chunk_neurons=opts.chunk_neurons, names=b.names,
                 blocks=blk)
    _h, neu2, edg2, _blk = nforge.read(nfile)

    with torch.no_grad():
        want = model(x).numpy().reshape(-1)
    got = ir_forward(neu2, edg2, x.numpy(), b.out_ids)
    err = float(np.max(np.abs(want - got)))
    log(err < 2e-5, f"{tag} 数值和 PyTorch 一致",
        f"最大误差 {err:.3e}（{len(neu2)} 神经元 / {len(edg2)} 连接）")


class Mlp(nn.Module):
    def __init__(self, in_f, hidden, out_f, act=nn.ReLU):
        super().__init__()
        self.in_f = in_f
        self.net = nn.Sequential(nn.Linear(in_f, hidden), act(),
                                 nn.Linear(hidden, out_f), act())

    def forward(self, t):
        return self.net(t)


class Deep(nn.Module):
    def __init__(self):
        super().__init__()
        self.in_f = 12
        self.net = nn.Sequential(
            nn.Linear(12, 16), nn.ReLU(), nn.Linear(16, 12), nn.Tanh(),
            nn.Linear(12, 8), nn.LeakyReLU(0.01), nn.Linear(8, 3), nn.Sigmoid())

    def forward(self, t):
        return self.net(t)


class WithFlat(nn.Module):
    def __init__(self):
        super().__init__()
        self.in_f = 6
        self.net = nn.Sequential(nn.Flatten(), nn.Linear(6, 5), nn.ReLU(), nn.Linear(5, 2))

    def forward(self, t):
        return self.net(t)


class WithSoftmax(nn.Module):
    def __init__(self):
        super().__init__()
        self.in_f = 4
        self.net = nn.Sequential(nn.Linear(4, 3), nn.Softmax(dim=-1))

    def forward(self, t):
        return self.net(t)


def main():
    os.makedirs(PROTO, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        exporters = [("ts", {"dynamo": False})]
        try:
            import onnxscript  # noqa: F401
            exporters.append(("dynamo", {"dynamo": True}))
        except ImportError:
            log(True, "dynamo 导出器没装 onnxscript，只验 TorchScript 导出器",
                "pip install onnxscript 之后重跑就能覆盖 dynamo 那条路")
        for xname, xkw in exporters:
            run_case(f"mlp_{xname}", Mlp(6, 10, 4), xkw, tmp)
            run_case(f"deep_{xname}", Deep(), xkw, tmp,
                     save_as=os.path.join(PROTO, "torch_demo.nforge") if xname == "ts" else None)
            run_case(f"flatten_{xname}", WithFlat(), xkw, tmp)
            run_case(f"softmax_{xname}", WithSoftmax(), xkw, tmp, expect_err="Softmax")

    for l in OUT:
        print(l)
    fails = [l for l in OUT if l.startswith("FAIL")]
    print(f"\n== {len(OUT) - len(fails)} PASS / {len(fails)} FAIL ==")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
