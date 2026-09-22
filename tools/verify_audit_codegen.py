"""Regression tests for the five compiler defects found in the read-only audit.

Run: py -3 tools/verify_audit_codegen.py
Requires Node.js, NumPy and PyTorch. ONNX/CUDA checks run when available.
The production JS analyzer, IR builder and exporters write only to a temporary
directory; no built HTML, repository fixture or user's project is rewritten.
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import warnings

import numpy as np
import torch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
PAIRS = (("weight", "w_frozen"), ("bias", "b_frozen"), ("bw", "blk_frozen"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=os.environ.get("NODE", "node"))
    parser.add_argument("--source", type=Path, help="alternative main.js, for checking the old regression baseline")
    args = parser.parse_args()
    failures = []
    checks = 0

    def check(name, fn):
        nonlocal checks
        checks += 1
        try:
            fn()
            print("PASS | " + name)
        except Exception as exc:
            failures.append((name, exc))
            print("FAIL | %s | %s: %s" % (name, type(exc).__name__, exc))

    with tempfile.TemporaryDirectory(prefix="nf-codegen-regression-") as temp:
        work = Path(temp)
        cmd = [args.node, str(ROOT / "tools/generate_audit_codegen.mjs"), temp]
        if args.source:
            cmd.append(str(args.source.resolve()))
        subprocess.run(cmd, check=True, cwd=ROOT)
        modules = {}
        for item in json.loads((work / "manifest.json").read_text()):
            name = item["name"]
            spec = importlib.util.spec_from_file_location(name, work / name / "hand_built_net.py")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            modules[name] = mod

        def plastic():
            net = modules["plastic"].HandBuiltNet()
            assert net.plast_frozen.tolist() == [False]
            torch.testing.assert_close(net(torch.ones(2, 1)), torch.full((2, 1), 2.0))
            assert net.nf_plastic_step(torch.tensor([1.0, 2.0])) == 1
            torch.testing.assert_close(net.weight, torch.tensor([2.2]))

        check("small inline plastic model imports, runs and learns", plastic)

        def hard(name, x, expected, device):
            net = modules[name].HandBuiltNet().to(device)
            assert "hpair_input" not in net.state_dict(), "derived input metadata changed checkpoint keys"
            got = net(torch.tensor(x, dtype=torch.float32, device=device))
            torch.testing.assert_close(got.cpu(), torch.tensor(expected, dtype=torch.float32))

        def hard_state(device):
            net = modules["hard_state"].HandBuiltNet()
            # Initialize on CPU first, then move the live model (including its existing state).
            torch.testing.assert_close(net(torch.tensor([[1.0, 2.0]])), torch.zeros(1, 1))
            net.to(device)
            for inputs, expected in [([0.0, 2.0], 2.0), ([1.0, 5.0], 0.0), ([0.0, 1.0], 3.0)]:
                got = net(torch.tensor([inputs], device=device))
                torch.testing.assert_close(got.cpu(), torch.tensor([[expected]]))
            assert net.st.device == net.bias.device
            assert float(net.st[0, 2]) == 3.0

        devices = ["cpu"] + (["cuda"] if torch.cuda.is_available() else [])
        for device in devices:
            check("hard input signals / batch / sign / " + device,
                  lambda d=device: hard("hard_input", [[1, 1], [0, 1], [-1, 1]], [[0], [3], [0]], d))
            check("hard shared destination across waves / " + device,
                  lambda d=device: hard("hard_hidden", [[1, 1], [0, 1]], [[0], [5]], d))
            check("hard suppression preserves state / " + device, lambda d=device: hard_state(d))

        def recurrent(name, expected):
            net = modules[name].HandBuiltNet()
            got = net(torch.ones(2, 2, 1))
            torch.testing.assert_close(got, torch.tensor([expected, expected], dtype=torch.float32))
            got.sum().backward()
            if hasattr(net, "bw"):
                assert net.bw.grad is not None and torch.all(net.bw.grad != 0), "block gradient was lost"

        check("recurrent wave fed only by block", lambda: recurrent("recblock_only", [[2], [3]]))
        check("recurrent wave fed by block and sparse edge", lambda: recurrent("recblock_mixed", [[3], [4.5]]))
        check("recurrent sparse-only control", lambda: recurrent("recurrent_sparse", [[2], [3]]))

        def bias_mask():
            net = modules["frozen_biasbin"].HandBuiltNet()
            assert not hasattr(net, "w_frozen")
            assert net.b_frozen.tolist() == [False, True], net.b_frozen.tolist()

        check("binary bias-only freeze mask", bias_mask)

        def optimizer_for(mod, net, name, external):
            if not external:
                return mod.make_optimizer(net, {"optimizer": name, "lr": 0.1, "weight_decay": 0.1})
            cls = {"adam": torch.optim.Adam, "adamw": torch.optim.AdamW, "sgd": torch.optim.SGD}[name]
            kw = {"momentum": 0.9} if name == "sgd" else {}
            opt = cls(net.parameters(), lr=0.1, weight_decay=0.1, **kw)
            return net.protect_frozen(opt)

        def freeze(name, optimizer, external, device="cpu"):
            mod = modules[name]
            net = mod.HandBuiltNet().to(device)
            keys = tuple(net.state_dict())
            params = dict(net.named_parameters())
            initial = {n: p.detach().clone() for n, p in params.items()}
            masks = {n: getattr(net, mn) for n, mn in PAIRS if hasattr(net, mn)}
            assert any(bool(mask.any()) for mask in masks.values()), "fixture lost its freeze mask"
            net.apply_freeze()
            net.apply_freeze()  # Public API is idempotent.
            opt = optimizer_for(mod, net, optimizer, external)
            net.protect_frozen(opt)
            net.protect_frozen(opt)
            assert len(opt._nf_freeze_guards) == 1
            for step in range(3):
                opt.zero_grad()
                net(torch.ones(2, 1, device=device)).square().mean().backward()
                for n, mask in masks.items():
                    if params[n].grad is not None:
                        assert torch.all(params[n].grad[mask] == 0)
                # Simulate nonzero momentum restored from an old optimizer checkpoint.
                if step == 1:
                    for p, state in opt.state.items():
                        for value in state.values():
                            if torch.is_tensor(value) and value.shape == p.shape:
                                value.fill_(0.7)
                opt.step()
                for n, mask in masks.items():
                    assert torch.equal(params[n].detach()[mask], initial[n][mask]), n + " changed while frozen"
                    for value in opt.state.get(params[n], {}).values():
                        if torch.is_tensor(value) and value.shape == params[n].shape:
                            assert torch.all(value[mask.to(value.device)] == 0), "frozen momentum was retained"
            assert any(not torch.equal(p.detach(), initial[n]) for n, p in params.items()), "trainable parameters did not update"
            assert tuple(net.state_dict()) == keys, "freeze guards changed checkpoint keys"
            restored = mod.HandBuiltNet().to(device)
            restored.load_state_dict(net.state_dict())
            for n, p in net.named_parameters():
                assert torch.equal(p, dict(restored.named_parameters())[n]), "checkpoint round trip changed " + n

        for name in ("frozen_biasbin", "frozen_inline", "frozen_bin", "frozen_block"):
            for optimizer in ("adam", "adamw", "sgd"):
                for external in (False, True):
                    label = "%s / %s / %s" % (name, optimizer, "external protected" if external else "built-in")
                    check(label, lambda n=name, o=optimizer, e=external: freeze(n, o, e))
        if "cuda" in devices:
            check("frozen block / external AdamW / cuda", lambda: freeze("frozen_block", "adamw", True, "cuda"))

        def train_entry():
            mod = modules["frozen_inline"]
            data = work / "data.npz"
            np.savez(data, X=np.ones((4, 1), np.float32), Y=np.zeros((4, 2), np.float32))
            with contextlib.redirect_stdout(io.StringIO()):
                net = mod.train({"optimizer": "adamw", "weight_decay": 0.1, "lr": 0.1,
                                 "epochs": 2, "batch_size": 2, "device": "cpu", "data": str(data)})
            assert float(net.weight[0].detach()) == 2.0
            assert float(net.bias[1].detach()) == 3.0
            assert float(net.weight[1].detach()) != 4.0

        check("exported train() protects frozen parameters with weight decay", train_entry)

        if importlib.util.find_spec("onnx"):
            import onnx
            from onnx.reference import ReferenceEvaluator

            def onnx_compare(name, x, expected):
                net = modules[name].HandBuiltNet().eval()
                dest = work / (name + ".onnx")
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", torch.jit.TracerWarning)
                    torch.onnx.export(net, (x[:1],), str(dest), opset_version=17, dynamo=False,
                                      input_names=["input"], output_names=["output"],
                                      dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}})
                graph = onnx.load(dest)
                onnx.checker.check_model(graph)
                got = ReferenceEvaluator(graph).run(None, {"input": x.numpy()})[0]
                np.testing.assert_allclose(got, expected, rtol=1e-6, atol=1e-6)

            check("ONNX hard input / dynamic batch", lambda: onnx_compare(
                "hard_input", torch.tensor([[1., 1.], [0., 1.], [-1., 1.]]), [[0.], [3.], [0.]]))
            check("ONNX recurrent block / dynamic batch", lambda: onnx_compare(
                "recblock_only", torch.ones(2, 2, 1), [[[2.], [3.]], [[2.], [3.]]]))
        else:
            print("SKIP | ONNX package unavailable")
        if "cuda" not in devices:
            print("SKIP | CUDA unavailable")

    print("%d passed / %d failed" % (checks - len(failures), len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
