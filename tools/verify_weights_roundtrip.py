# -*- coding: utf-8 -*-
'''B20 回归：训练出来的权重必须能安全地灌回编辑器（F09）。

生成的 hand_built_net.py 在真实数据上训练完（或者你手工接着训练完），得能把权重导回
编辑器接着改、接着重新编译。要安全地做这件事，先得回答一个问题：

    这份权重文件，是这张图训练出来的吗？

答案是**结构指纹**——一个只由结构算出来的 sha256（神经元数、每条连接的两端 / 激活码 /
权重块与算子节点的形状、共享组、参数名）。数值（权重、阈值、偏置、冻结标记）一律不进
指纹：它们正是要回填的东西，进去了就永远对不上。两边各算一遍，对不上就明确拒绝，绝不
半填——填错的权重是**静默**的，跑出来全是错的，比报错难查得多。

这条回归把五个夹具各走一遍完整往返：

  1. 生成脚本 --export-weights 导出的那一份，跟编辑器侧现算的那一份**对账**：
     指纹一个字不差、每条连接的两端逐条相同（同一条边序）、块表与算子参数表一致、
     数值按 float32 逐位相同。
  2. 把可训练张量清零，再按导出的文档填回去：前向输出与原模型**逐位相同**——
     证明这份文档是「训练后模型」的完整描述，没有漏掉任何一个可训练张量。
  3. 权重 / 偏置 / 块改了，指纹**不变**（这才是"数值不进指纹"），而数值确实跟着变了。
  4. 权重里混进 NaN：导出这一步就明确拒绝（否则 json.dump 会写出非法的 NaN，
     编辑器那边 JSON.parse 炸出来的是一句"语法错"，用户根本想不到是训练发散了）。
  5. 命令行 --export-weights 那条路能跑通，且内容与直接调用一致。

五个夹具分别覆盖：前馈 / 循环（回边权重和前向权重在同一段里）/ 有状态神经元 /
权重块（走 model.bin，源码里不带数值）/ 算子节点（参数按 o<i>_p<k> 取回来）。

Run: py -3 -B -X utf8 tools/verify_weights_roundtrip.py
夹具由 tools/gen_train_ce_fixture.mjs 用生产代码生成器现造，落在临时目录，跑完即删。
'''
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parent.parent
OUT: list = []

CASES = ["feed_ce", "rec_ce", "state_ce", "block_ce", "op_ce"]


def log(ok, name, detail=""):
    OUT.append(("PASS" if ok else "FAIL") + " | " + name + (" | " + detail if detail else ""))
    if not ok:
        print(OUT[-1])


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def f32(a, b):
    '''两个数按 float32 比。编辑器那一侧存的是 JS 的双精度字面量（1.1），
    生成的脚本那一侧是 float32（1.100000023841858）——同一个权重，两种写法。'''
    return np.float32(a) == np.float32(b)


def same_list(a, b):
    return len(a) == len(b) and all(f32(x, y) for x, y in zip(a, b))


def same_map(a, b):
    if set(a.keys()) != set(b.keys()):
        return False
    return all(same_list(a[k], b[k]) for k in a)


def fwd(net, mod, x, seed):
    if hasattr(net, "reset_state"):
        net.reset_state()
    torch.manual_seed(seed)
    with torch.no_grad():
        return net(x)


def zero_trainables(net, mod):
    with torch.no_grad():
        net.weight.zero_()
        net.bias.zero_()
        if getattr(net, "bw", None) is not None:
            net.bw.zero_()
        for e in mod.NF_LAYOUT_PARAMS:
            if e.get("role", "weight") != "weight":
                continue
            t = getattr(net, e.get("attr", ""), None)
            if t is not None:
                t.zero_()


def apply_doc(net, doc, mod):
    '''按导出的文档把数值填回去。这就是编辑器 weightsApply 干的事（那边写回 eW / nBias /
    块数组 / 算子参数），这里写回等价的张量——两边说的是同一件事。'''
    vals = doc["values"]
    with torch.no_grad():
        net.weight.copy_(torch.tensor(vals["edges"], dtype=torch.float32))
        net.bias.copy_(torch.tensor(vals["bias"], dtype=torch.float32))
        if getattr(net, "bw", None) is not None:
            flat = torch.zeros(int(net.bw.numel()), dtype=torch.float32)
            for e in mod.NF_LAYOUT_BLOCKS:
                if e["rep"] != e["i"]:
                    continue
                o = int(net.bwoff[e["i"]])
                flat[o:o + e["k"] * e["n"]] = torch.tensor(vals["blocks"][str(e["i"])],
                                                            dtype=torch.float32)
            net.bw.copy_(flat)
        for e in mod.NF_LAYOUT_PARAMS:
            if e.get("role", "weight") != "weight":
                continue
            t = getattr(net, e.get("attr", ""), None)
            v = vals["params"].get(str(e["op"]) + ":" + e["name"])
            if t is None or v is None:
                continue
            t.copy_(torch.tensor(v, dtype=t.dtype).view(t.shape))


def values_differ(a, b):
    if not same_list(a["edges"], b["edges"]):
        return True
    if not same_list(a["bias"], b["bias"]):
        return True
    if not same_map(a["blocks"], b["blocks"]):
        return True
    return not same_map(a["params"], b["params"])


def main():
    tmp = Path(tempfile.mkdtemp(prefix="nf_weights_"))
    try:
        gen = subprocess.run(["node", str(ROOT / "tools" / "gen_train_ce_fixture.mjs"), str(tmp)],
                             capture_output=True, text=True, cwd=str(ROOT))
        if gen.returncode != 0:
            print("夹具生成失败:\n" + gen.stdout + gen.stderr)
            return 1

        docs = {}
        for case in CASES:
            d = tmp / case
            mod = load_module(d / "hand_built_net.py", "nfw_" + case)
            ed = json.loads((d / "editor_weights.json").read_text("utf-8"))
            exp = d / "exported.json"
            mod.export_weights(str(exp))
            doc = json.loads(exp.read_text("utf-8"))
            docs[case] = doc

            log(doc.get("format") == "neuroforge-weights" and doc.get("version") == 1,
                case + "：导出的文件是 neuroforge-weights v1", str(doc.get("format")))
            log(doc["topology"] == ed["topology"],
                case + "：结构指纹 —— 生成脚本里那串 == 编辑器现算的那串",
                doc["topology"][:16] + " / " + ed["topology"][:16])
            log(doc["topology"] == mod.NF_TOPOLOGY, case + "：和源码里的 NF_TOPOLOGY 一致")
            log(doc["graph"] == ed["graph"], case + "：规模元数据一致", json.dumps(doc["graph"]))
            log(doc["layout"]["edges"] == ed["layout"]["edges"],
                case + "：每条连接的两端逐条一致（同一条边序）",
                str(len(doc["layout"]["edges"])) + " 条")

            eb = [{k: e[k] for k in ("i", "k", "n", "sg", "rep")} for e in doc["layout"]["blocks"]]
            log(eb == ed["layout"]["blocks"], case + "：权重块的块表一致", json.dumps(eb))
            ep = [{k: e.get(k) for k in ("op", "name", "shape", "role", "same")}
                  for e in doc["layout"]["params"]]
            log(ep == ed["layout"]["params"], case + "：算子参数表一致", json.dumps(ep))

            log(same_list(doc["values"]["edges"], ed["values"]["edges"]) and
                same_list(doc["values"]["bias"], ed["values"]["bias"]) and
                same_map(doc["values"]["blocks"], ed["values"]["blocks"]) and
                same_map(doc["values"]["params"], ed["values"]["params"]),
                case + "：数值按 float32 逐位一致（连接 / 偏置 / 块 / 算子参数）")

            x = (torch.randn(3, mod.NUM_STEPS, mod.NUM_INPUTS) if getattr(mod, "RECURRENT", False)
                 else torch.randn(3, mod.NUM_INPUTS))
            net = mod.HandBuiltNet().eval()
            y0 = fwd(net, mod, x, 11)
            zero_trainables(net, mod)
            y1 = fwd(net, mod, x, 11)
            log(not torch.equal(y0, y1),
                case + "：把可训练张量清零，输出确实变了（权重真的在参与计算）")
            apply_doc(net, doc, mod)
            y2 = fwd(net, mod, x, 11)
            log(torch.equal(y0, y2),
                case + "：按导出文档填回来，前向输出与原模型逐位相同")

            orig_cls = mod.HandBuiltNet

            class Pert(orig_cls):
                def __init__(self):
                    super().__init__()
                    with torch.no_grad():
                        self.weight.mul_(1.5)
                        self.bias.add_(0.25)
                        if getattr(self, "bw", None) is not None:
                            self.bw.mul_(1.25)

            pdoc = None
            try:
                mod.HandBuiltNet = Pert
                pf = d / "perturbed.json"
                mod.export_weights(str(pf))
                pdoc = json.loads(pf.read_text("utf-8"))
            finally:
                mod.HandBuiltNet = orig_cls
            log(pdoc is not None and pdoc["topology"] == doc["topology"],
                case + "：权重 / 偏置 / 块改了，结构指纹**不变**（数值不进指纹）")
            log(pdoc is not None and values_differ(pdoc["values"], doc["values"]),
                case + "：同时数值确实变了（不是把老数据又导了一遍）")

            class Nano(orig_cls):
                def __init__(self):
                    super().__init__()
                    with torch.no_grad():
                        if self.weight.numel():
                            self.weight.reshape(-1)[0] = float("nan")
                        else:
                            self.bias.reshape(-1)[0] = float("nan")

            bad = d / "nan.json"
            ok, msg = False, "没报错"
            mod.HandBuiltNet = Nano
            try:
                mod.export_weights(str(bad))
            except ValueError as e:
                ok = "NaN" in str(e)
                msg = str(e)
            except Exception as e:                      # noqa: BLE001
                msg = "%s: %s" % (type(e).__name__, e)
            finally:
                mod.HandBuiltNet = orig_cls
            log(ok, case + "：权重里混进 NaN，导出这一步就明确拒绝", msg[:100])
            log(not bad.exists(), case + "：拒绝的时候没有留下半个权重文件")

        topos = [docs[c]["topology"] for c in CASES]
        log(len(set(topos)) == len(CASES), "五张结构不同的图，指纹两两不同")

        for case in ("feed_ce", "block_ce"):
            d = tmp / case
            cli = d / "cli.json"
            r = subprocess.run([sys.executable, "-B", "-X", "utf8",
                                str(d / "hand_built_net.py"), "--export-weights", str(cli)],
                               capture_output=True, text=True, cwd=str(d))
            ok = r.returncode == 0 and cli.exists()
            log(ok, case + "：命令行 --export-weights 能跑通",
                (r.stderr or r.stdout or "").strip()[-140:])
            if ok:
                cdoc = json.loads(cli.read_text("utf-8"))
                ed = json.loads((d / "editor_weights.json").read_text("utf-8"))
                log(cdoc["topology"] == ed["topology"] and
                    same_list(cdoc["values"]["bias"], docs[case]["values"]["bias"]) and
                    cdoc["layout"]["edges"] == docs[case]["layout"]["edges"],
                    case + "：命令行导出的与直接调用的内容一致")

        npass = sum(1 for s in OUT if s.startswith("PASS"))
        nfail = len(OUT) - npass
        print("== %d PASS / %d FAIL ==" % (npass, nfail))
        for s in OUT:
            if s.startswith("FAIL"):
                print(s)
        return 1 if nfail else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
