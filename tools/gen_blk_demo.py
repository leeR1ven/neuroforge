import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
import import_model

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(os.path.join(ROOT, "_dump"), exist_ok=True)
ONNX = os.path.join(ROOT, "_dump", "blk_demo.onnx")
NFT = os.path.join(ROOT, "prototype", "_blockdemo_raw.nforge")

rng = np.random.default_rng(7)
specs = [(96, 128, "Relu"), (128, 64, "Relu"), (64, 12, None)]
nodes, inits = [], []
prev = "X"
for i, (inf, outf, act) in enumerate(specs):
    W = ((rng.random((outf, inf)) * 2 - 1) * 0.4).astype(np.float32)
    inits.append(numpy_helper.from_array(W, f"W{i}"))
    inits.append(numpy_helper.from_array(((rng.random(outf) * 2 - 1) * 0.1).astype(np.float32), f"B{i}"))
    nodes.append(helper.make_node("Gemm", [prev, f"W{i}", f"B{i}"], [f"g{i}"], transB=1))
    cur = f"g{i}"
    if act:
        nodes.append(helper.make_node(act, [cur], [f"a{i}"]))
        cur = f"a{i}"
    prev = cur

g = helper.make_graph(nodes, "blkdemo",
                      [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 96])],
                      [helper.make_tensor_value_info(prev, TensorProto.FLOAT, [1, 12])], inits)
onnx.save(helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)]), ONNX)
print("saved", ONNX)

rc = import_model.main([ONNX, "-o", NFT, "--name", "blk_demo",
                        "--block-min", "2048", "--no-compress"])
if rc not in (0, None):
    raise SystemExit(rc)
print("sample ready:", NFT)
