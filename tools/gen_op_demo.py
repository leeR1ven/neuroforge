# -*- coding: utf-8 -*-
"""生成算子级（卷积这类）样例工程，给 end-to-end 对拍用。

产物（都放 prototype/ 下）：
  _opdemo.onnx       —— 源模型：Conv2d -> BN -> ReLU -> MaxPool -> Conv2d -> ReLU
                        -> Flatten -> Gemm -> Softmax，输入 1x3x8x8
  _opdemo.nforge     —— 用 tools/import_model.py 走真实导入路径写出来的工程
  _opdemo_ref.json   —— 定死的输入 + onnx.reference 跑出来的输出（数值对拍的基准）

用法： py -3 tools/gen_op_demo.py
"""
from __future__ import annotations

import base64
import json
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from onnx.reference import ReferenceEvaluator

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import import_model   # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "prototype")


def build_model():
    """一个小但"什么都有"的卷积网：两次卷积、批归一化、池化、Flatten、Gemm、Softmax。"""
    rng = np.random.default_rng(20260912)

    def nrm(*shape):
        a = rng.standard_normal(shape).astype(np.float32)
        a /= max(1.0, float(np.sqrt(np.mean(a * a))) * 3.0)
        return a

    W1 = nrm(8, 3, 3, 3)
    B1 = nrm(8)
    S1 = np.abs(nrm(8)) + 0.5
    BN1 = nrm(8)
    M1 = nrm(8)
    V1 = np.abs(nrm(8)) + 0.5
    W2 = nrm(16, 8, 3, 3)
    B2 = nrm(16)
    Wf = nrm(10, 256)
    Bf = nrm(10)

    nodes = [
        helper.make_node("Conv", ["X", "W1", "B1"], ["c1"], name="conv1",
                         pads=[1, 1, 1, 1]),
        helper.make_node("BatchNormalization", ["c1", "S1", "BN1", "M1", "V1"], ["b1"],
                         name="bn1", epsilon=1e-5),
        helper.make_node("Relu", ["b1"], ["r1"], name="relu1"),
        helper.make_node("MaxPool", ["r1"], ["p1"], name="pool1",
                         kernel_shape=[2, 2], strides=[2, 2]),
        helper.make_node("Conv", ["p1", "W2", "B2"], ["c2"], name="conv2",
                         pads=[1, 1, 1, 1]),
        helper.make_node("Relu", ["c2"], ["r2"], name="relu2"),
        helper.make_node("Flatten", ["r2"], ["f"], name="flat", axis=1),
        helper.make_node("Gemm", ["f", "Wf", "Bf"], ["g"], name="fc", transB=1),
        helper.make_node("Softmax", ["g"], ["Y"], name="sm"),
    ]
    inits = [numpy_helper.from_array(np.ascontiguousarray(v, dtype=np.float32), n)
             for n, v in (("W1", W1), ("B1", B1), ("S1", S1), ("BN1", BN1), ("M1", M1),
                          ("V1", V1), ("W2", W2), ("B2", B2), ("Wf", Wf), ("Bf", Bf))]
    graph = helper.make_graph(
        nodes, "opdemo",
        [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 3, 8, 8])],
        [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 10])], inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 9          # 本机 onnx 1.22 的参考实现只认到 9
    onnx.checker.check_model(model)
    return model


def main():
    model = build_model()
    onnx_path = os.path.join(OUT, "_opdemo.onnx")
    nforge_path = os.path.join(OUT, "_opdemo.nforge")
    ref_path = os.path.join(OUT, "_opdemo_ref.json")
    onnx.save(model, onnx_path)
    print("已写出", onnx_path, os.path.getsize(onnx_path), "字节")

    rc = import_model.main([onnx_path, "-o", nforge_path])
    if rc != 0:
        print("导入失败，rc =", rc)
        return 1
    print("已写出", nforge_path, os.path.getsize(nforge_path), "字节")

    # 定死的输入：不用随机数，Python / 浏览器两边都能复现同一组数值
    k = 3 * 8 * 8
    x = (np.arange(k, dtype=np.float32) % 17 - 8) / 8.0
    x = x.reshape(1, 3, 8, 8)
    y = ReferenceEvaluator(model).run(None, {"X": x})[0]
    ref = {
        "model": "_opdemo.onnx",
        "in_shape": list(x.shape),
        "out_shape": list(y.shape),
        "in": [float(v) for v in x.reshape(-1)],
        "out": [float(v) for v in y.reshape(-1)],
        "tol": 2e-5,
    }
    with open(ref_path, "w", encoding="utf-8") as f:
        json.dump(ref, f, ensure_ascii=False, indent=1)
    print("已写出", ref_path, os.path.getsize(ref_path), "字节")
    print("参考输出：", np.array2string(y.reshape(-1), precision=6))
    return 0


if __name__ == "__main__":
    sys.exit(main())