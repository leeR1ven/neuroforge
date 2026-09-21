"""把 ONNX 模型折成 NeuroForge 能直接打开的 `.nforge` 工程。

设计原则（照着 README 里写死的边界来）：

* **只做确定性映射**，不认识的结构直接报错并说明是哪个算子，绝不猜。
* **按 batch=1 导入**：编辑器里是一张标量 DAG，批量维度只能展开成"复制整张网络"。
  所以输入张量除第一维外都必须是静态的，第一维（批量）按 1 处理；第一维写死成 >1
  的模型直接报错，不猜。
* **必须能把大矩阵收起来**：4096x4096 的矩阵就是 1600 万条边，远超编辑器 200 万的上限。
  所以 Gemm / MatMul 折出来的层会按 `--blocks` 决定是**收成一个权重块**（编辑器里一张热力图、
  编译时一次 matmul、不占边数）还是**展开成逐条边**（能逐权重编辑）。
  两边都放不下时**明确报错**，并说明可以用 `--prune-below` 剪枝（剪掉多少条会如实打印）。

支持折进来的算子：
    Gemm / MatMul（+ 常量 Add 当偏置） / Add（两个激活张量相加）
    Relu Sigmoid Tanh LeakyRelu Elu Gelu Silu
    Flatten Reshape Identity Squeeze Unsqueeze Dropout Transpose Cast（形状不变的直通）
    Constant
**算子节点**（算子级聚合块）：Conv / MaxPool / AveragePool / GlobalAveragePool /
    GlobalMaxPool / BatchNormalization / LayerNormalization / Softmax / LogSoftmax /
    Concat / Transpose / Reshape / Flatten / Squeeze / Unsqueeze / Add 这些逐元素算子 /
    矩阵乘 / 常见激活——它们整块记成一个节点（一个节点 = 一个算子 + 一个带形状的张量），
    编译时直接映射成 F.conv2d / F.max_pool2d / torch.softmax 这些；参数走 .nforge 的
    独立分区。算子的输出可以落到一段神经元上，好跟逐神经元的 Gemm / 权重块接起来。
其余一律报错（除非用 --allow-skip 明确点名要跳过；只放行不改元素个数的算子，跳过的会记进来源表）。

**导入不做任何静默改写**：数值类型对不上、Cast 到非 float、训练模式的 Dropout、
Conv 这类在空间上复用参数的算子——一律报错说清是哪一条，而不是"折进去看起来差不多"。
唯一允许的近似是精度（float64/float16 常量按 float32 存），这件事会逐条写进
来源表（header.source）并打印出来。

**来源表**（header["source"]）：导入是一次单向折叠——折完之后编辑器里就只剩一张标量图，
原来的算子边界没了。所以导入时把"哪个神经元区间来自哪个算子"记下来一起存进工程，
界面里能翻出一个算子级的结构视图，也能看每个神经元是从哪个节点折出来的。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np
import onnx
from onnx import AttributeProto, TensorProto, numpy_helper

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nforge  # noqa: E402

MAX_N = 500000
MAX_E = 2000000

# 与编辑器 prototype/src/main.js 保持一致：单块权重数上限、超了先切成多大的子块
BLOCK_MAX_W = 4194304
BLOCK_TILE_W = 1048576
DEF_BLOCK_MIN = 65536          # auto：权重数 >= 这个值才考虑收成块
DEF_BLOCK_DENSE = 0.5          # auto + 剪枝：非零比例低于这个值就改走稀疏边

ACT_MAP = {
    "Relu": "relu", "Sigmoid": "sigmoid", "Tanh": "tanh", "LeakyRelu": "leaky_relu",
    "Gelu": "gelu", "Elu": "elu", "Silu": "silu", "Swish": "silu",
}
PASSTHROUGH = {"Flatten", "Reshape", "Identity", "Squeeze", "Unsqueeze", "Dropout",
               "Cast", "Transpose"}

# 编辑器里只有 float32 一种数值类型。常量是这些类型时按 float32 存，并且**必须**记进来源表。
WIDENED_DTYPES = {"float64": "float64", "float16": "float16", "bfloat16": "bfloat16"}
FLOAT_TARGETS = {TensorProto.FLOAT: "float32", TensorProto.FLOAT16: "float16",
                 TensorProto.DOUBLE: "float64", TensorProto.BFLOAT16: "bfloat16"}
UNSUPPORTED_HINT = {
    # 注意：Conv / 池化 / 各种归一化 / Softmax / Concat 这些已经走 OP_WHOLE_TYPES，
    # 记成「算子节点」了，不会再落到这里；这张表只放**真的**还没实现的算子。
    "Gather": "取下标会打乱张量到神经元的对应关系，本版不支持",
}


class Unsupported(Exception):
    pass


def dtype_name(dt):
    return FLOAT_TARGETS.get(int(dt), "dtype" + str(int(dt)))


def fill_defaults(opts):
    """把块相关的开关补成默认值，老的 Namespace（测试里手搓的）也能直接调用。"""
    for k, v in (("blocks", "auto"), ("block_min", DEF_BLOCK_MIN),
                 ("block_dense", DEF_BLOCK_DENSE), ("allow_skip", ""),
                 ("layout", "ring"), ("tie_blocks", True)):
        if not hasattr(opts, k):
            setattr(opts, k, v)
    return opts


def _prod(xs):
    r = 1
    for v in xs:
        r *= int(v)
    return r


def static_count(shape, what, allow_batch=True):
    """把张量形状折成元素个数。只允许第一维是符号（当批量，按 1 处理）。"""
    dims = []
    for i, d in enumerate(shape):
        if d is None:
            if i == 0 and allow_batch:
                dims.append(1)
                continue
            raise Unsupported(f"{what} 的第 {i} 维是动态的（{shape}），"
                              f"除批量维以外都必须是静态形状")
        dims.append(int(d))
    return _prod(dims), tuple(dims)


def dims_of(vi):
    t = vi.type.tensor_type
    if not t.HasField("shape"):
        raise Unsupported(f"输入/输出 {vi.name} 没有形状信息")
    out = []
    for d in t.shape.dim:
        if d.HasField("dim_value"):
            out.append(int(d.dim_value))
        else:
            out.append(None)
    return tuple(out)


def tile_matrix(src_ids, dst_ids, W, label):
    """把 k×n 的矩阵切成若干不超过 BLOCK_TILE_W 权重的子块（尽量方正）。

    切块不只是为了绕开单块上限：块单独成段存进 .nforge，将来"只载入相机附近的部分"
    才能落到单块粒度上。切法跟编辑器里的 tileMatrix 一致。
    """
    k, n = int(W.shape[0]), int(W.shape[1])
    if k == 0 or n == 0:
        return []
    src = np.asarray(src_ids, dtype=np.uint32).reshape(-1)
    dst = np.asarray(dst_ids, dtype=np.uint32).reshape(-1)
    if k * n <= BLOCK_TILE_W:
        return [(src, dst, np.ascontiguousarray(W, dtype=np.float32))]

    ti = int(round(math.sqrt(BLOCK_TILE_W * k / n)))
    ti = max(1, min(k, ti))
    tj = max(1, min(n, BLOCK_TILE_W // ti))
    if ti * tj > BLOCK_TILE_W:
        ti = max(1, BLOCK_TILE_W // tj)
    out = []
    for i0 in range(0, k, ti):
        i1 = min(k, i0 + ti)
        for j0 in range(0, n, tj):
            j1 = min(n, j0 + tj)
            out.append((src[i0:i1], dst[j0:j1],
                        np.ascontiguousarray(W[i0:i1, j0:j1], dtype=np.float32)))
    return out


def should_block(W, opts):
    """Gemm / MatMul 折出来的一层：收成权重块，还是展开成逐条边？

    never  —— 一律展开成边（想逐权重看 / 改的小模型）
    always —— 一律收成块
    auto   —— 默认：大矩阵收成块；小矩阵，或者剪完很稀的矩阵，走逐条边
              （剪枝的用意是"要稀疏"，那就别再用一张稠密块把它装回去）
    """
    if W.size == 0:
        return False
    if opts.blocks == "never":
        return False
    if opts.blocks == "always":
        return True
    if opts.prune_below > 0:
        nz = int(np.count_nonzero(np.abs(W) >= opts.prune_below))
        return nz > W.size * opts.block_dense
    return W.size >= opts.block_min


class Group:
    """一个激活张量：ids 是它每个元素对应的神经元下标。"""
    __slots__ = ("ids", "layer")

    def __init__(self, ids, layer=None):
        self.ids = ids
        self.layer = layer          # 若这个张量正好是某一层的输出，记下来，好把激活折进去


# ==========================================================================
# 算子节点（算子级聚合块）
# --------------------------------------------------------------------------
# 卷积 / 池化 / 归一化这类算子**折不成标量神经元**：3x3、64->64 在 256x256 特征图上
# 是 420 万神经元、几亿条边，而工程的静态容量是 50 万神经元 / 200 万边。所以它们
# 原样记成一个算子节点（一个节点 = 一个算子 + 一个带形状的张量），编译时直接映射成
# F.conv2d / F.max_pool2d 这些。参数张量走 .nforge 的独立分区，不进文件头 JSON。
#
# 算子张量（OpT）跟神经元只有两条联系，都叫「落点」：
#   * 算子的输入可以读一段神经元（按声明形状 reshape），也可以读另一个算子的输出；
#   * 算子的输出可以落到一段神经元上（元素个数必须一样），也可以只当张量给下一个算子用。
# 有这两条，"算子级"和"神经元级"就能混在一张图里：Gemm 吃到卷积的输出时，先把那段
# 张量落到一段神经元上，再按老路折权重块。
# ==========================================================================
OP_WHOLE_TYPES = {
    "Conv", "MaxPool", "AveragePool", "GlobalAveragePool", "GlobalMaxPool",
    "BatchNormalization", "LayerNormalization", "Softmax", "LogSoftmax", "Concat",
    "Transpose", "Reshape", "Flatten", "Squeeze", "Unsqueeze",
    "Add", "Sub", "Mul", "Div", "MatMul",
    "Neg", "Abs", "Sqrt", "Exp", "Log",
    "Relu", "Sigmoid", "Tanh", "LeakyRelu", "Elu", "Gelu", "Silu", "Swish",
}


class OpT:
    """算子张量：某个算子节点产出的、带形状的一段数值（还没落到神经元上）。"""
    __slots__ = ("op_id", "shape")

    def __init__(self, op_id, shape):
        self.op_id = int(op_id)
        self.shape = [int(x) for x in shape]


def op_attrs(node):
    """把 ONNX 节点的属性转成一个普通 dict。认不出的类型不猜。"""
    out = {}
    for a in node.attribute:
        t = a.type
        if t == AttributeProto.INT:
            out[a.name] = int(a.i)
        elif t == AttributeProto.FLOAT:
            out[a.name] = float(a.f)
        elif t == AttributeProto.INTS:
            out[a.name] = [int(x) for x in a.ints]
        elif t == AttributeProto.FLOATS:
            out[a.name] = [float(x) for x in a.floats]
        elif t == AttributeProto.STRING:
            out[a.name] = a.s.decode("utf-8", "replace")
    return out


def static_shape(shape, what):
    """算子的张量形状：第一维（批量）可以留符号，按 1 处理；其余必须静态。"""
    out = []
    for i, d in enumerate(shape):
        if d is None:
            if i == 0:
                out.append(1)
                continue
            raise Unsupported(f"{what} 的第 {i} 维是动态的（{shape}），算子节点需要静态形状")
        out.append(int(d))
    return out


def tensor_shape(b, name, label):
    sh = value_shape(b.model, name)
    if sh is None:
        raise Unsupported(f"{label}：张量 {name} 没有静态形状信息，算子节点需要它才能定形状")
    return static_shape(sh, f"{label} 的输入 {name}")


def same_pads(in_sp, ks, strides, dil, out_sp, mode):
    """auto_pad = SAME_UPPER / SAME_LOWER 换算成显式 pads。

    ONNX 的 pads 顺序是 [每一维的起点..., 每一维的终点...]，别写成一维一组。
    """
    begins, ends = [], []
    for d in range(len(ks)):
        eff = (int(ks[d]) - 1) * int(dil[d]) + 1
        total = max(0, (int(out_sp[d]) - 1) * int(strides[d]) + eff - int(in_sp[d]))
        if mode == "SAME_UPPER":
            begins.append(total // 2)
            ends.append(total - total // 2)
        else:
            begins.append(total - total // 2)
            ends.append(total // 2)
    return begins + ends


def default_softmax_axis(model):
    """opset < 13 的 Softmax 默认 axis = 1，之后的默认 = -1。"""
    v = 13
    for oi in model.opset_import:
        if oi.domain in ("", "ai.onnx"):
            v = int(oi.version)
    return -1 if v >= 13 else 1


def norm_axis(axis, rank, label):
    a = int(axis)
    if a < 0:
        a += rank
    if a < 0 or a >= rank:
        raise Unsupported(f"{label}：axis={axis} 超出了 {rank} 维张量的范围")
    return a


OP_NAMED_IN = {
    "Conv": {1: "W", 2: "B"},
    "BatchNormalization": {1: "scale", 2: "B", 3: "mean", 4: "var"},
    "LayerNormalization": {1: "scale", 2: "B"},
}


def op_refs_for(b, ins, label, params, named=None):
    """把 ONNX 节点的输入列表转成算子节点的输入引用。

    常量会变成这个节点自己的参数（k:'c'）——这样广播（比如给 (1,C,H,W) 加一个
    (1,C,1,1) 的偏置）也能原样表达。

    named 是「这个输入位是具名参数」的映射（0 起的位置号 -> 参数名）。Conv 的核 / 偏置、
    BatchNormalization 的四个张量都落在这种位上：它们的值由带名字的参数承载（W / scale…），
    所以这里不再另存一份匿名的，否则同一份权重会在文件里存两遍。
    """
    named = named or {}
    refs = []
    for k, nm in enumerate(ins):
        if nm in b.opOut:
            t = b.opOut[nm]
            refs.append({"k": "o", "id": t.op_id, "s": 0, "shape": list(t.shape)})
        elif nm in b.groups:
            g = b.groups[nm]
            sh = tensor_shape(b, nm, label)
            refs.append({"k": "n", "ids": np.asarray(g.ids, dtype=np.uint32), "shape": sh})
        elif nm in b.consts:
            arr = np.asarray(b.consts[nm])
            if arr.ndim == 0:
                arr = arr.reshape(1)
            a32 = np.ascontiguousarray(arr, dtype=np.float32)
            name = named.get(k)
            if name is None:
                name = "c%d" % len(params)
            params.append(nforge.OpParam(name, "f32", [int(x) for x in a32.shape], a32.reshape(-1)))
            refs.append({"k": "c", "p": name, "shape": [int(x) for x in a32.shape]})
        else:
            raise Unsupported(f"{label}：输入 {nm} 既不是激活张量也不是常量")
    return refs


def build_op_node(b, node, label, ins, outs, layer_index):
    """把 ONNX 节点折成一个算子节点。返回 OpT。

    只做确定性映射：认不出的属性 / 缺参数一律报错，不猜。
    """
    op = node.op_type
    A = op_attrs(node)
    params = []
    outs = [x for x in outs if x]
    if len(outs) != 1:
        raise Unsupported(f"{label}：{op} 有 {len(outs)} 个输出，本版的算子节点只支持单输出")
    out_shape = tensor_shape(b, outs[0], label)
    refs = op_refs_for(b, ins, label, params, OP_NAMED_IN.get(op))
    attrs = {}
    note = ""

    if op == "Conv":
        x = refs[0]["shape"]
        if len(x) != 4:
            raise Unsupported(f"{label}：卷积的输入是 {x}，本版只支持 4 维 NCHW")
        Wc = b.consts.get(ins[1]) if len(ins) > 1 else None
        if Wc is None:
            raise Unsupported(f"{label}：卷积核必须是常量（初始化器）")
        W = np.ascontiguousarray(Wc, dtype=np.float32)
        ks = [int(v) for v in A.get("kernel_shape", list(W.shape[2:]))]
        strides = [int(v) for v in A.get("strides", [1] * len(ks))]
        dil = [int(v) for v in A.get("dilations", [1] * len(ks))]
        pads = [int(v) for v in A.get("pads", [0] * (2 * len(ks)))]
        auto = str(A.get("auto_pad", "NOTSET"))
        if auto in ("SAME_UPPER", "SAME_LOWER"):
            pads = same_pads(x[2:], ks, strides, dil, out_shape[2:], auto)
        refs[0]["shape"] = x
        attrs = {"strides": strides, "pads": pads, "dilations": dil,
                 "group": int(A.get("group", 1)), "kernel_shape": ks}
        note = f"卷积：输入 {x} -> 输出 {out_shape}，核 {list(W.shape)}，步长 {strides}，padding {pads}"
        if len(A.get("pads", [])) == 0 and auto in ("SAME_UPPER", "SAME_LOWER"):
            note += "（auto_pad 已按形状换算成显式 padding）"

    elif op in ("MaxPool", "AveragePool"):
        x = refs[0]["shape"]
        if len(x) != 4:
            raise Unsupported(f"{label}：{op} 的输入是 {x}，本版只支持 4 维 NCHW")
        ks = [int(v) for v in A.get("kernel_shape", [])]
        if not ks:
            raise Unsupported(f"{label}：池化没写 kernel_shape，这里不猜")
        strides = [int(v) for v in A.get("strides", ks)]
        pads = [int(v) for v in A.get("pads", [0] * (2 * len(ks)))]
        auto = str(A.get("auto_pad", "NOTSET"))
        if auto in ("SAME_UPPER", "SAME_LOWER"):
            pads = same_pads(x[2:], ks, strides, [1] * len(ks), out_shape[2:], auto)
        attrs = {"kernel_shape": ks, "strides": strides, "pads": pads,
                 "ceil_mode": int(A.get("ceil_mode", 0)),
                 "count_include_pad": int(A.get("count_include_pad", 0))}
        note = f"池化：输入 {x} -> 输出 {out_shape}，核 {ks}，步长 {strides}，padding {pads}"
        if len(node.output) > 1 and node.output[1] and b.userCount.get(node.output[1], 0) > 0:
            raise Unsupported(f"{label}：MaxPool 的第二个输出（位置索引）被后面的算子用到了，"
                              f"算子节点现在只带一个输出")
        if len(out_shape) != 4:
            raise Unsupported(f"{label}：{op} 的输出是 {out_shape}，本版只支持 4 维 NCHW")

    elif op in ("GlobalAveragePool", "GlobalMaxPool"):
        x = refs[0]["shape"]
        if len(x) != 4:
            raise Unsupported(f"{label}：{op} 的输入是 {x}，本版只支持 4 维 NCHW")
        note = f"全局池化：{x} -> {out_shape}"

    elif op == "BatchNormalization":
        need = ["scale", "B", "mean", "var"]
        for k, nm in enumerate(need):
            c = b.consts.get(ins[k + 1]) if len(ins) > k + 1 else None
            if c is None:
                raise Unsupported(f"{label}：BatchNormalization 的 {nm} 必须是常量（初始化器）")
        if len(node.output) > 1 and any(b.userCount.get(o2, 0) for o2 in node.output[1:]):
            raise Unsupported(f"{label}：BatchNormalization 有额外的输出被用到了（训练模式），"
                              f"这里只支持推理图")
        attrs = {"epsilon": float(A.get("epsilon", 1e-5))}
        note = f"批归一化（推理）：输入 {refs[0]['shape']}，eps {attrs['epsilon']}"

    elif op == "LayerNormalization":
        x = refs[0]["shape"]
        axis = norm_axis(A.get("axis", -1), len(x), label)
        ns = [int(v) for v in x[axis:]]
        attrs = {"axis": axis, "normalized_shape": ns, "epsilon": float(A.get("epsilon", 1e-5))}
        note = f"层归一化：输入 {x}，在 axis={axis} 上归一化，eps {attrs['epsilon']}"

    elif op in ("Softmax", "LogSoftmax"):
        x = refs[0]["shape"]
        axis = norm_axis(A.get("axis", default_softmax_axis(b.model)), len(x), label)
        attrs = {"axis": axis}
        note = f"{op}：在 axis={axis} 上归一化（张量形状 {x}）"

    elif op == "Concat":
        ax = A.get("axis")
        if ax is None:
            raise Unsupported(f"{label}：Concat 没写 axis，这里不猜")
        ax = norm_axis(ax, len(out_shape), label)
        attrs = {"axis": ax}
        note = f"拼接 {len(ins)} 路张量 -> {out_shape}（axis={ax}）"

    elif op == "Transpose":
        perm = [int(v) for v in A.get("perm", [])]
        if not perm:
            perm = list(reversed(range(len(out_shape))))
        if perm[0] != 0:
            raise Unsupported(f"{label}：Transpose 的 perm={perm} 把批量维挪走了，本版要求 perm[0] = 0")
        attrs = {"perm": perm}
        note = f"转置 {refs[0]['shape']} -> {out_shape}（perm={perm}）"

    elif op in ("Reshape", "Flatten", "Squeeze", "Unsqueeze"):
        attrs = {}
        if op == "Flatten":
            attrs = {"axis": int(A.get("axis", 1))}
        elif op in ("Squeeze", "Unsqueeze"):
            ax = [int(v) for v in A.get("axes", [])]
            if not ax and len(ins) > 1 and ins[1] in b.consts:
                ax = [int(v) for v in np.asarray(b.consts[ins[1]]).reshape(-1)]
            attrs = {"axes": ax}
        note = f"{op}：{[int(v) for v in refs[0]['shape']]} -> {out_shape}（只改形状，不改数值）"

    elif op in ("Add", "Sub", "Mul", "Div"):
        note = f"逐元素 {op}：{[r['shape'] for r in refs]} -> {out_shape}"
        if op in ("Sub", "Div", "Add", "Mul") and len(refs) != 2:
            raise Unsupported(f"{label}：{op} 有 {len(refs)} 路输入，本版只支持两路")

    elif op == "MatMul":
        if len(refs) != 2:
            raise Unsupported(f"{label}：MatMul 有 {len(refs)} 路输入，本版只支持两路")
        note = f"矩阵乘：{[r['shape'] for r in refs]} -> {out_shape}"

    elif op in ("Neg", "Abs", "Sqrt", "Exp", "Log"):
        note = f"{op}：{refs[0]['shape']} -> {out_shape}"

    elif op in ("Relu", "Sigmoid", "Tanh", "LeakyRelu", "Elu", "Gelu", "Silu", "Swish"):
        if op == "LeakyRelu":
            a = float(A.get("alpha", 0.01))
            if abs(a - 0.01) > 1e-9:
                raise Unsupported(f"{label}：LeakyRelu 的 alpha={a}，生成的代码固定 0.01")
        if op == "Elu":
            a = float(A.get("alpha", 1.0))
            if abs(a - 1.0) > 1e-9:
                raise Unsupported(f"{label}：Elu 的 alpha={a}，生成的代码固定 1.0")
        if op == "Gelu" and str(A.get("approximate", "")) not in ("", "none"):
            raise Unsupported(f"{label}：Gelu 的 approximate={A.get('approximate')}，生成的代码是 tanh 近似")
        name = {"Swish": "Silu"}.get(op, op)
        attrs = {"alpha": float(A.get("alpha", 0.01))} if op == "LeakyRelu" else {}
        b.note(f"{label}：{op} 落在两个算子节点之间，所以单独记成一个算子节点"
               f"（逐神经元那条路只认得神经元上的激活函数）")
        return b.add_op(name, label, refs, out_shape, params=params, attrs=attrs,
                        note=f"{op}：{refs[0]['shape']} -> {out_shape}", layer=layer_index)
    else:
        raise Unsupported(f"算子 {op}（节点 {label}）还没实现")

    return b.add_op(op, label, refs, out_shape, params=params, attrs=attrs,
                    note=note, layer=layer_index)


class Layer:
    __slots__ = ("in_ids", "out_ids", "W", "bias", "act", "kind")

    def __init__(self, in_ids, out_ids, W, bias, act=0, kind="gemm"):
        self.in_ids = in_ids
        self.out_ids = out_ids
        self.W = W                  # (K, N)
        self.bias = bias            # (N,)
        self.act = act
        self.kind = kind


class Builder:
    def __init__(self, opts):
        self.opts = opts
        self.layers = []            # 逐条边展开的层
        self.block_layers = []      # 收成权重块的层（只为了让偏置 / 激活能折进去）
        self.blocks = []            # 每个元素 {src, dst, w, label}，已经切好子块
        self.pos = []               # 每个新神经元的 (x,y,z)
        self.io = []
        self.bias = []
        self.act = []
        self.names = {}
        self.n = 0
        # ---- 来源表：折平之前的结构（折完就没了，所以边折边记） ----
        self.src = []               # 每个算子的记录
        self.spans = []             # [神经元起点, 终点, 算子序号]，按起点排好
        self.notes = []             # 给用户看的说明（自动补了什么、近似在哪）
        self.prec = {}              # 常量精度：类型 -> 数值个数
        self.precWhere = []         # 精度被截断的常量名字（最多留几个当例子）
        self.casts = []             # Cast 到别的 float 类型的节点
        self.skipped = []           # --allow-skip 跳过的算子
        self.tensorOp = {}          # 张量名 -> 产出它的算子序号（-1 = 图输入）
        # 权值共享：同一个常量被好几个算子引用。逐条边 / 权重块的模型里没有"这两处是同一个
        # 参数"这种说法，导入只能在每一处各存一份——数值一样，但改一个不会改到另一个。
        # 这件事必须说出来，不能装作没发生。
        self.tied = set()           # 被多处引用的常量名
        self.userCount = {}         # 常量名 -> 有几个算子把它当输入
        self.shared = []            # 来源表里的共享记录
        self.shareSeen = set()      # 已经记过的常量名
        # 真共享（共享参数组）：同一个常量被多处引用时，把这些引用折出来的**权重块**编成一组，
        # 组里的块在编辑器里就是同一个参数——改一处全组一起变、编译出去只存一份。
        # 只有走权重块那条路才建得成组：逐条边的层没有参数这个概念。
        self.blockShare = {}        # 共享键（常量名, k, n）-> 组号（1 起）
        self.shareGid = 0
        self.tiedBlocks = []        # 真建成的组：[(常量名, 组号, 块数, k, n, 每份权重数)]
        self.tiedCant = []          # 没建成的：[(常量名, 原因)]
        # ---- 算子节点（算子级聚合块）----
        self.opNodes = []           # 算子节点的元数据（顺序就是 id 顺序）
        self.opOut = {}             # 张量名 -> OpT（这个张量由哪个算子节点产出）
        self.landOf = {}            # 张量名 -> 落点神经元 id
        self.opRec = {}             # 算子序号 -> 来源表里的记录下标
        self.model = None           # 用来查别的张量的静态形状
        self.groups = {}            # 张量名 -> Group（神经元张量）
        self.consts = {}            # 张量名 -> 常量数组

    def note(self, msg):
        if msg not in self.notes:
            self.notes.append(msg)

    def rec(self, op, label, layer, spans, in_ops=None, note=None, **extra):
        """记一条算子来源。spans 是 [(神经元起点, 终点), ...]（终点不含）。"""
        r = {"i": len(self.src), "op": op, "n": label, "ly": int(layer)}
        out = [[int(a), int(b)] for a, b in spans if int(b) > int(a)]
        if out:
            r["out"] = out
        if in_ops:
            keep = sorted({int(x) for x in in_ops if int(x) >= 0})
            if keep:
                r["in"] = keep
        if note:
            r["nt"] = note
        r.update(extra)
        self.src.append(r)
        for a, b in out:
            self.spans.append([a, b, r["i"]])
        return r

    def fold(self, tensor, what):
        """把一次激活 / 偏置折叠挂到产出这张张量的算子记录上。"""
        i = self.tensorOp.get(tensor, -1)
        if 0 <= i < len(self.src):
            r = self.src[i]
            r.setdefault("fl", []).append(what)
            return r
        return None

    def mark(self, tensor, msg):
        """在产出这张张量的算子记录上补一句说明。"""
        i = self.tensorOp.get(tensor, -1)
        if 0 <= i < len(self.src):
            r = self.src[i]
            r["nt"] = (r.get("nt") + "；" + msg) if r.get("nt") else msg
            return r
        return None

    def use_const(self, name, arr, label):
        """常量折进图之前统一走这里：能算出数值失真就记下来，再转成 float32。"""
        a = np.asarray(arr)
        d = str(a.dtype)
        if d in WIDENED_DTYPES:
            self.prec[d] = self.prec.get(d, 0) + int(a.size)
            tag = f"{label} / {name}（{a.size:,} 个）"
            if len(self.precWhere) < 6 and tag not in self.precWhere:
                self.precWhere.append(tag)
        if name in self.tied:
            self.share(name, label)
        return np.asarray(a, dtype=np.float32)

    def share(self, name, label):
        """记一次权值共享：同一个常量被好几个算子引用。

        数值跟原模型一致（所以不算"数值失真"）。能用权重块表达的那些会真的建成共享参数组
        （见 share_group）；只有逐条边的那些才退化成"各存一份副本"。整份记录进来源表，
        翻页到「模型独有信息」能看见。
        """
        if name not in self.shareSeen:
            self.shareSeen.add(name)
            self.shared.append({"t": name, "u": int(self.userCount.get(name, 0)), "at": []})
        for e in self.shared:
            if e["t"] == name:
                if len(e["at"]) < 8 and label not in e["at"]:
                    e["at"].append(label)
                break

    def share_group(self, name, W):
        """给这个常量的权重块发一个组号（第一次遇到就新建一组）。

        键里带上逻辑形状：同一个常量在两个地方用了不同的转置，折出来的块形状就不一样。
        这时两边**不能**自动编成一组——编辑器里"共享"共享的是同一段按行主序排的数值，
        而 transB 反过来的那种用法，内存布局（列主序）跟行主序是两回事，硬编会算错。
        （界面里可以手工建组，条件是元素总数一致；手工建组的人得自己确认两边的读取顺序
        确实就是他要的那个——容器和编译端都支持形状不同、元素总数相同的共享。）
        """
        key = (str(name), int(W.shape[0]), int(W.shape[1]))
        g = self.blockShare.get(key)
        if g is None:
            self.shareGid += 1
            g = self.shareGid
            self.blockShare[key] = g
        return g

    def cant_share(self, name, why):
        """记一条"这次没能建成共享"：如实写清是哪种情况，别含糊过去。"""
        if (str(name), why) not in self.tiedCant:
            self.tiedCant.append((str(name), why))

    def finalize_sharing(self):
        """建组之后收尾：把不足两块 / 形状对不上的组退掉，再统计一遍真建成的组。

        形状对不上理论上到不了这里（切块只跟形状有关），但真到了就宁可退成各存一份，
        也不能让文件里出现"同一段数组按两种形状读"这种自相矛盾的东西。
        """
        names = {g: k[0] for k, g in self.blockShare.items()}
        # 同一个常量名下可能有不止一组：同一个张量在两处用了相反的转置时，折出来的块形状不同
        # （2×3 与 3×2），元素总数一样 —— 这种**故意不自动建组**，理由要写给用户看。
        byname = {}
        for _g, _nm in names.items():
            byname.setdefault(_nm, []).append(_g)
        cnt, shape = {}, {}
        for blk in self.blocks:
            g = int(blk.get("sg", 0))
            if not g:
                continue
            cnt[g] = cnt.get(g, 0) + 1
            shape.setdefault(g, set()).add((int(blk["src"].size), int(blk["dst"].size)))
        drop = set()
        for g, c in cnt.items():
            if c < 2:
                drop.add(g)
                nm = names.get(g, "?")
                others = [x for x in byname.get(nm, []) if x != g and cnt.get(x, 0) > 0]
                if others:
                    self.cant_share(
                        nm, "同一个张量在两处折成了形状不同的权重块（有一处转了置）：反过来的那种"
                            "用法内存里是列主序，跟编辑器『行主序读同一段数值』不是一回事，自动建组"
                            "会算错，所以这里不建。要建得在界面里框选后手工建（手工建组允许形状不同、"
                            "元素总数一致）")
                else:
                    self.cant_share(
                        nm, "这一组只折出了一个权重块，没有第二处可以共用（另一处多半折成了逐条边）")
            elif len(shape[g]) > 1:
                drop.add(g)
                self.cant_share(names.get(g, "?"),
                                "两处折出来的块形状不一样（转置用法的内存布局是列主序，"
                                "自动建组会算错，所以这里不建；要建得在界面里框选后手工建）")
        for blk in self.blocks:
            if int(blk.get("sg", 0)) in drop:
                blk["sg"] = 0
        agg = {}
        for blk in self.blocks:
            g = int(blk.get("sg", 0))
            if not g:
                continue
            a = agg.setdefault(g, {"c": 0, "k": int(blk["src"].size), "n": int(blk["dst"].size)})
            a["c"] += 1
        self.tiedBlocks = [(names.get(g, "?"), g, a["c"], a["k"], a["n"], a["c"] * a["k"] * a["n"])
                           for g, a in sorted(agg.items())]
        return self.tiedBlocks

    def add_op(self, op, label, ins, out_shape, params=None, attrs=None, fold=None,
               note="", layer=0):
        """建一个算子节点，返回它的 OpT。参数张量挂在节点上，走 .nforge 的独立分区。"""
        nid = len(self.opNodes)
        nd = {"op": op, "name": label, "ins": list(ins),
              "out": [int(x) for x in out_shape], "land": None,
              "attrs": dict(attrs or {}), "fold": list(fold or []),
              "params": list(params or []), "note": note or "", "rec": -1}
        self.opNodes.append(nd)
        r = self.rec(op, label, int(layer), [], [], note or f"算子节点 {op}", k="op")
        nd["rec"] = r["i"]
        self.opRec[nid] = r["i"]
        return OpT(nid, out_shape)

    def land_tensor(self, name, layer_index, label):
        """把一个算子张量的输出落到一段神经元上，返回那段神经元 id。

        落到神经元是"算子级"与"神经元级"之间唯一的桥：算子张量本身没有神经元，
        而逐神经元的机制（逐条边 / 权重块 / 激活折叠）只认神经元。落点神经元的值
        完全由算子写进去，不参与逐条边的求和——跟"接收外界信号"的输入接口是一个道理。
        """
        if name in self.landOf:
            return self.landOf[name]
        t = self.opOut[name]
        count = 1
        for d in t.shape:
            count *= int(d)
        if count <= 0:
            raise Unsupported(f"{label}：张量 {name} 的元素个数是 0，落不到神经元上")
        ids = self.new_neurons(count, layer_index, f"{label}_")
        self.opNodes[t.op_id]["land"] = np.asarray(ids, dtype=np.uint32)
        self.landOf[name] = ids
        self.note(
            f"{name}：这一段张量（{list(t.shape)}）是算子级节点的输出，落成了 {count:,} 个神经元，"
            f"再接逐神经元的层（Gemm / 权重块那些）。落到神经元就是「算子级」与「神经元级」的接缝："
            f"这些神经元的值由算子写入，不参与逐条边的加权求和。")
        return ids

    def new_neurons(self, count, layer_index, label):
        if self.n + count > self.opts.max_neurons:
            raise Unsupported(
                f"神经元数超过上限 {self.opts.max_neurons}（要再加 {count} 个）")
        ids = np.arange(self.n, self.n + count, dtype=np.int64)
        x = layer_index * self.opts.spacing
        layout = str(getattr(self.opts, "layout", "ring") or "ring")
        rad = 8.0 + min(count, 400) * 0.14
        cols = max(1, int(math.ceil(math.sqrt(max(count, 1) * 1.6))))
        for j in range(count):
            if layout == "line":
                y = (j - (count - 1) / 2.0) * 3.2
                self.pos.append((x, y, 0.0))
            elif layout == "grid":
                r0, c0 = divmod(j, cols)
                self.pos.append((x, (c0 - (cols - 1) / 2.0) * 6.0,
                                 (r0 - (count / cols - 1) / 2.0) * 6.0))
            else:
                ang = (2.0 * np.pi * j / count) if count else 0.0
                self.pos.append((x, float(np.cos(ang)) * rad, float(np.sin(ang)) * rad))
            self.io.append(nforge.IO_NONE)
            self.bias.append(0.0)
            self.act.append(0)
            if self.opts.names:
                self.names[int(self.n + j)] = f"{label}{j}"
        self.n += count
        return ids

    def add_dense(self, in_ids, W, bias, act, layer_index, label, as_block, const_key=None):
        """新建一层神经元，并把这一层的权重记成权重块或者逐条边的层。

        两条路只在"权重怎么存"上不同：偏置和激活都落在神经元自己的字段上，
        所以后面 Add / 激活算子照样能折进这一层。

        const_key 是这一层的权重来自哪个常量（只有常量权重才有）。给了它、又走了权重块那条路，
        同一个常量折出来的块就会被编进同一个共享参数组——这就是原模型里的 tied weights。
        """
        n_out = int(W.shape[1])
        out = self.new_neurons(n_out, layer_index, label)
        b = np.zeros(n_out, dtype=np.float32) if bias is None else \
            np.asarray(bias, dtype=np.float32).reshape(-1)
        self.bias[out[0]:out[-1] + 1] = b.tolist()
        self.act[out[0]:out[-1] + 1] = [act] * len(out)
        src = np.asarray(in_ids, dtype=np.int64).reshape(-1)
        if as_block:
            rec = Layer(src, out, None, b, act, kind="block")
            self.block_layers.append(rec)
            gid = self.share_group(const_key, W) if const_key is not None else 0
            for s, d, sub in tile_matrix(src, out, W, label):
                self.blocks.append({"src": s, "dst": d, "w": sub, "label": label, "sg": gid})
        else:
            if const_key is not None:
                self.cant_share(const_key, "这一处折成了逐条边（不是权重块），边没有同一个参数这回事")
            rec = Layer(src, out, np.asarray(W, dtype=np.float32), b, act)
            self.layers.append(rec)
        return out, rec

    def add_layer(self, in_ids, W, bias, act, layer_index, label):
        return self.add_dense(in_ids, W, bias, act, layer_index, label, False)[0]


def value_shape(model, name):
    """从图上查一张张量的静态形状（形状推断跑过之后 value_info 里就有）。"""
    g = model.graph
    for vi in list(g.input) + list(g.value_info) + list(g.output):
        if vi.name == name:
            try:
                return dims_of(vi)
            except Unsupported:
                return None
    return None


def topological_order(graph, init_names):
    """按依赖排序。导出器通常已经排好，但顺序不该靠运气。"""
    produced_by = {o: i for i, node in enumerate(graph.node) for o in node.output}
    order, state = [], {}

    def visit(i, stack):
        st = state.get(i)
        if st == 2:
            return
        if st == 1:
            raise Unsupported("模型里有环，无法折成有向无环图：" + " -> ".join(stack[-4:]))
        state[i] = 1
        node = graph.node[i]
        for name in node.input:
            j = produced_by.get(name)
            if j is not None and j != i:
                visit(j, stack + [node.op_type])
        state[i] = 2
        order.append(i)

    for i in range(len(graph.node)):
        visit(i, [graph.node[i].op_type])
    return order


def import_onnx(path, opts):
    fill_defaults(opts)
    model = onnx.load(path)
    try:
        model = onnx.shape_inference.infer_shapes(model)
    except Exception:
        pass
    graph = model.graph

    consts = {}
    for t in graph.initializer:
        consts[t.name] = numpy_helper.to_array(t)

    consumers = {}
    for node in graph.node:
        for name in node.input:
            consumers[name] = consumers.get(name, 0) + 1

    b = Builder(opts)
    # 一个初始化器被两个以上算子当输入 = 权值共享（tied weights）。这里先记下来，
    # 最后如实写进来源表（它不是数值失真，是"编辑器里表达不了同一个参数"）。
    b.userCount = consumers
    b.tied = {k for k, v in consumers.items() if v > 1 and k in consts}
    groups = {}
    b.model = model
    b.groups = groups
    b.consts = consts

    # ---- 图输入：除了初始化器之外的 graph.input 才是真正的外部输入 ----
    input_names = [vi.name for vi in graph.input if vi.name not in consts]
    if not input_names:
        raise Unsupported("这个模型没有外部输入张量，编辑器里没有能当输入接口的东西")
    layer_index = 0
    for vi in graph.input:
        if vi.name in consts:
            continue
        shape = dims_of(vi)
        # 第一维写死成 >1 的话，导入进来只会是一张对不上的图，不如直接说清楚
        if len(shape) >= 2 and shape[0] is not None and int(shape[0]) > 1:
            raise Unsupported(
                f"输入 {vi.name} 的形状是 {shape}，第一维（批量维）写死成 {int(shape[0])} 了。\n"
                f"  编辑器里是一张标量 DAG，只按 batch=1 导入：把批量维写成 1、或者留成符号维度"
                f"（batch_size / None）再导出，就能导进来。")
        count, _ = static_count(shape, f"输入 {vi.name}")
        ids = b.new_neurons(count, layer_index, f"in_{vi.name}_")
        b.io[ids[0]:ids[-1] + 1] = [nforge.IO_IN] * len(ids)
        groups[vi.name] = Group(ids)
        b.rec("Input", vi.name, 0, [(ids[0], ids[-1] + 1)], (),
              f"图输入张量 {vi.name}，静态形状 {tuple(shape)}，按 batch=1 展开成 {count} 个神经元",
              k="in")
        # 输入张量也要占一个算子序号：不然折出来的第一层在来源表里没有上游，
        # 结构视图会把「输入 → 第一层」这条边画丢（自测抓到的就是这个）
        b.tensorOp[vi.name] = len(b.src) - 1

    node_label = {}
    for node in graph.node:
        node_label[node.name or (node.output[0] if node.output else "")] = node

    skip_ops = {x.strip() for x in str(getattr(opts, "allow_skip", "") or "").split(",") if x.strip()}

    for idx in topological_order(graph, set(consts)):
        node = graph.node[idx]
        op = node.op_type
        ins = list(node.input)
        outs = list(node.output)
        label = node.name or outs[0]
        get = lambda k: (groups[ins[k]] if ins[k] in groups else None)
        getc = lambda k: (consts[ins[k]] if ins[k] in consts else None)

        if op == "Constant":
            for a in node.attribute:
                if a.name == "value":
                    consts[outs[0]] = numpy_helper.to_array(a.t)
            continue

        # ---- 只要有一路输入是算子张量（还没落到神经元上的张量），这个节点就有两种命运：
        #   (a) 它能整块表达（Conv / 池化 / Softmax…）-> 记成一个算子节点；
        #   (b) 它必须逐神经元算（Gemm / 逐元素 Add 这些）-> 先把算子张量落到一段神经元上，
        #       再按下面那些老分支折。落到神经元是两级之间唯一的桥。
        if any(x in b.opOut for x in ins):
            if (op in OP_WHOLE_TYPES) and not (op == "MatMul" and len(ins) > 1 and ins[1] in consts):
                t = build_op_node(b, node, label, ins, outs, layer_index)
                for o2 in outs:
                    if o2:
                        b.opOut[o2] = t
                        b.tensorOp[o2] = b.opRec[t.op_id]
                layer_index += 1
                continue
            for nm in list(ins):
                if nm in b.opOut:
                    ids = b.land_tensor(nm, layer_index, label)
                    groups[nm] = Group(ids)
            layer_index += 1

        if op in ("Gemm", "MatMul"):
            A, B = get(0), get(1)
            Bc, Ac = getc(1), getc(0)
            attrs = {a.name: a for a in node.attribute}
            transA = bool(attrs["transA"].i) if "transA" in attrs else False
            transB = bool(attrs["transB"].i) if "transB" in attrs else False
            if op == "MatMul":
                transA = transB = False
            alpha = float(attrs["alpha"].f) if "alpha" in attrs else 1.0
            beta = float(attrs["beta"].f) if "beta" in attrs else 1.0
            if A is None or Bc is None:
                if Ac is not None and B is not None:
                    raise Unsupported(f"{label}：常量矩阵在左、激活在右的矩阵乘需要转置语义，"
                                      f"本版只支持『激活 x 常量权重』")
                raise Unsupported(f"{label}：Gemm/MatMul 的权重必须是常量（初始化器）")
            in_n = len(A.ids)
            W = Bc.T if transB else Bc            # 逻辑形状 (K, N)
            if transA:
                # transA 时存储的 A 是 (K, M)，逻辑 A 是 (M, K)；M > 1 就是批量复制，不支持
                if W.shape[0] == 0 or in_n % W.shape[0] != 0:
                    raise Unsupported(f"{label}：transA 下的形状对不上（{A.ids.shape} / {W.shape}）")
                M = in_n // W.shape[0]
                if M != 1:
                    raise Unsupported(f"{label}：批量维是 {M}，本版按 batch=1 导入")
            if W.shape[0] != in_n:
                raise Unsupported(
                    f"{label}：权重第一维 {W.shape[0]} 与输入神经元数 {in_n} 对不上")
            W = W * alpha
            W = b.use_const(ins[1], W, f"{label} 的权重")
            bias = None
            for k in range(2, len(ins)):
                c = getc(k)
                if c is None:
                    raise Unsupported(f"{label}：Gemm 的第 {k} 个输入不是常量")
                cb = b.use_const(ins[k], c, f"{label} 的偏置").reshape(-1)
                bias = (cb * beta) if k == 2 else bias + beta * cb
            label2 = f"h{layer_index + 1}_"
            as_block = should_block(W, opts)
            nb0 = len(b.blocks)
            # 这份权重来自哪个常量：同一个常量被多处引用 = tied weights，收成块就建成共享参数组。
            # alpha != 1 的那几处被整体缩放过，值已经不是一个参数了，不参与共享。
            const_key = None
            if getattr(opts, "tie_blocks", True) and ins[1] in b.tied and alpha == 1.0:
                const_key = ins[1]
            out_ids, rec = b.add_dense(A.ids, W, bias, 0, layer_index + 1, label2, as_block, const_key)
            layer_index += 1
            groups[outs[0]] = Group(out_ids, rec)
            nblk = len(b.blocks) - nb0
            b.rec(op, label, layer_index, [(out_ids[0], out_ids[-1] + 1)],
                  [b.tensorOp.get(ins[0], -1)],
                  (f"整层权重收成 {nblk} 段权重块（{int(W.size):,} 个权重）："
                   f"编辑器里是一块可编辑的热力图板，不用逐条连线画出来") if as_block else None,
                  w=int(W.size), blk=nblk)
            b.tensorOp[outs[0]] = len(b.src) - 1
            continue

        if op == "Add":
            G0, G1 = get(0), get(1)
            C0, C1 = getc(0), getc(1)
            if G0 is not None and G1 is not None:
                if len(G0.ids) != len(G1.ids):
                    raise Unsupported(f"{label}：两个激活张量长度不一样，本版不支持广播相加")
                K = len(G0.ids)
                W = np.zeros((2 * K, K), dtype=np.float32)
                W[np.arange(K), np.arange(K)] = 1.0
                W[K + np.arange(K), np.arange(K)] = 1.0
                src = np.concatenate([G0.ids, G1.ids])
                out_ids = b.add_layer(src, W, None, 0, layer_index + 1, f"add{layer_index + 1}_")
                layer_index += 1
                groups[outs[0]] = Group(out_ids, b.layers[-1])
                b.rec("Add", label, layer_index, [(out_ids[0], out_ids[-1] + 1)],
                      [b.tensorOp.get(x, -1) for x in ins[:2]],
                      "两个激活张量相加：折成一层系数 1.0 的求和层（不是偏置相加）")
                b.tensorOp[outs[0]] = len(b.src) - 1
                continue
            G, C = (G0, C1) if G0 is not None else (G1, C0)
            act_in = ins[0] if G0 is not None else ins[1]
            if G is None:
                consts[outs[0]] = (b.use_const(ins[0], C0, f"{label} 的常量加数") +
                                   b.use_const(ins[1], C1, f"{label} 的常量加数"))
                continue
            cidx = 1 if G0 is not None else 0
            bias = b.use_const(ins[cidx], C, f"{label} 的常量加数").reshape(-1)
            # 只有"这一层的输出只被这一个 Add 用"时才能把偏置折进层里；否则别的分支
            # 也会跟着变，那就得老老实实再开一层
            if G.layer is None or consumers.get(act_in, 0) != 1:
                K = len(G.ids)
                out_ids = b.add_layer(G.ids, np.eye(K, dtype=np.float32), bias, 0,
                                      layer_index + 1, f"bias{layer_index + 1}_")
                layer_index += 1
                groups[outs[0]] = Group(out_ids, b.layers[-1])
                b.rec("Add", label, layer_index, [(out_ids[0], out_ids[-1] + 1)],
                      [b.tensorOp.get(act_in, -1)],
                      "激活张量 + 常量：折成一层系数 1.0 的层，常量落在偏置上")
                b.tensorOp[outs[0]] = len(b.src) - 1
            else:
                G.layer.bias = G.layer.bias + bias
                b.fold(act_in, f"{label}：常量偏置折进这一层")
                b.tensorOp[outs[0]] = b.tensorOp.get(act_in, -1)
                # 折进层里之后必须同步回平铺数组——build_arrays 读的是 b.bias，
                # 只改 layer.bias 的话导出文件里偏置还是 0（MatMul+Add 就是这么错的）
                b.bias[G.ids[0]:G.ids[-1] + 1] = G.layer.bias.tolist()
                groups[outs[0]] = Group(G.ids, G.layer)
            continue

        if op in ACT_MAP:
            G = get(0)
            if G is None:
                raise Unsupported(f"{label}：激活函数的输入不是激活张量")
            attrs = {a.name: a for a in node.attribute}
            if op == "LeakyRelu":
                a = float(attrs["alpha"].f) if "alpha" in attrs else 0.01
                if abs(a - 0.01) > 1e-9:
                    raise Unsupported(
                        f"{label}：LeakyRelu 的 alpha={a}，但编辑器里的 leaky_relu 固定是 0.01；"
                        f"悄悄换成 0.01 会改变模型数值，所以这里直接报错")
            if op == "Elu":
                a = float(attrs["alpha"].f) if "alpha" in attrs else 1.0
                if abs(a - 1.0) > 1e-9:
                    raise Unsupported(f"{label}：Elu 的 alpha={a}，编辑器里固定是 1.0")
            if op == "Gelu":
                approx = ""
                for at in node.attribute:
                    if at.name == "approximate":
                        approx = at.s.decode()
                if approx not in ("", "none"):
                    raise Unsupported(
                        f"{label}：Gelu 用的是 approximate={approx}，编辑器里的 gelu 是精确版（erf）")
            code = nforge.ACT_NAMES.index(ACT_MAP[op])
            if G.layer is not None and consumers.get(ins[0], 0) == 1 and G.layer.act == 0:
                G.layer.act = code
                b.act[G.ids[0]:G.ids[-1] + 1] = [code] * len(G.ids)
                groups[outs[0]] = G
                b.fold(ins[0], ACT_MAP[op])
                b.tensorOp[outs[0]] = b.tensorOp.get(ins[0], -1)
            else:
                K = len(G.ids)
                out_ids = b.add_layer(G.ids, np.eye(K, dtype=np.float32), None, code,
                                      layer_index + 1, f"{op.lower()}{layer_index + 1}_")
                layer_index += 1
                groups[outs[0]] = Group(out_ids, b.layers[-1])
                b.rec(op, label, layer_index, [(out_ids[0], out_ids[-1] + 1)],
                      [b.tensorOp.get(ins[0], -1)],
                      "这一层的输入被多处用到，所以激活单开一层（系数 1.0）")
                b.tensorOp[outs[0]] = len(b.src) - 1
            continue

        if op in PASSTHROUGH:
            G = get(0)
            if G is None:
                consts[outs[0]] = np.asarray(consts[ins[0]])
                continue
            ids = G.ids
            if op == "Transpose":
                shape = G.shape if hasattr(G, "shape") else None
                raise Unsupported(f"{label}：激活张量上的 Transpose 需要静态形状才能重排，本版不支持")
            if op == "Reshape":
                c = getc(1)
                if c is None:
                    raise Unsupported(f"{label}：Reshape 的目标形状不是常量")
                want = _prod([d for d in np.asarray(c).reshape(-1).tolist() if int(d) > 0])
                if want and want != len(ids):
                    raise Unsupported(f"{label}：Reshape 改了元素个数（{len(ids)} -> {want}）")
            if op == "Cast":
                to = None
                for a in node.attribute:
                    if a.name == "to":
                        to = int(a.i)
                if to is None:
                    raise Unsupported(f"{label}：Cast 没写目标类型，这里不猜")
                if to not in FLOAT_TARGETS:
                    raise Unsupported(
                        f"{label}：Cast 把数据转成 {dtype_name(to)}。编辑器里的神经元只有 float32 "
                        f"一种数值类型，转成整数 / 布尔是另一套语义（截断、比较），折进来会悄悄"
                        f"改变后面的取值，所以直接报错。")
                if to != TensorProto.FLOAT:
                    b.casts.append({"n": label, "to": dtype_name(to)})
                    b.note(f"{label}：原模型把数据转成 {dtype_name(to)} 再往后算；编辑器全程按 "
                           f"float32 计算——精度只会更高，但逐位结果和原模型会有极小差异。")
            if op == "Dropout":
                tm = 0
                for a in node.attribute:
                    if a.name == "training_mode":
                        tm = int(a.i)
                if tm:
                    raise Unsupported(
                        f"{label}：Dropout 的 training_mode=1（训练模式）。它按随机掩码丢掉一部分"
                        f"激活值，不是恒等变换，编辑器里没有这个语义。用 model.eval() 导出成推理图"
                        f"（training_mode=0）就能导进来。")
            b.mark(ins[0], f"{op} 直通（形状没变）")
            groups[outs[0]] = Group(ids, G.layer)
            b.tensorOp[outs[0]] = b.tensorOp.get(ins[0], -1)
            continue

        if op in skip_ops:
            act_ins = [k for k in range(len(ins)) if ins[k] in groups]
            if len(act_ins) != 1:
                raise Unsupported(
                    f"{label}：--allow-skip 点到了 {op}，但这个节点有 {len(act_ins)} 个激活张量输入"
                    f"（其余是常量）。跳过它不只是丢掉这个算子，还会丢掉张量本身，"
                    f"折出来的图是错的，所以不能跳。")
            G = groups[ins[act_ins[0]]]
            shape_out = value_shape(model, outs[0])
            want = _prod([d for d in shape_out if d is not None]) if shape_out else None
            if want and want != len(G.ids):
                raise Unsupported(
                    f"{label}：跳过 {op} 会把元素个数从 {len(G.ids)} 变成 {want}，后面的层就对不上了"
                    f"——这么跳折出来的图是错的，所以不能跳。")
            b.skipped.append({"op": op, "n": label,
                              "why": "用户用 --allow-skip 明确要求跳过"})
            b.note(f"{label}：按 --allow-skip 跳过了 {op}。这一段之后的数值不再等价于原模型，"
                   f"编译出来的东西只能当结构参考。")
            b.rec(op, label, layer_index, [], [b.tensorOp.get(ins[0], -1)],
                  f"按 --allow-skip 跳过（{op}）：这一段的数值不再等价于原模型", skip=True, k="skip")
            b.tensorOp[outs[0]] = b.tensorOp.get(ins[0], -1)
            groups[outs[0]] = G
            continue

        # 前面那些分支只管"逐神经元"的算子。剩下这些能整块表达的（池化 / Softmax /
        # Concat…）在这里记成算子节点——输入既可以是算子张量，也可以直接是神经元。
        if op in OP_WHOLE_TYPES:
            t = build_op_node(b, node, label, ins, outs, layer_index)
            for o2 in outs:
                if o2:
                    b.opOut[o2] = t
                    b.tensorOp[o2] = b.opRec[t.op_id]
            layer_index += 1
            continue

        why = UNSUPPORTED_HINT.get(op)
        raise Unsupported(f"算子 {op}（节点 {label}）还没实现" + (f"：{why}" if why else ""))

    # ---- 图输出：标成对外接口 ----
    out_ids = []
    both = 0
    for vi in graph.output:
        if vi.name in b.opOut:
            # 算子张量当输出：先落到一段神经元上，再标成「输出到外界」。
            # 编译出来的模型必须返回一个神经元张量，算子张量本身不是——所以这里是必须的一步。
            ids = b.land_tensor(vi.name, layer_index, f"out_{vi.name}")
            groups[vi.name] = Group(ids)
            b.note(f"输出 {vi.name} 是算子节点的结果，已经落到 {len(ids):,} 个神经元上并标成"
                   f"「输出到外界」——编译出来的模型返回的是这一段。")
        if vi.name in groups:
            g = groups[vi.name]
            seg = b.io[g.ids[0]:g.ids[-1] + 1]
            b.io[g.ids[0]:g.ids[-1] + 1] = [
                (nforge.IO_BOTH if v == nforge.IO_IN else nforge.IO_OUT) for v in seg]
            both += sum(1 for v in seg if v == nforge.IO_IN)
            out_ids.append(g.ids)
        elif vi.name in consts:
            continue
        else:
            raise Unsupported(f"输出 {vi.name} 不是任何一层的结果")
    if not out_ids:
        raise Unsupported("这个模型没有能当输出接口的张量")
    b.out_ids = out_ids            # 按 graph.output 的顺序，校验脚本要用
    b.input_names = input_names
    b.finalize_sharing()           # 共享组的收尾必须在写说明之前，说明里要报真建成了几组

    if both:
        b.note(f"有 {both} 个神经元既在图输入里又在图输出里（直通模型）：它们的接口标记是"
               f"『输入 + 输出』，两个方向都算。")
    if b.opts.names:
        b.note(f"神经元名字是自动补的：原模型里没有『神经元』这个概念，这里按『算子 + 序号』"
               f"编号（名字表可以关掉：--no-names）。")
    b.note(f"坐标是按拓扑自动铺的（布局 {getattr(b.opts, 'layout', 'ring')}）：每一层沿 X 轴分开"
           f"（间距 {b.opts.spacing}），层内按布局铺开。ONNX 里没有坐标，这部分一定是生成出来的；"
           f"想换形状可以在界面里用『按拓扑重排 / 力导向排布』重排。")
    if b.prec:
        parts = "、".join(f"{k} {v:,} 个" for k, v in sorted(b.prec.items()))
        b.note(f"精度：折进来的常量里有 {parts} 不是 float32（文件名里带的原始类型）。编辑器只有 "
               f"float32，所以一律按 float32 存——float64 的位数在这里被截断，float16 / bfloat16 "
               f"本身能无损放进 float32，但计算全程按 float32 做。例子：" + "；".join(b.precWhere))
    if b.casts:
        names = "、".join(f"{c['n']}→{c['to']}" for c in b.casts[:6])
        b.note(f"有 {len(b.casts)} 处 Cast 转成了别的 float 类型（{names}）：按 float32 计算，"
               f"不再复现原模型的降精度步骤。")
    if b.blocks:
        b.note(f"有 {len(b.blocks)} 段权重块（{sum(int(x['w'].size) for x in b.blocks):,} 个权重）："
               f"块是稠密矩阵，编辑器里按热力图板显示、编译时是一次矩阵乘，不占逐条连线的额度。"
               f"卷积（Conv 这类）不再报错了：它记成**算子节点**（见下面的算子节点那一段），"
               f"编译时直接是一句 F.conv2d，不占逐条连线的额度。能接受『数值不再等价』的话"
               f"也可以用 --allow-skip 点名跳过——"
               f"但它会改元素个数，所以这里会被拒绝；只有不改元素个数的算子跳得成，跳过的会记在这里。")
    if b.shared:
        names = "、".join(f"{e['t']}（{e['u']} 处）" for e in b.shared[:6])
        txt = f"原模型里有 {len(b.shared)} 个权重张量是多处共用的（权值共享 / tied weights）：{names}。"
        if b.tiedBlocks:
            got = "、".join(f"{t[0]} → {t[2]} 块 {t[3]}×{t[4]}" for t in b.tiedBlocks[:6])
            txt += (f"导入器把它们折出来的权重块建成了 {len(b.tiedBlocks)} 组『共享参数组』（{got}）："
                    f"组里的块共用同一份参数——改一处全组一起变，编译出去只存一份，"
                    f"反向传播的梯度累加到同一段上。数值与原模型一致。（不想建组：--no-tie-blocks。）")
        if b.tiedCant:
            why = "；".join(f"{n}：{w}" for n, w in b.tiedCant[:4])
            txt += f"有几处没能建成共享，原因如实写在这里：{why}。"
        if not b.tiedBlocks:
            txt += "这几处这次都没折出可以共用的权重块（多半走了逐条边）。"
        rest = [e["t"] for e in b.shared if e["t"] not in {t[0] for t in b.tiedBlocks}]
        if rest:
            txt += ("另外 " + "、".join(rest[:6]) + " 没能建成共享组，那部分仍然是各存一份副本——"
                    "逐条边没有『同一个参数』这种说法。")
        b.note(txt)

    # ---- 算子节点的来源表收尾：落点区间（结构视图靠它把算子接回神经元）、上游算子 ----
    for nd in b.opNodes:
        r = b.src[nd["rec"]]
        L = nd["land"]
        if L is not None and int(np.size(L)):
            a, bnd = int(np.min(L)), int(np.max(L)) + 1
            r["out"] = [[a, bnd]]
            b.spans.append([a, bnd, nd["rec"]])
        ins_ops = []
        for ref in nd["ins"]:
            if ref["k"] == "o":
                ins_ops.append(int(ref["id"]))
        if ins_ops:
            r["in"] = sorted(set(ins_ops))
    if b.opNodes:
        bytes_all = sum(int(p.nbytes) for nd in b.opNodes for p in nd["params"])
        kinds = {}
        for nd in b.opNodes:
            kinds[nd["op"]] = kinds.get(nd["op"], 0) + 1
        top = "、".join(f"{k}×{v}" for k, v in sorted(kinds.items(), key=lambda x: -x[1])[:8])
        b.note(
            f"有 {len(b.opNodes)} 个**算子节点**（{top}）：卷积 / 池化 / 归一化 / Softmax 这类"
            f"「在空间上复用参数」或「整层归一化」的算子折不成标量神经元（一层就是几十万到上千万个"
            f"神经元、上亿条边），所以原样记成一个节点——一个节点 = 一个算子 + 一个带形状的张量，"
            f"编译时直接映射成 F.conv2d / F.max_pool2d / torch.softmax 这些。"
            f"参数张量共 {bytes_all:,} 字节，走 .nforge 的独立分区（不进文件头 JSON）。"
            + ("其中有 " + str(len(b.landOf)) + " 段算子输出落到了神经元上（算子级与神经元级的接缝）。"
               if b.landOf else ""))

    b.spans.sort(key=lambda x: (x[0], x[1]))
    b.source = {
        "format": 1,
        "kind": "onnx",
        "generator": "NeuroForge import_model.py",
        "model": os.path.basename(str(getattr(b.opts, "model", "") or "")),
        "exact": not b.skipped,
        "auto": {"names": bool(b.opts.names), "positions": True,
                 "layout": getattr(b.opts, "layout", "ring"),
                 "spacing": float(b.opts.spacing)},
        "layerCount": int(layer_index + 1),
        "nodes": b.src,
        "spans": b.spans,
        "notes": b.notes,
        "skipped": b.skipped,
        "casts": b.casts,
        "shared": b.shared,
        "precision": {"weights": b.prec, "examples": b.precWhere},
        "counts": {"ops": len(b.src), "spans": len(b.spans), "skipped": len(b.skipped),
                   "shared": len(b.shared),
                   "blocks": len(b.blocks),
                   "blockWeights": sum(int(x["w"].size) for x in b.blocks),
                   "opNodes": len(b.opNodes),
                   "opParams": sum(int(p.nbytes) for nd in b.opNodes for p in nd["params"]),
                   "opLanded": len(b.landOf)},
    }

    return b, layer_index


def build_ops(b):
    """把 Builder 里攒下的算子节点转成 nforge.Ops（参数张量一起带上）。"""
    if not b.opNodes:
        return None
    out = []
    for i, nd in enumerate(b.opNodes):
        out.append(nforge.OpNode(
            op=nd["op"], name=nd["name"], ins=[dict(r) for r in nd["ins"]],
            out=list(nd["out"]), land=nd["land"], attrs=dict(nd["attrs"]),
            fold=list(nd["fold"]), params=list(nd["params"]), note=nd["note"], id=i))
    return nforge.Ops(list=out)


def build_arrays(b, opts):
    """把 Builder 里攒下的东西转成 nforge 的三个数组。

    返回 (神经元, 逐条边的连接, 权重块或 None, 边数)。
    """
    n = b.n
    pos = np.asarray(b.pos, dtype=np.float32).reshape(-1, 3)
    neu = nforge.Neurons(
        pos=pos,
        io=np.asarray(b.io, dtype=np.uint8),
        bias=np.asarray(b.bias, dtype=np.float32),
        act=np.asarray(b.act, dtype=np.uint8),
    )
    fill_defaults(opts)

    # 剪枝：逐条边那部分照旧把小权重整条丢掉；收成块的矩阵丢不掉条目，
    # 只能把权重置零（零仍然占着块空间，所以这会如实打印出来）。
    total_edges = sum(l.W.size for l in b.layers)
    if opts.prune_below > 0:
        for l in b.layers:
            mask = np.abs(l.W) < opts.prune_below
            l.pruned = int(mask.sum())
            l.W = np.where(mask, 0.0, l.W)
        for blk in b.blocks:
            mask = np.abs(blk["w"]) < opts.prune_below
            blk["pruned"] = int(mask.sum())
            blk["w"] = np.where(mask, 0.0, blk["w"]).astype(np.float32)
        total_edges = sum(int(np.count_nonzero(l.W)) for l in b.layers)
    if total_edges > opts.max_edges:
        raise Unsupported(
            f"折出来是 {total_edges:,} 条边，超过编辑器上限 {opts.max_edges:,}。\n"
            f"  逐条边画出来的上限就这么大——4096x4096 的矩阵是 1600 万条边。\n"
            f"  可以：1) 让大矩阵走权重块：--blocks always（或调小 --block-min 的门槛），\n"
            f"        块在编辑器里是一张热力图板、编译时是一次 matmul，不占边数；\n"
            f"        2) 用 --prune-below X 剪掉 |w| < X 的边（会改变模型，剪掉多少条会打印）；\n"
            f"        3) 换更小的模型。")

    srcs, dsts, ws = [], [], []
    for l in b.layers:
        W = l.W
        if opts.prune_below > 0:
            k_idx, n_idx = np.nonzero(W)
            if len(k_idx) == 0:
                continue
            srcs.append(l.in_ids[k_idx])
            dsts.append(l.out_ids[n_idx])
            ws.append(W[k_idx, n_idx])
        else:
            K, N = W.shape
            srcs.append(np.repeat(l.in_ids, N))
            dsts.append(np.tile(l.out_ids, K))
            ws.append(W.reshape(-1))
    if not srcs:
        edg = nforge.Edges(src=np.zeros(0, np.uint32), dst=np.zeros(0, np.uint32),
                           w=np.zeros(0, np.float32))
    else:
        edg = nforge.Edges(src=np.concatenate(srcs).astype(np.uint32),
                           dst=np.concatenate(dsts).astype(np.uint32),
                           w=np.concatenate(ws).astype(np.float32))

    blk = None
    if b.blocks:
        ks = np.asarray([blk0["src"].size for blk0 in b.blocks], dtype=np.uint32)
        ns = np.asarray([blk0["dst"].size for blk0 in b.blocks], dtype=np.uint32)
        # 共享参数组号：>0 表示这一组共用同一份权重（文件里只存第一份，其余靠引用表指过去）。
        # 这一步不依赖 build_arrays 的其它分支，所以先在这里统一收一次尾。
        b.finalize_sharing()
        sgs = np.asarray([int(blk0.get("sg", 0)) for blk0 in b.blocks], dtype=np.uint32)
        blk = nforge.Blocks(
            ks=ks, ns=ns,
            src=np.concatenate([blk0["src"] for blk0 in b.blocks]),
            dst=np.concatenate([blk0["dst"] for blk0 in b.blocks]),
            w=np.concatenate([blk0["w"].reshape(-1) for blk0 in b.blocks]),
            sg=sgs,
        )
    return neu, edg, blk, total_edges


def main(argv=None):
    ap = argparse.ArgumentParser(description="把 ONNX 模型折成 .nforge 工程")
    ap.add_argument("model", help="输入 .onnx")
    ap.add_argument("-o", "--out", help="输出 .nforge（默认与输入同名）")
    ap.add_argument("--name", default=None, help="工程名（默认用文件名）")
    ap.add_argument("--chunk-neurons", type=int, default=nforge.DEFAULT_CHUNK_NEURONS,
                    help=f"每块的神经元数上限（默认 {nforge.DEFAULT_CHUNK_NEURONS}）")
    ap.add_argument("--max-neurons", type=int, default=MAX_N)
    ap.add_argument("--max-edges", type=int, default=MAX_E)
    ap.add_argument("--prune-below", type=float, default=0.0,
                    help="丢掉 |w| 小于该值的边（默认 0 = 不剪枝）")
    ap.add_argument("--blocks", choices=("auto", "always", "never"), default="auto",
                    help="Gemm/MatMul 折出来的权重怎么存：auto=大矩阵收成块（默认）、"
                         "always=一律收成块、never=一律展开成逐条边")
    ap.add_argument("--block-min", type=int, default=DEF_BLOCK_MIN,
                    help=f"auto 下权重数达到多少就收成块（默认 {DEF_BLOCK_MIN}）")
    ap.add_argument("--block-dense", type=float, default=DEF_BLOCK_DENSE,
                    help=f"auto + 剪枝时，非零比例高于多少才收成块（默认 {DEF_BLOCK_DENSE}）")
    ap.add_argument("--spacing", type=float, default=26.0, help="层与层之间的间距")
    ap.add_argument("--layout", choices=("ring", "line", "grid"), default="ring",
                    help="层内神经元怎么铺：ring=围一圈（默认，圆的）、line=一条直线、"
                         "grid=网格。ONNX 里没有坐标，这一段一定是生成出来的")
    ap.add_argument("--allow-skip", default="",
                    help="明确点名要跳过的算子，逗号分隔（例如 Conv,MaxPool）。跳过的算子会写进"
                         "来源表：数值不再等价于原模型，只能当结构参考。默认一个都不跳，"
                         "遇到不认识的算子直接报错")
    ap.add_argument("--report", default=None,
                    help="把导入报告写成 JSON（来源表 / 精度 / 跳过的算子都在里面）")
    ap.add_argument("--no-names", dest="names", action="store_false",
                    help="不写神经元名称表（大模型能省下不少文件头体积）")
    ap.add_argument("--no-tie-blocks", dest="tie_blocks", action="store_false",
                    help="不把 tied weights 建成共享参数组（默认建：同一个权重张量被多处引用时，"
                         "收成权重块的那些会共用同一份参数，改一处全组一起变、文件里只存一份）")
    ap.add_argument("--order", choices=("linear", "spatial"), default="linear",
                    help="linear=按算子顺序（默认）；spatial=按空间 Z 序切块，"
                         "界面上靠近哪块才解压哪块（大模型漫游更省内存）")
    ap.add_argument("--no-compress", dest="compress", action="store_false")
    ap.set_defaults(names=True, compress=True, tie_blocks=True)
    opts = ap.parse_args(argv)

    out = opts.out or os.path.splitext(opts.model)[0] + ".nforge"
    name = opts.name or os.path.splitext(os.path.basename(opts.model))[0]
    b, layers = import_onnx(opts.model, opts)
    neu, edg, blk, edges_kept = build_arrays(b, opts)
    ops = build_ops(b)
    if len(neu) > opts.max_neurons:
        raise Unsupported(f"神经元数 {len(neu):,} 超过上限 {opts.max_neurons:,}")
    if len(neu) == 0:
        raise Unsupported("这个模型没折出任何神经元")

    names = b.names if opts.names else {}
    info = nforge.write(out, neu, edg, name=name, chunk_neurons=opts.chunk_neurons,
                        names=names, compress=opts.compress, blocks=blk,
                        order=opts.order, source=b.source, ops=ops)

    bad = nforge.check_index(info["header"])
    if bad:
        raise RuntimeError("索引表自检没过：" + "；".join(bad))

    pruned = sum(getattr(l, "pruned", 0) for l in b.layers)
    print(f"已导入 {opts.model}")
    print(f"  层数        {layers + 1}（含输入层）")
    print(f"  神经元      {len(neu):,}")
    print(f"  连接        {len(edg):,}")
    if opts.prune_below > 0:
        print(f"  剪掉的边    {pruned:,}（|w| < {opts.prune_below}）")
    if blk is not None and len(blk):
        rows, cols = int(blk.ks.sum()), int(blk.ns.sum())
        print(f"  权重块      {len(blk)} 块 / {blk.total_weights:,} 个权重"
              f"（{rows:,} 行 × 列共 {cols:,} 个终点）")
        if opts.prune_below > 0:
            bpruned = sum(getattr(x, "pruned", 0) for x in b.blocks)
            if bpruned:
                print(f"  块内置零    {bpruned:,} 个（块是稠密的，置零的权重仍然占块空间）")
    print(f"  分块        {len(info['header']['chunks'])} 块"
          f"（每块 ≤ {opts.chunk_neurons:,} 神经元）")
    print(f"  文件        {out}  {info['bytes'] / 1024:.0f} KB")
    n_io = int((neu.io == nforge.IO_IN).sum())
    n_out = int((neu.io == nforge.IO_OUT).sum())
    n_both = int((neu.io == nforge.IO_BOTH).sum())
    print(f"  外界接口    {n_io} 输入 / {n_out} 输出" +
          (f"（其中 {n_both} 个既当输入又当输出）" if n_both else ""))
    print("  导入报告    已写进工程文件头，界面上『文件 → 导入报告』可以翻出来"
          f"（来源表 {len(b.source['nodes'])} 条 / {len(b.source['spans'])} 段"
          + (f" / 算子节点 {len(b.opNodes)} 个" if b.opNodes else "") + "）")
    if b.shared:
        head = f"  权值共享    {len(b.shared)} 个常量被多处共用"
        if b.tiedBlocks:
            head += f"，已建成 {len(b.tiedBlocks)} 组共享参数组（改一处全组一起变）："
        else:
            head += "，这次没折出可以共用的权重块："
        print(head + "、".join(f"{e['t']}×{e['u']}" for e in b.shared[:8]))
        for nm, g, c, k, n, w in b.tiedBlocks[:6]:
            print(f"              · 组 #{g} {nm}：{c} 块 {k}×{n}，共用 {w:,} 个权重，省下 {(c - 1) * w:,} 个")
        for nm, why in b.tiedCant[:4]:
            print(f"              · 没建成：{nm} —— {why}")
    if b.skipped:
        print(f"  跳过的算子  {len(b.skipped)} 个（数值不再等价于原模型）：" +
              "、".join(f"{s['op']}@{s['n']}" for s in b.skipped[:8]))
    for nt in b.notes:
        print(f"  · {nt}")
    if opts.report:
        with open(opts.report, "w", encoding="utf-8") as f:
            json.dump({"counts": {"neurons": len(neu), "edges": len(edg)},
                       "blocks": 0 if blk is None else len(blk),
                       "layers": layers + 1, "file": out,
                       "source": b.source}, f, ensure_ascii=False, indent=1)
        print(f"  报告文件    {opts.report}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Unsupported as e:
        print(f"无法导入：{e}", file=sys.stderr)
        sys.exit(2)
