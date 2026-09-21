# -*- coding: utf-8 -*-
"""算子级（卷积这类）端到端对拍：ONNX 参考实现 vs 浏览器编译出来的 PyTorch。

管线（每一段都是产品里真实的那条路）：
  _opdemo.onnx  --tools/import_model.py-->  _opdemo.nforge
                --prototype/_opcheck.html（浏览器里真编译）-->  _dump/op_net.py + op_model.bin
                --这里用 torch 跑一遍-->  跟 onnx.reference 的结果比

页面上还顺手做了一次往返：把载进来的图**用浏览器再编码**一份 .nforge 丢给这边，
所以「JS 写、Python 读」这个方向的算子区也被逐字段对了一遍——算子参数区的偏移
只要错一个字，Python 读出来的就是别的东西，而且不会有任何异常。

只比结构不算数：数值对不上就是"折错了"。所以这里既比数值，也比算子节点里的
参数张量是不是跟原模型逐位相同（卷积核被悄悄改过、或者存错段，数值都会立刻露馅）。

用法： py -3 tools/verify_op.py [dump目录，默认 _dump]
前置： py -3 tools/gen_op_demo.py  &&  node prototype/make_opcheck.mjs  &&  跑一次 _opcheck.html
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROTO = os.path.join(ROOT, "prototype")
sys.path.insert(0, HERE)
import nforge   # noqa: E402

OUT = []


def log(ok, name, detail=""):
    OUT.append(("PASS" if ok else "FAIL") + " | " + name + " | " + str(detail))


# 算子里那些"具名参数"对应原模型的哪个初始化器（样例模型是 gen_op_demo.py 造的，名字是定的）
CONV_W = ["W1", "W2"]
CONV_B = ["B1", "B2"]


def expect_params(meta_ops):
    """返回 [(算子下标, 参数名, 原模型里的张量名)]；对不上的参数第三项是 None。"""
    pairs = []
    ci = 0
    for i, o in enumerate(meta_ops):
        if o["op"] == "Conv":
            m = {"W": CONV_W[ci], "B": CONV_B[ci]}
            ci += 1
        elif o["op"] == "BatchNormalization":
            m = {"scale": "S1", "B": "BN1", "mean": "M1", "var": "V1"}
        else:
            m = {}
        for p in o["params"]:
            pairs.append((i, p["name"], m.get(p["name"])))
    return pairs


def load_net(py_path, bin_path, tag):
    import torch
    tmp = tempfile.mkdtemp(prefix="nforge_op_")
    shutil.copy(py_path, os.path.join(tmp, "hand_built_net.py"))
    shutil.copy(bin_path, os.path.join(tmp, "model.bin"))
    spec = importlib.util.spec_from_file_location(
        "hbnop_" + tag + str(abs(hash(tmp)) % 99999), os.path.join(tmp, "hand_built_net.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    net = mod.HandBuiltNet()
    net.eval()
    return net


def op_fields(ops):
    """算子节点的一份可比较快照（参数只留名字 / 形状 / 数值的 sha 式的逐位摘要）。"""
    if ops is None:
        return []
    out = []
    for nd in ops.list:
        out.append({
            "op": nd.op, "name": nd.name,
            "ins": [(r.get("k"), r.get("p") or r.get("id"), list(r.get("shape") or [])) for r in nd.ins],
            "out": list(nd.out), "attrs": dict(nd.attrs),
            "fold": list(nd.fold), "note": nd.note,
            "land": None if nd.land is None else [int(nd.land[0]), int(nd.land[-1]) + 1],
            "params": [(p.name, p.dtype, list(p.shape), p.data.tobytes()) for p in nd.params],
        })
    return out


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "_dump"
    meta_p = os.path.join(d, "op_meta.json")
    py_p = os.path.join(d, "op_net.py")
    bin_p = os.path.join(d, "op_model.bin")
    py2_p = os.path.join(d, "op_net2.py")
    bin2_p = os.path.join(d, "op_model2.bin")
    js_nforge = os.path.join(d, "op_from_js.nforge")
    ref_p = os.path.join(PROTO, "_opdemo_ref.json")
    py_nforge = os.path.join(PROTO, "_opdemo.nforge")
    onnx_p = os.path.join(PROTO, "_opdemo.onnx")
    for p in (meta_p, py_p, bin_p, py2_p, bin2_p, js_nforge, ref_p, py_nforge, onnx_p):
        if not os.path.exists(p):
            print("缺少 " + p + "——先跑 py -3 tools/gen_op_demo.py 和 _opcheck.html")
            return 2

    meta = json.load(open(meta_p, encoding="utf-8"))
    ref = json.load(open(ref_p, encoding="utf-8"))
    src = open(py_p, encoding="utf-8").read()
    import onnx
    from onnx import numpy_helper
    inits = {t.name: numpy_helper.to_array(t) for t in onnx.load(onnx_p).graph.initializer}

    ops = meta.get("ops") or []
    kinds = {}
    for o in ops:
        kinds[o["op"]] = kinds.get(o["op"], 0) + 1
    log(len(ops) > 0, "工程里记下了算子节点",
        f"{len(ops)} 个：" + "、".join(f"{k}×{v}" for k, v in sorted(kinds.items())))
    want_kinds = {"Conv", "MaxPool", "BatchNormalization", "Flatten", "Softmax"}
    log(want_kinds <= set(kinds), "卷积 / 池化 / 批归一化 / Flatten / Softmax 都在",
        "缺：" + "、".join(sorted(want_kinds - set(kinds))) if want_kinds - set(kinds) else "齐了")
    log(not meta.get("errors"), "编译没有报错", "；".join(meta.get("errors") or []) or "0 条")

    # 生成源码里必须真的是那些张量算子，而不是退化成逐神经元的乘法
    for need in ("F.conv2d(", "F.max_pool2d(", "F.batch_norm(", "torch.softmax("):
        log(need in src, "生成的 PyTorch 里有 " + need, "")
    log("self.op_ptr" in src and "self._op(" in src and "def _op(" in src,
        "forward 按波次调用算子节点（不是把张量算子硬摊成神经元）")

    import torch
    x_flat = np.asarray(ref["in"], dtype=np.float32).reshape(1, -1)
    want = np.asarray(ref["out"], dtype=np.float64).reshape(-1)
    tol = float(ref.get("tol", 2e-5))

    net = load_net(py_p, bin_p, "a")
    log(int(net.num_op_nodes) == len(ops), "模块里的算子节点数与工程元数据一致",
        f"{int(net.num_op_nodes)} / {len(ops)}")

    # 参数逐位对拍：卷积核 / BN 的四个张量必须跟原模型一模一样
    pairs = expect_params(ops)
    bad = []
    n_cmp, n_par = 0, 0
    for i, pname, iname in pairs:
        k = next((j for j, p in enumerate(ops[i]["params"]) if p["name"] == pname), -1)
        if k < 0:
            bad.append(f"#{i}.{pname} 不在模块里")
            continue
        got = getattr(net, f"o{i}_p{k}")
        n_par += 1
        if not isinstance(got, torch.nn.Parameter):
            bad.append(f"#{i}.{pname} 不是可训练参数")
        if iname is None:
            continue
        a = got.detach().numpy().reshape(-1)
        r = np.asarray(inits[iname], dtype=np.float32).reshape(-1)
        n_cmp += 1
        if a.size != r.size or not np.array_equal(a, r):
            bad.append(f"#{i}.{pname}（{iname}）≠ 原模型")
    log(not bad, "算子节点的参数张量跟原模型逐位相同（卷积核没有被改过）",
        "；".join(bad) or f"比了 {n_cmp} 个张量 / 共 {n_par} 个参数")

    # 数值：定死的输入，跟 onnx.reference 的输出比
    with torch.no_grad():
        y = net(torch.tensor(x_flat))[0].numpy().reshape(-1)
    got = y.astype(np.float64)
    log(got.size == want.size, "输出个数与参考实现一致", f"{got.size} / {want.size}")
    err = float(np.max(np.abs(got - want))) if got.size == want.size else float("nan")
    log(err < tol, "前向数值与 ONNX 参考实现一致", f"最大偏差 {err:.3e}（容差 {tol:.0e}）")
    log(float(np.max(np.abs(got.sum() - 1.0))) < 1e-5, "Softmax 那一层没被漏掉（输出归一化）",
        f"和 = {float(got.sum()):.6f}")

    # ---- 往返：浏览器再编码的那份 .nforge，Python 读出来必须一模一样 ----
    o_py = nforge.read_ops(py_nforge)
    o_js = nforge.read_ops(js_nforge)
    a, b = op_fields(o_py), op_fields(o_js)
    log(len(b) == len(a) and len(a) > 0,
        "JS 写出来的文件里算子节点一个不少", f"{len(b)} / {len(a)}")
    diff = []
    for i in range(min(len(a), len(b))):
        for k in a[i]:
            if a[i][k] != b[i][k]:
                diff.append(f"#{i}.{k}")
    log(not diff, "JS 写、Python 读：算子区逐字段一致（类型 / 形状 / 落点 / 参数数值）",
        "；".join(diff[:6]) or f"比了 {len(a)} 个算子节点")
    h1, n1, e1, blk1 = nforge.read(py_nforge)
    h2, n2, e2, blk2 = nforge.read(js_nforge)
    log(len(n2) == len(n1) and len(e2) == len(e1) and np.array_equal(n2.io, n1.io),
        "JS 写、Python 读：神经元 / 连接 / 外界接口标签都一致",
        f"{len(n2)} 神经元 / {len(e2)} 连接")
    log(h2.get("counts", {}).get("opNodes") == h1.get("counts", {}).get("opNodes") and
        (h2.get("ops") or {}).get("tensors") == (h1.get("ops") or {}).get("tensors"),
        "JS 写、Python 读：文件头里的算子统计一致",
        f"opNodes {h2['counts'].get('opNodes')} / tensors {(h2.get('ops') or {}).get('tensors')}")

    # 往返之后再编译一次的那份产物：数值必须还对
    net2 = load_net(py2_p, bin2_p, "b")
    with torch.no_grad():
        y2 = net2(torch.tensor(x_flat))[0].numpy().reshape(-1).astype(np.float64)
    err2 = float(np.max(np.abs(y2 - want))) if y2.size == want.size else float("nan")
    log(err2 < tol, "往返一遍之后再编译的模型，数值仍然一致",
        f"最大偏差 {err2:.3e}")

    fails = [l for l in OUT if l.startswith("FAIL")]
    for l in OUT:
        print(l)
    print(f"\n== {len(OUT) - len(fails)} PASS / {len(fails)} FAIL ==")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())