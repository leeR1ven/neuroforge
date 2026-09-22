"""验证 ONNX 导入器：结构自检 + 数值等价 + 分块行为 + 明确报错。

数值那一块是重点：把 ONNX 模型用 onnx 自带的 ReferenceEvaluator 跑一遍，
再把导入出来的 `.nforge` 读回来、按编辑器编译产物的同一套语义
（h_i = act(bias_i + Σ w_e·h_src)）前向一遍，两边必须对得上。
只对结构不对数值的话，"折对了没"其实是没验证的。
"""
from __future__ import annotations

import os
import sys
import tempfile
from collections import deque

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from onnx.reference import ReferenceEvaluator
from onnx.reference.op_run import OpRun

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nforge              # noqa: E402
import import_model        # noqa: E402

rng = np.random.default_rng(20260911)
OUT = []


def log(ok, name, detail=""):
    OUT.append(("PASS" if ok else "FAIL") + " | " + name + " | " + str(detail))


# ---------------------------------------------------------------- 前向求值
def _sigmoid(t):
    return 1.0 / (1.0 + np.exp(-t))


def _ref_erf(t):
    from math import erf, sqrt

    return np.vectorize(erf)(np.asarray(t, dtype=np.float64) / sqrt(2.0))


def gelu_tanh(t):
    """编辑器里的 gelu：F.gelu(..., approximate="tanh")。

    常数跟 main.js 里那串（生成 Python / C 与编辑器模拟用的）逐字一致，
    否则"导入后的图和编辑器算的一样"这句就是空的。
    """
    return 0.5 * t * (1.0 + np.tanh(0.7978845608028654 * (t + 0.044715 * t * t * t)))


class Gelu(OpRun):
    """onnx 1.22 的参考实现里没有 Gelu（opset 20 才进标准），这里补上。

    照 ONNX 的语义分两种：approximate 缺省或 "none" 是精确 erf 版；"tanh" 是近似版。
    编辑器里的 gelu 固定是 tanh 近似（激活码 5），所以对拍模型写成 approximate="tanh"；
    "none" 那种能导进来，但导入器会把它记成「数值近似」（见 verify_audit_import.py）。
    """

    op_domain = ""

    def _run(self, x, approximate=None):
        x = np.asarray(x, dtype=np.float64)
        a = "" if approximate in (None, "") else str(approximate)
        if a in ("", "none"):
            return (0.5 * x * (1.0 + _ref_erf(x)),)
        if a == "tanh":
            return (gelu_tanh(x),)
        raise ValueError(f"参考实现不认 Gelu 的 approximate={approximate}")


class Silu(OpRun):
    """Silu（=Swish）和 Gelu 一样没进参考实现（opset 18 才进标准），也补上。"""

    op_domain = ""

    def _run(self, x):
        x = np.asarray(x, dtype=np.float64)
        return (x * _sigmoid(x),)


# 注册表是按 (domain, 类名) 查的，所以类名必须和 ONNX 里的算子名一模一样
REF_NEW_OPS = [Gelu, Silu]


def ACT_VALUES(code, t):
    if code == 0:
        return t
    if code == 1:
        return np.maximum(t, 0.0)
    if code == 2:
        return np.where(t > 0, t, 0.01 * t)
    if code == 3:
        return _sigmoid(t)
    if code == 4:
        return np.tanh(t)
    if code == 5:
        return gelu_tanh(t)
    if code == 6:
        return np.where(t > 0, t, np.expm1(t))
    if code == 7:
        return t * _sigmoid(t)
    raise ValueError("未知激活码 " + str(code))


def _softmax(t, axis=0):
    """数值稳定的 softmax（减最大值）。"""
    m = np.max(t, axis=axis, keepdims=True)
    e = np.exp(t - m)
    return e / np.sum(e, axis=axis, keepdims=True)


def _op_axis(attrs, rank, default):
    """算子里记的 axis：负数按 rank 折回来，越界直接报错（别猜）。"""
    if not attrs or 'axis' not in attrs:
        return default
    ax = int(attrs['axis'])
    if ax < 0:
        ax += rank
    if not (0 <= ax < rank):
        raise ValueError(f"算子的 axis={attrs['axis']} 超出秩 {rank}")
    return ax


def _op_eval(nd, op_val, val):
    """算一个算子节点，返回输出张量。认不出的算子直接报错，不许静默跳过。"""
    parts = []
    for r in nd.ins:
        if r.get('k') == 'o':
            a = np.asarray(op_val[int(r['id'])], dtype=np.float64)
        else:
            ids = np.asarray(r['ids'], dtype=np.int64)
            a = np.asarray(val[ids], dtype=np.float64)
        shape = [int(v) for v in (r.get('shape') or [a.size])]
        parts.append(a.reshape(shape))
    if not parts:
        raise ValueError('ir_forward 不认识没有输入的算子 ' + str(nd.op))
    if len(parts) > 1:
        raise ValueError('ir_forward 还不认识多输入算子 ' + str(nd.op) + '（%d 路输入）' % len(parts))
    t = parts[0]
    rank = max(1, t.ndim)
    if nd.op == 'Softmax':
        y = _softmax(t, _op_axis(nd.attrs, rank, rank - 1))
    elif nd.op == 'LogSoftmax':
        y = np.log(_softmax(t, _op_axis(nd.attrs, rank, rank - 1)))
    else:
        raise ValueError('ir_forward 不认识算子 ' + str(nd.op) + '，别拿它当数值基准')
    out_shape = [int(v) for v in nd.out] or list(y.shape)
    return y.reshape(out_shape)


def ir_forward(neu, edg, x, out_ids, blk=None, ops=None):
    """按编辑器的语义前向：先取偏置，输入神经元由外部写入，再按拓扑序推进。

    权重块在这里被摊成逐条贡献——只是求值方式不同，语义跟编译产物里那次 matmul 一致：
    h[列 j] += Σ_行 W[行, j] · h[src[行]]。

    算子节点（Softmax / LogSoftmax 这类无状态、单输入的）也一起算：它们出现在落点上，
    落点神经元要等算子算完再往下传。认不出的算子会抛错，不会被当成"没事"跳过。
    """
    n = len(neu)
    succ = [[] for _ in range(n)]
    indeg = np.zeros(n, dtype=np.int64)
    for s, d, w in zip(edg.src.tolist(), edg.dst.tolist(), edg.w.tolist()):
        succ[s].append((d, w))
        indeg[d] += 1
    if blk is not None and len(blk):
        ow, os_, od = nforge._block_offsets(blk.ks, blk.ns)
        for i in range(len(blk.ks)):
            k, ncol = int(blk.ks[i]), int(blk.ns[i])
            W = blk.w[ow[i]:ow[i] + k * ncol].reshape(k, ncol)
            bsrc = blk.src[os_[i]:os_[i] + k]
            bdst = blk.dst[od[i]:od[i] + ncol]
            for a in range(k):
                sa = int(bsrc[a])
                for j in range(ncol):
                    wa = float(W[a, j])
                    if wa == 0.0:
                        continue
                    dj = int(bdst[j])
                    succ[sa].append((dj, wa))
                    indeg[dj] += 1
    op_list = list(getattr(ops, 'list', None) or [])
    op_dep_n, op_dep_o, op_land = [], [], []
    for nd in op_list:
        dn, do = set(), set()
        for r in nd.ins:
            if r.get('k') == 'o':
                do.add(int(r['id']))
            else:
                dn.update(int(v) for v in r['ids'])
        op_dep_n.append(dn)
        op_dep_o.append(do)
        land = [] if nd.land is None else [int(v) for v in nd.land]
        op_land.append(land)
        for i in land:
            indeg[i] += 1          # 落点要等这个算子算完
    val = neu.bias.astype(np.float64).copy()
    ins = np.nonzero(neu.io & nforge.IO_IN)[0]   # 双向接口（IO_BOTH）的也要当输入喂
    xf = np.asarray(x, dtype=np.float64).reshape(-1)
    if len(ins) != len(xf):
        raise ValueError(f"输入神经元 {len(ins)} 个，喂进来 {len(xf)} 个")
    for k, i in enumerate(ins):
        val[i] = xf[k]
    ins_set = set(ins.tolist())

    # 拓扑序列：把算子节点也当一个节点排进去 —— 它的"入边"是它依赖的神经元 / 上游算子，
    # "出边"是落点神经元。这样值传播只走一遍，算子拿到的一定是上游已经算完的值。
    # （早先的写法是在拓扑遍历里顺手算算子，那会儿逐神经元的贡献还没加进去，
    # 算出来的必然是偏置那一层，Softmax 就会静默算错。）
    settled = set()
    op_done = set()
    op_queued = set()
    op_val = {}
    seq = []
    q = deque(('n', i) for i in np.nonzero(indeg == 0)[0].tolist())

    def admit_ops():
        for oi in range(len(op_list)):
            if oi in op_queued or oi in op_done:
                continue
            if op_dep_n[oi] <= settled and op_dep_o[oi] <= op_done:
                op_queued.add(oi)
                q.append(('op', oi))

    admit_ops()
    while q:
        kind, v = q.popleft()
        seq.append((kind, v))
        if kind == 'n':
            settled.add(v)
            for d, _ in succ[v]:
                indeg[d] -= 1
                if indeg[d] == 0:
                    q.append(('n', d))
        else:
            op_done.add(v)
            for i in op_land[v]:
                indeg[i] -= 1
                if indeg[i] == 0:
                    q.append(('n', i))
        admit_ops()
    if sum(1 for k, _ in seq if k == 'n') != n:
        raise ValueError("导入出来的图有环")
    for kind, v in seq:
        if kind == 'n':
            val[v] = ACT_VALUES(int(neu.act[v]), val[v])
            for d, w in succ[v]:
                val[d] += w * val[v]
        else:
            out = _op_eval(op_list[v], op_val, val)
            op_val[v] = out
            flat = out.reshape(-1)
            for pos, i in enumerate(op_land[v]):
                val[i] = float(flat[pos])
    return np.concatenate([val[ids] for ids in out_ids])


# ---------------------------------------------------------------- 造测试模型
def make_model(specs, in_features, name="t"):
    """specs: [(W (out,in), bias or None, act_op or None, 是否用 MatMul)]"""
    nodes, inits = [], []
    prev = "X"
    for i, (W, b, act, use_matmul) in enumerate(specs):
        wn = f"W{i}"
        if use_matmul:
            inits.append(numpy_helper.from_array(np.ascontiguousarray(W.T, dtype=np.float32), wn))
            if b is not None:
                inits.append(numpy_helper.from_array(np.ascontiguousarray(b, dtype=np.float32), f"B{i}"))
                nodes.append(helper.make_node("MatMul", [prev, wn], [f"m{i}"]))
                nodes.append(helper.make_node("Add", [f"m{i}", f"B{i}"], [f"g{i}"]))
            else:
                nodes.append(helper.make_node("MatMul", [prev, wn], [f"g{i}"]))
        else:
            inits.append(numpy_helper.from_array(np.ascontiguousarray(W, dtype=np.float32), wn))
            args = [prev, wn]
            if b is not None:
                inits.append(numpy_helper.from_array(np.ascontiguousarray(b, dtype=np.float32), f"B{i}"))
                args.append(f"B{i}")
            nodes.append(helper.make_node("Gemm", args, [f"g{i}"], transB=1))
        cur = f"g{i}"
        if act:
            # 编辑器里的 gelu 是 tanh 近似：对拍模型也写 tanh，两边才是同一个函数
            akw = {"approximate": "tanh"} if act == "Gelu" else {}
            nodes.append(helper.make_node(act, [cur], [f"a{i}"], **akw))
            cur = f"a{i}"
        prev = cur
    out_f = specs[-1][0].shape[0]
    graph = helper.make_graph(
        nodes, name,
        [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, in_features])],
        [helper.make_tensor_value_info(prev, TensorProto.FLOAT, [1, out_f])], inits)
    return helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])


def rand_w(out_f, in_f, scale=0.6):
    return (rng.random((out_f, in_f)) * 2 - 1) * scale


def rand_b(out_f):
    return (rng.random(out_f) * 2 - 1) * 0.2


# ---------------------------------------------------------------- 用例
def _opts(tmpdir, name, chunk=None, **kw):
    opts = import_model.argparse.Namespace(
        model=os.path.join(tmpdir, name + ".onnx"), out=None, name=name,
        chunk_neurons=chunk or 4096,
        max_neurons=import_model.MAX_N, max_edges=import_model.MAX_E,
        prune_below=0.0, spacing=26.0, names=True, compress=True,
        blocks="auto", block_min=import_model.DEF_BLOCK_MIN,
        block_dense=import_model.DEF_BLOCK_DENSE)
    for k, v in kw.items():
        setattr(opts, k, v)
    return opts


def _import(tmpdir, name, model, **kw):
    path = os.path.join(tmpdir, name + ".onnx")
    onnx.save(model, path)
    opts = _opts(tmpdir, name, **kw)
    b, _ = import_model.import_onnx(path, opts)
    return opts, b


def check_cast_note(tmpdir, name, kind):
    opts, b = _import(tmpdir, name, onnx.load(os.path.join(tmpdir, name + ".onnx")))
    txt = " ".join(b.source["notes"])
    log(any(c["to"] == kind for c in b.source["casts"]) and kind in txt,
        name + " 来源表写明 Cast 到 " + kind + " 后按 float32 算",
        "；".join(c["n"] + "→" + c["to"] for c in b.source["casts"]))


def check_io_both(tmpdir, name):
    opts, b = _import(tmpdir, name, onnx.load(os.path.join(tmpdir, name + ".onnx")))
    io = b.io
    n_both = sum(1 for v in io if v == nforge.IO_BOTH)
    log(n_both == 5 and all(v == nforge.IO_BOTH for v in io),
        name + " 直通神经元是『输入 + 输出』而不是只算输出",
        f"{n_both} 个双向接口 / 共 {len(io)} 个神经元")
    log(any("既在图输入里又在图输出里" in t for t in b.source["notes"]),
        name + " 来源表里说明了这批神经元是双向接口")


def check_precision(tmpdir, name, kind, want):
    opts, b = _import(tmpdir, name, onnx.load(os.path.join(tmpdir, name + ".onnx")))
    got = int(b.source["precision"]["weights"].get(kind, 0))
    txt = " ".join(b.source["notes"])
    log(got == want and kind in txt and "float32" in txt,
        name + " 精度截断写进来源表", f"{kind} {got} 个（期望 {want}）")


def check_skipped(tmpdir, name, op):
    opts, b = _import(tmpdir, name, onnx.load(os.path.join(tmpdir, name + ".onnx")),
                      allow_skip=op)
    sk = b.source["skipped"]
    log(len(sk) == 1 and sk[0]["op"] == op and b.source["exact"] is False,
        name + " 跳过的算子记进来源表且标成『数值不再等价』",
        f"{len(sk)} 个 / exact={b.source['exact']}")
    log(any("不再等价" in t for t in b.source["notes"]),
        name + " 来源表的说明里写清了跳过之后数值不等价")


def check_ops(tmpdir, name, want_ops, want_shapes, exact=None, land_io=False):
    """算子节点（算子级聚合块）：类型 / 输出形状 / 参数张量必须跟 ONNX 里的一致。

    这是「不再拒绝卷积」这句话的凭据：原模型里长什么样，导入之后就得是什么样——
    参数张量逐位相同、输出形状照抄，落点神经元的个数等于元素个数。
    """
    onnx_path = os.path.join(tmpdir, name + ".onnx")
    opts, b = _import(tmpdir, name, onnx.load(onnx_path))
    nds = getattr(b, "opNodes", None) or []
    got = [nd["op"] for nd in nds]
    log(got == list(want_ops), name + " 算子节点按原样记下来了（不是拒绝、也不是硬折）",
        " -> ".join(got) or "（一个都没有）")
    shapes = [[int(x) for x in nd["out"]] for nd in nds]
    log(shapes == [list(s) for s in want_shapes], name + " 算子节点的输出形状照抄原模型",
        str(shapes))
    ok_p = True
    det = []
    for nd in nds:
        for p in nd["params"]:
            if p.dtype != "f32" or not np.all(np.isfinite(p.data)):
                ok_p = False
            det.append(nd["op"] + "." + p.name + str(tuple(p.shape)))
    log(ok_p, name + " 算子节点的参数张量都是有限的 float32",
        "；".join(det) or "（这几个算子没有参数）")
    if exact:
        init = {t.name: numpy_helper.to_array(t)
                for t in onnx.load(onnx_path).graph.initializer}
        bits, why = True, []
        for oi, pname, iname in exact:
            p = next((q for q in nds[oi]["params"] if q.name == pname), None)
            ref = init.get(iname)
            if p is None or ref is None:
                bits = False
                why.append(pname + "<-" + iname + " 缺")
                continue
            aa = np.asarray(p.data, dtype=np.float32).reshape(-1)
            rr = np.asarray(ref, dtype=np.float32).reshape(-1)
            if aa.size != rr.size or not np.array_equal(aa, rr):
                bits = False
                why.append(pname + "≠" + iname)
        log(bits, name + " 算子节点的参数张量跟原模型逐位相同",
            "；".join(why) or f"{len(exact)} 个张量都对上了")
    if land_io:
        ok_l, det2 = True, []
        for nd in nds:
            land = nd.get("land")
            if land is None:
                continue
            n_el = 1
            for d in nd["out"]:
                n_el *= int(d)
            seg = np.asarray(b.io[int(land[0]):int(land[-1]) + 1], dtype=np.int64)
            if len(land) != n_el or not np.all(seg == nforge.IO_OUT):
                ok_l = False
            det2.append(nd["op"] + " 落 " + str(len(land)) + " 个神经元")
        log(ok_l and bool(det2),
            name + " 算子输出落到神经元上、个数 = 元素个数、并且标成了对外输出",
            "；".join(det2) or "（没有落点）")


def check_layout(tmpdir, name, model, layout):
    """返回 (y 跨度, z 跨度)——line 摊在 y 上、grid 摊在 y/z 上、ring 摊在 y/z 的圆上。"""
    path = os.path.join(tmpdir, name + ".onnx")
    onnx.save(model, path)
    opts = _opts(tmpdir, name, layout=layout)
    b, _ = import_model.import_onnx(path, opts)
    pos = np.asarray(b.pos, dtype=np.float64)
    return (float(pos[:, 1].max() - pos[:, 1].min()),
            float(pos[:, 2].max() - pos[:, 2].min()))


def check_shared(tmpdir, name, tensor, users):
    """权值共享：同一个常量被好几个算子引用时必须如实记下来。

    注意它**不是**数值失真——两处副本的值是一样的，前向结果也等价。所以 exact 必须仍然是 true。
    "能不能真的做成共享参数"是另一回事，由 check_tied_blocks 逐条验。
    """
    opts, b = _import(tmpdir, name, onnx.load(os.path.join(tmpdir, name + ".onnx")))
    sh = b.source.get("shared") or []
    hit = [e for e in sh if e["t"] == tensor]
    log(len(hit) == 1 and hit[0]["u"] == users and len(hit[0]["at"]) == users,
        name + " 同一个权重张量被多处引用 -> 记进来源表",
        "；".join(f"{e['t']}×{e['u']} 处（{len(e['at'])} 个引用点）" for e in sh) or "一条都没有")
    log(b.source["exact"] is True and b.source["counts"]["shared"] == 1,
        name + " 共享参数不算数值失真（exact 仍然是 true）",
        f"exact={b.source['exact']} / shared={b.source['counts']['shared']}")
    txt = " ".join(b.source["notes"])
    log("权值共享" in txt and ("共享参数组" in txt or "各存一份" in txt),
        name + " 说明里交代了这几处参数的来龙去脉（建成没建成共享组都说清）",
        txt[txt.find("原模型里"):][:80] if "原模型里" in txt else "（没有这段说明）")


def check_tied_blocks(tmpdir, name, tensor, users, blocks="always"):
    """tied weights 真的建成共享参数组：同一个 sg、形状一致、文件里只存一份、读回来还同组。

    这一条覆盖的是"能不能真共享"——用户上一轮专门问过的那件事。
    """
    opts, b = _import(tmpdir, name, onnx.load(os.path.join(tmpdir, name + ".onnx")), blocks=blocks)
    neu, edg, blk, total = import_model.build_arrays(b, opts)
    grp = {}
    for i, g in enumerate(blk.sg.tolist()):
        grp.setdefault(g, []).append(i)
    groups = {g: v for g, v in grp.items() if g and len(v) >= 2}
    log(len(groups) == 1 and len(list(groups.values())[0]) == users,
        name + " 导入直接建成共享参数组（同一个常量折出来的块同组）",
        f"sg={blk.sg.tolist()} -> {len(groups)} 组")
    ks, ns = blk.ks.tolist(), blk.ns.tolist()
    mem = list(groups.values())[0]
    log(len({(ks[i], ns[i]) for i in mem}) == 1,
        name + " 导入器自动建组时每块形状完全一致（转置两用内存是列主序，自动建会算错；"
               "界面里手工建组才允许形状不同、元素总数一致）",
        "、".join(f"{ks[i]}×{ns[i]}" for i in mem))
    kw = ks[mem[0]] * ns[mem[0]]
    log(blk.stored_weights == blk.total_weights - (len(mem) - 1) * kw,
        name + " 文件里只写一份权重（省下的正好是组内多出来的那几份）",
        f"存 {blk.stored_weights} / 不去重 {blk.total_weights} / 省 {(len(mem) - 1) * kw}")
    nfile = os.path.join(tmpdir, name + "_tied.nforge")
    nforge.write(nfile, neu, edg, name=name, chunk_neurons=opts.chunk_neurons,
                 names=b.names, blocks=blk, source=getattr(b, "source", None))
    hdr = nforge.read_header(nfile)
    log(hdr["blocks"]["weights"] == blk.stored_weights and
        hdr["counts"]["blockWeights"] == blk.stored_weights,
        name + " 文件头里记的权重数就是去重之后的数",
        f'{hdr["blocks"]["weights"]} / {hdr["counts"]["blockWeights"]}')
    hp, blk2, dropped, nb = nforge.read_blocks(nfile)
    log(len(blk2) == len(blk) and blk2.sg.tolist() == blk.sg.tolist() and
        blk2.stored_weights == blk.stored_weights and not dropped,
        name + " 从文件读回来还是同一组（组号与去重数都没变）",
        f"sg={blk2.sg.tolist()} / {blk2.stored_weights} / 丢 {dropped}")
    ow, _, _ = nforge._block_offsets(blk2.ks, blk2.ns)
    w0 = blk2.w[ow[mem[0]]:ow[mem[0] + 1]]
    refs = blk2.refs().tolist()
    log(all(np.array_equal(w0, blk2.w[ow[i]:ow[i + 1]]) for i in mem) and
        all(refs[i] == mem[0] for i in mem[1:]),
        name + " 组里每块读到的都是同一份权重（引用表指向组长）", f"refs={refs}")
    # --no-tie-blocks：关掉之后回到"各存一份副本"，一个共享组都不该有
    opts2, b2 = _import(tmpdir, name, onnx.load(os.path.join(tmpdir, name + ".onnx")),
                        blocks=blocks, tie_blocks=False)
    neu2, edg2, blk3, _t2 = import_model.build_arrays(b2, opts2)
    log(int(np.max(blk3.sg)) == 0 and blk3.stored_weights == blk3.total_weights,
        name + " --no-tie-blocks 关掉之后一个共享组都没有（回到各存一份）",
        f"sg={blk3.sg.tolist()} / 存 {blk3.stored_weights} = 不去重 {blk3.total_weights}")


def run_case(name, model, tmpdir, expect_err=None, chunk=None, num_tol=2e-5, **kw):
    path = os.path.join(tmpdir, name + ".onnx")
    onnx.save(model, path)
    opts = _opts(tmpdir, name, chunk, **kw)
    try:
        b, layer_count = import_model.import_onnx(path, opts)
        neu, edg, blk, total = import_model.build_arrays(b, opts)
    except import_model.Unsupported as e:
        if expect_err is None:
            log(False, name, "本不该报错，却报了：" + str(e))
            return
        log(expect_err in str(e), name + " 明确报错", str(e).replace("\n", " ")[:110])
        return
    if expect_err is not None:
        log(False, name, "本该报错（" + expect_err + "）却通过了")
        return

    nfile = os.path.join(tmpdir, name + ".nforge")
    info = nforge.write(nfile, neu, edg, name=name, chunk_neurons=opts.chunk_neurons,
                        names=b.names, blocks=blk, source=getattr(b, "source", None))
    bad = nforge.check_index(info["header"])
    log(not bad, name + " 索引表自洽", "; ".join(bad) if bad else
        f"{len(info['header']['chunks'])} 块 / {info['bytes']} 字节")

    header, neu2, edg2, blk2 = nforge.read(nfile)
    log(len(neu2) == len(neu) and len(edg2) == len(edg),
        name + " 往返规模一致", f"{len(neu2)} 神经元 / {len(edg2)} 连接")

    # ---- 来源表：折平之前的结构必须留在文件里 ----
    src = getattr(b, "source", None) or {}
    hsrc = header.get("source") or {}
    spans = src.get("spans") or []
    cov = 0
    ok_spans = True
    for k in range(len(spans)):
        a0, a1, kk = int(spans[k][0]), int(spans[k][1]), int(spans[k][2])
        if k and a0 < int(spans[k - 1][1]):
            ok_spans = False
        if a1 > a0 and 0 <= kk < len(src.get("nodes") or []):
            cov += a1 - a0
    log(hsrc.get("format") == 1 and bool(hsrc.get("nodes")) and
        hsrc.get("counts", {}).get("ops") == len(src.get("nodes") or []),
        name + " 来源表写进了文件头并往返读回",
        f"来源表 {len(src.get('nodes') or [])} 条 / {len(spans)} 段")
    log(ok_spans and cov == len(neu),
        name + " 来源表的神经元区间覆盖全部神经元且不重叠", f"覆盖 {cov} / {len(neu)}")
    log(all(("out" in r) or ("skip" in r) or ("k" in r) for r in (src.get("nodes") or [])),
        name + " 来源表每条记录都指了神经元区间或是显式跳过的算子")
    # 第一层在来源表里必须有上游，否则结构视图会把「输入 → 第一层」这条边画丢
    nodes_s = src.get("nodes") or []
    first_layer = next((r for r in nodes_s if r.get("op") in ("Gemm", "MatMul")), None)
    up_ok = (first_layer is None) or (
        isinstance(first_layer.get("in"), list) and
        any(nodes_s[p].get("k") == "in" for p in first_layer["in"] if 0 <= p < len(nodes_s)))
    log(up_ok, name + " 来源表里第一层的上游指向输入节点（结构视图的边才画得出来）",
        str(first_layer.get("in") if first_layer else "（这个模型里没有 Gemm/MatMul）"))
    same_pos = np.allclose(neu2.pos, neu.pos, atol=0) and \
        np.array_equal(neu2.io, neu.io) and np.array_equal(neu2.act, neu.act) and \
        np.array_equal(neu2.bias, neu.bias)
    log(same_pos, name + " 往返逐字段一致（位级）")
    key = lambda e: np.lexsort((e.dst, e.src))
    s1, s2 = key(edg), key(edg2)
    same_edges = (len(edg2) == len(edg) and
                  np.array_equal(edg.src[s1], edg2.src[s2]) and
                  np.array_equal(edg.dst[s1], edg2.dst[s2]) and
                  np.allclose(edg.w[s1], edg2.w[s2], atol=0))
    log(same_edges, name + " 往返每条连接的起点/终点/权重都一致")

    n_blk = 0 if blk is None else len(blk)
    n_blk2 = 0 if blk2 is None else len(blk2)
    log(n_blk2 == n_blk, name + " 权重块往返数量一致", f"{n_blk} 块")
    if n_blk and n_blk2:
        same_blk = (np.array_equal(blk.ks, blk2.ks) and np.array_equal(blk.ns, blk2.ns) and
                    np.array_equal(blk.src, blk2.src) and np.array_equal(blk.dst, blk2.dst) and
                    np.array_equal(blk.w, blk2.w))
        log(same_blk, name + " 权重块往返逐位一致（形状 / 两端 id / 权重）",
            " × ".join(f"{int(a)}x{int(b)}" for a, b in zip(blk.ks, blk.ns)))

    if not hasattr(b, "out_ids"):
        return
    if getattr(b, "opNodes", None):
        # ir_forward 只认神经元级：算子节点（卷积这类）的贡献它算不出来，硬比会得到假失败。
        # 这类模型的数值对拍走「编译产物」那条路（tools/verify_op.py 跑生成的 PyTorch）。
        kinds = "、".join(sorted({nd["op"] for nd in b.opNodes}))
        log(True, name + " 结构检查通过（含算子节点：" + kinds + "）",
            f"{len(b.opNodes)} 个算子节点 → 数值对拍见 verify_op.py")
        return
    n_in = int(np.count_nonzero(neu.io & nforge.IO_IN))
    x = ((rng.random((1, n_in)) * 2 - 1)).astype(np.float32)
    ref = ReferenceEvaluator(model, new_ops=REF_NEW_OPS).run(None, {"X": x})[0].reshape(-1)
    got = ir_forward(neu2, edg2, x, b.out_ids, blk2)
    err = float(np.max(np.abs(ref - got)))
    log(err < num_tol, name + " 数值和 ONNX 参考实现一致",
        f"最大误差 {err:.3e}（容差 {num_tol:.0e}）")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        # 1. Gemm -> Relu -> Gemm -> Sigmoid
        m1 = make_model([(rand_w(6, 4), rand_b(6), "Relu", False),
                         (rand_w(3, 6), rand_b(3), "Sigmoid", False)], 4)
        run_case("mlp_gemm_relu_sigmoid", m1, tmp)

        # 2. MatMul + Add -> Tanh -> MatMul + Add（不带 transB 的那条路）
        m2 = make_model([(rand_w(5, 3), rand_b(5), "Tanh", True),
                         (rand_w(2, 5), rand_b(2), None, True)], 3)
        run_case("matmul_add_tanh", m2, tmp)

        # 3. 一次覆盖 LeakyRelu / Gelu / Elu / Silu
        m3 = make_model([(rand_w(7, 4), rand_b(7), "LeakyRelu", False),
                         (rand_w(6, 7), rand_b(6), "Gelu", False),
                         (rand_w(5, 6), rand_b(5), "Elu", False),
                         (rand_w(4, 5), rand_b(4), "Silu", False)], 4)
        run_case("activations", m3, tmp)

        # 4. 没有偏置的 Gemm
        m4 = make_model([(rand_w(6, 5), None, "Relu", False),
                         (rand_w(3, 6), None, None, False)], 5)
        run_case("no_bias", m4, tmp)

        # 5. 分块：每块只放 3 个神经元，看索引表和部分读的行为
        run_case("chunked", m3, tmp, chunk=3)
        path = os.path.join(tmp, "chunked.onnx")
        onnx.save(m3, path)
        opts = import_model.argparse.Namespace(
            model=path, out=None, name="chunked", chunk_neurons=3,
            max_neurons=import_model.MAX_N, max_edges=import_model.MAX_E,
            prune_below=0.0, spacing=26.0, names=True, compress=True)
        b, _ = import_model.import_onnx(path, opts)
        neu, edg, _blk, _ = import_model.build_arrays(b, opts)
        nfile = os.path.join(tmp, "chunked.nforge")
        info = nforge.write(nfile, neu, edg, name="chunked", chunk_neurons=3, names={})
        log(len(info["header"]["chunks"]) == (len(neu) + 2) // 3,
            "小块切分的块数正确", f"{len(info['header']['chunks'])} 块 / {len(neu)} 神经元")
        h, n_part, e_part, _blk = nforge.read(nfile, ids=[0, 1])
        exp_n = sum(c["n1"] - c["n0"] for c in info["header"]["chunks"] if c["i"] in (0, 1))
        exp_e = sum(c["e1"] - c["e0"] for c in info["header"]["chunks"] if c["i"] in (0, 1))
        log(len(n_part) == exp_n, "部分读只拿到选中块的神经元", f"{len(n_part)} / {exp_n}")
        log(len(e_part) <= exp_e, "部分读不会多出连接", f"{len(e_part)} / {exp_e}")
        log(len(e_part) < exp_e, "跨块连接被丢掉（不假装完整）", f"丢 {exp_e - len(e_part)} 条")

        # 6. Softmax：不再拒绝——记成算子节点（编译时是一句 torch.softmax）
        nodes = [helper.make_node("Gemm", ["X", "W", "B"], ["g"], transB=1),
                 helper.make_node("Softmax", ["g"], ["Y"])]
        inits = [numpy_helper.from_array(rand_w(3, 4), "W"),
                 numpy_helper.from_array(rand_b(3), "B")]
        g = helper.make_graph(nodes, "sm",
                              [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 4])],
                              [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 3])],
                              inits)
        run_case("softmax", helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)]),
                 tmp)
        check_ops(tmp, "softmax", ["Softmax"], [[1, 3]], land_io=True)

        # 7. LeakyRelu 的 alpha 不是 0.01：不能悄悄改成 0.01
        nodes = [helper.make_node("Gemm", ["X", "W", "B"], ["g"], transB=1),
                 helper.make_node("LeakyRelu", ["g"], ["Y"], alpha=0.2)]
        inits = [numpy_helper.from_array(rand_w(3, 4), "W"),
                 numpy_helper.from_array(rand_b(3), "B")]
        g = helper.make_graph(nodes, "lk",
                              [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 4])],
                              [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 3])],
                              inits)
        run_case("leaky_alpha", helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)]),
                 tmp, expect_err="alpha")

        # 8. 边数超上限：必须报错，并说清有几条、可以怎么办
        big = make_model([(rand_w(2, 2), None, None, False)], 2)   # 4 条边，上限给 1
        path = os.path.join(tmp, "too_big.onnx")
        onnx.save(big, path)
        opts = import_model.argparse.Namespace(
            model=path, out=None, name="big", chunk_neurons=4096,
            max_neurons=import_model.MAX_N, max_edges=1,
            prune_below=0.0, spacing=26.0, names=True, compress=True)
        try:
            b, _ = import_model.import_onnx(path, opts)
            import_model.build_arrays(b, opts)
            log(False, "超过边数上限会报错并给出办法")
        except import_model.Unsupported as e:
            log("prune-below" in str(e), "超过边数上限会报错并给出办法",
                str(e).replace("\n", " ")[:130])

        # 9. 输入张量写死了批量维 4（不带 transA）：必须明说是按 batch=1 导入的
        m9 = make_model([(rand_w(5, 4), rand_b(5), "Relu", False),
                         (rand_w(3, 5), rand_b(3), None, False)], 4)
        m9.graph.input[0].type.tensor_type.shape.dim[0].dim_value = 4
        run_case("batch_gt_one", m9, tmp, expect_err="batch=1")

        # 10. 同一条规则的兜底路径：Gemm 的 transA=1 把输入转置进来（K=2 而输入神经元
        #     有 4 个 -> 批量维 2）。PyTorch 导出器基本不这么干，真遇到了也不能猜。
        m10 = make_model([(rand_w(3, 2), rand_b(3), None, False)], 4)
        for n in m10.graph.node:
            if n.op_type == "Gemm":
                n.attribute.append(helper.make_attribute("transA", 1))
        run_case("transA_batch", m10, tmp, expect_err="batch=1")

        # 11. 权重块：Gemm 折出来的层整层收成块，数值必须和 ONNX 参考实现一致
        m11 = make_model([(rand_w(64, 96), rand_b(64), "Relu", False),
                          (rand_w(32, 64), rand_b(32), "Tanh", False),
                          (rand_w(8, 32), rand_b(8), None, False)], 96)
        run_case("blocks_always", m11, tmp, blocks="always")

        # 12. auto：同一个模型里小的走逐条边、大的收成块（两条路混在一起）
        m12 = make_model([(rand_w(80, 100), rand_b(80), "Relu", False),
                          (rand_w(4, 80), rand_b(4), None, False)], 100)
        run_case("blocks_auto_mixed", m12, tmp, block_min=4096)

        # 13. 超过单块上限（1M 权重）的矩阵会被切成子块，数值仍然一致
        m13 = make_model([(rand_w(1100, 1200), rand_b(1100), None, False)], 1200)
        run_case("blocks_tiled", m13, tmp, blocks="always")

        # 14. never：一律展开成边（哪怕矩阵很大），块数必须是 0
        run_case("blocks_never", m11, tmp, blocks="never")

        # 15. Cast 到整数 / 布尔：不是恒等变换，必须报错（原来被当直通静默导入）
        m15 = make_model([(rand_w(3, 4), rand_b(3), None, False)], 4)
        m15.graph.node.append(helper.make_node(
            "Cast", ["g0"], ["ci"], to=int(TensorProto.INT32)))
        m15.graph.node.append(helper.make_node(
            "Cast", ["ci"], ["cf"], to=int(TensorProto.FLOAT)))
        m15.graph.node.append(helper.make_node("Relu", ["cf"], ["Y2"]))
        m15.graph.output[0].name = "Y2"
        run_case("cast_to_int", m15, tmp, expect_err="只有 float32")

        # 16. Cast 到 float16 再转回来：能导，但必须在来源表里写明"不再复现降精度步骤"
        m16 = make_model([(rand_w(3, 4), rand_b(3), None, False)], 4)
        m16.graph.node.append(helper.make_node("Cast", ["g0"], ["h16"], to=int(TensorProto.FLOAT16)))
        m16.graph.node.append(helper.make_node("Cast", ["h16"], ["Y2"], to=int(TensorProto.FLOAT)))
        m16.graph.output[0].name = "Y2"
        #     容差放到 5e-3：float16 那一步的降精度差异**本来就该出现**——编辑器全程按
        #     float32 算，所以这里是"更准"，不是"对不上"。
        run_case("cast_f16", m16, tmp, num_tol=5e-3)
        check_cast_note(tmp, "cast_f16", "float16")

        # 17. 直通模型（输入直接就是输出）：接口必须是"既输入又输出"，不能被输出覆盖掉
        nodes = [helper.make_node("Identity", ["X"], ["Y"])]
        g17 = helper.make_graph(nodes, "pass",
                                [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 5])],
                                [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 5])], [])
        run_case("io_passthrough", helper.make_model(g17, opset_imports=[helper.make_opsetid("", 17)]),
                 tmp)
        check_io_both(tmp, "io_passthrough")

        # 18. 训练模式的 Dropout：随机丢弃不是恒等，必须报错
        m18 = make_model([(rand_w(4, 4), rand_b(4), None, False)], 4)
        m18.graph.node.append(helper.make_node(
            "Dropout", ["g0"], ["Y2"], training_mode=1, ratio=0.5))
        m18.graph.output[0].name = "Y2"
        run_case("dropout_train", m18, tmp, expect_err="training_mode")

        # 19. 推理模式的 Dropout（不带属性 = opset 17 的默认 training_mode=0）：当直通
        m19 = make_model([(rand_w(4, 4), rand_b(4), None, False)], 4)
        m19.graph.node.append(helper.make_node("Dropout", ["g0"], ["Y2"]))
        m19.graph.output[0].name = "Y2"
        run_case("dropout_eval", m19, tmp)

        # 20. float64 权重：能导，但精度截断必须写进来源表（原来一个字都不提）
        W64 = (rng.random((3, 4)) * 2 - 1)
        nodes = [helper.make_node("Gemm", ["X", "Wd", "B"], ["Y"], transB=1)]
        inits = [numpy_helper.from_array(np.ascontiguousarray(W64, dtype=np.float64), "Wd"),
                 numpy_helper.from_array(rand_b(3).astype(np.float64), "B")]
        g20 = helper.make_graph(nodes, "f64",
                                [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 4])],
                                [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 3])], inits)
        run_case("double_weights", helper.make_model(g20, opset_imports=[helper.make_opsetid("", 17)]),
                 tmp)
        check_precision(tmp, "double_weights", "float64", 15)   # 12 个权重 + 3 个偏置

        # 21. BatchNormalization（推理图）：不再拒绝——记成算子节点（编译时是 F.batch_norm）；
        #     想改成「跳过」也可以：--allow-skip 点名之后能导，但要记成"数值不再等价"
        # 归一化取 scale=1 / bias=0 / mean=0 / var=1 / epsilon=0，也就是逐元素恒等——
        # 这样"跳过它"和"折进去"数值恰好一致，能单独验证跳过这条路本身没写错。
        def bn_model():
            W = rand_w(4, 5)
            b0 = rand_b(4)
            inits = [numpy_helper.from_array(np.ascontiguousarray(W, dtype=np.float32), "W"),
                     numpy_helper.from_array(np.ascontiguousarray(b0, dtype=np.float32), "B"),
                     numpy_helper.from_array(np.ones(4, dtype=np.float32), "S"),
                     numpy_helper.from_array(np.zeros(4, dtype=np.float32), "Bn"),
                     numpy_helper.from_array(np.zeros(4, dtype=np.float32), "M"),
                     numpy_helper.from_array(np.ones(4, dtype=np.float32), "V")]
            nodes = [helper.make_node("Gemm", ["X", "W", "B"], ["g"], transB=1),
                     helper.make_node("BatchNormalization", ["g", "S", "Bn", "M", "V"], ["bn"],
                                      epsilon=0.0),
                     helper.make_node("Relu", ["bn"], ["Y"])]
            gg = helper.make_graph(nodes, "bn",
                                   [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 5])],
                                   [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 4])], inits)
            return helper.make_model(gg, opset_imports=[helper.make_opsetid("", 17)])

        run_case("bn_op", bn_model(), tmp)
        check_ops(tmp, "bn_op", ["BatchNormalization", "Relu"], [[1, 4], [1, 4]],
                  exact=[(0, "scale", "S"), (0, "B", "Bn"),
                         (0, "mean", "M"), (0, "var", "V")], land_io=True)
        run_case("bn_skip", bn_model(), tmp, allow_skip="BatchNormalization")
        check_skipped(tmp, "bn_skip", "BatchNormalization")

        # 22. Conv：不再拒绝——记成算子节点（编译时是一句 F.conv2d）。
        #     --allow-skip 点名跳过仍然必须报错（跳过会改元素个数，折出来的图是错的）
        Wc = rng.random((3, 1, 3, 3)).astype(np.float32)
        nodes = [helper.make_node("Conv", ["X", "Wc", "Bc"], ["Y"], pads=[1, 1, 1, 1])]
        inits = [numpy_helper.from_array(Wc, "Wc"),
                 numpy_helper.from_array(rand_b(3).astype(np.float32), "Bc")]
        g22 = helper.make_graph(nodes, "conv",
                                [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 1, 5, 5])],
                                [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 3, 5, 5])], inits)
        m22 = helper.make_model(g22, opset_imports=[helper.make_opsetid("", 17)])
        run_case("conv_op", m22, tmp)
        check_ops(tmp, "conv_op", ["Conv"], [[1, 3, 5, 5]],
                  exact=[(0, "W", "Wc"), (0, "B", "Bc")], land_io=True)
        run_case("conv_skip", m22, tmp, allow_skip="Conv", expect_err="元素个数")

        # 23. 布局：line / grid 必须真的改坐标
        m23 = make_model([(rand_w(6, 8), rand_b(6), "Relu", False),
                          (rand_w(4, 6), rand_b(4), None, False)], 8)
        ly, lz = check_layout(tmp, "layout_line", m23, "line")
        gy, gz = check_layout(tmp, "layout_grid", m23, "grid")
        ry, rz = check_layout(tmp, "layout_ring", m23, "ring")
        log(ly > 0 and lz == 0.0, "layout=line 把同一层的神经元摆成一条直线",
            f"y 跨度 {ly:.1f} / z 跨度 {lz:.1f}")
        log(gy > 0 and gz > 0, "layout=grid 把同一层的神经元摆成网格",
            f"y 跨度 {gy:.1f} / z 跨度 {gz:.1f}")
        log(ry > 0 and rz > 0 and abs(ry - rz) < 1.0, "layout=ring（默认）摆成一圈",
            f"y 跨度 {ry:.1f} / z 跨度 {rz:.1f}")

        # 24. main() 端到端：--report 能把报告写成 JSON，来源表在文件里也在报告里
        mpath = os.path.join(tmp, "report_demo.onnx")
        onnx.save(m23, mpath)
        rpath = os.path.join(tmp, "report_demo.json")
        ofile = os.path.join(tmp, "report_demo.nforge")
        rc = import_model.main([mpath, "-o", ofile, "--report", rpath, "--chunk-neurons", "4096"])
        import json as _json
        rep_data = _json.load(open(rpath, encoding="utf-8"))
        hdr = nforge.read_header(ofile)
        log(rc == 0 and rep_data["source"]["format"] == 1 and
            hdr.get("source", {}).get("model") == "report_demo.onnx" and
            rep_data["source"]["counts"]["ops"] == len(hdr["source"]["nodes"]),
            "命令行 --report 写出导入报告",
            f'{rep_data["counts"]["neurons"]} 神经元 / {len(rep_data["source"]["nodes"])} 个算子节点')
        log(bool(hdr["source"]["auto"]["positions"]) and
            hdr["source"]["auto"]["layout"] == "ring",
            "来源表写明坐标是自动铺的（原模型里没有坐标）")

        # 25. 权值共享：一个 initializer 被两个 Gemm 共用（tied weights）
        Wt = rand_w(3, 2)
        gX = helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 2])
        gY = helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 3])
        m25 = helper.make_model(helper.make_graph(
            [helper.make_node("Gemm", ["X", "Wt"], ["h1"], name="t1", transB=1),
             helper.make_node("Gemm", ["X", "Wt"], ["h2"], name="t2", transB=1),
             helper.make_node("Add", ["h1", "h2"], ["Y"], name="t3")],
            "tied", [gX], [gY], [numpy_helper.from_array(Wt, "Wt")]),
            opset_imports=[helper.make_opsetid("", 17)])
        run_case("tied_weights", m25, tmp)
        check_shared(tmp, "tied_weights", "Wt", 2)
        check_tied_blocks(tmp, "tied_weights", "Wt", 2)

        # 25c. 同一个张量两处用了相反的转置（transB 一正一反）：折出来是 2×3 与 3×2，
        #      元素总数一样、形状不同。导入器**故意不自动建组**（反过来的那处内存是列主序，
        #      自动建会算错），但数值必须照旧正确，理由要如实写清并指向"界面里手工建组"。
        Wtr = rand_w(3, 2)
        nodes_tr = [helper.make_node("Gemm", ["X", "Wt"], ["h1"], name="t1", transB=1),
                    helper.make_node("Gemm", ["h1", "Wt"], ["Y"], name="t2", transB=0)]
        g_tr = helper.make_graph(nodes_tr, "tied_transposed",
                                 [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 2])],
                                 [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 2])],
                                 [numpy_helper.from_array(Wtr, "Wt")])
        run_case("tied_transposed",
                 helper.make_model(g_tr, opset_imports=[helper.make_opsetid("", 17)]), tmp)
        opts_tr, b_tr = _import(tmp, "tied_transposed",
                                onnx.load(os.path.join(tmp, "tied_transposed.onnx")),
                                blocks="always")
        _ntr, _etr, blk_tr, _ttr = import_model.build_arrays(b_tr, opts_tr)
        _sh = [(int(a), int(b)) for a, b in zip(blk_tr.ks, blk_tr.ns)]
        log(int(np.max(blk_tr.sg)) == 0 and len(blk_tr) == 2 and sorted(a * b for a, b in _sh) == [6, 6],
            "tied_transposed 转置两用：不自动建组，两块形状不同（2×3 / 3×2）但元素总数都是 6",
            f"sg={blk_tr.sg.tolist()} / 形状 {_sh}")
        log(blk_tr.stored_weights == blk_tr.total_weights,
            "tied_transposed 转置两用：两块各存一份（没有偷偷去重，数值才不会有暗坑）",
            f"存 {blk_tr.stored_weights} / 不去重 {blk_tr.total_weights}")
        _why = "；".join(w for _n2, w in b_tr.tiedCant)
        log("转了置" in _why and "手工" in _why,
            "tied_transposed 转置两用：理由里写清是转置两用、并且可以在界面里手工建组",
            _why[:140])

        # 26. B05：opset 12+ 的 Dropout 第 3 个输入（training_mode）。
        #     以前只查属性，输入里写着 True 的图会被当成推理模式悄悄放过去。
        def dropout3(train_val, dynamic=False, ratio=0.5, mask=False, attr_conflict=False):
            W = rand_w(4, 4)
            inits = [numpy_helper.from_array(np.ascontiguousarray(W, dtype=np.float32), "W"),
                     numpy_helper.from_array(np.array(ratio, dtype=np.float32), "R")]
            ins_in = [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 4])]
            nodes = [helper.make_node("Gemm", ["X", "W"], ["g0"], transB=1)]
            if dynamic:
                # 开关是图输入：跑起来才知道是推理还是训练
                ins_in.append(helper.make_tensor_value_info("T", TensorProto.BOOL, []))
            else:
                inits.append(numpy_helper.from_array(np.array(bool(train_val), dtype=np.bool_), "T"))
            outs = ["Y", "MASK"] if mask else ["Y"]
            nd = helper.make_node("Dropout", ["g0", "R", "T"], outs)
            if attr_conflict:
                nd.attribute.append(helper.make_attribute("training_mode", 1))
            nodes.append(nd)
            gouts = [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 4])]
            if mask:
                nodes.append(helper.make_node("Identity", ["MASK"], ["Y2"]))
                gouts.append(helper.make_tensor_value_info("Y2", TensorProto.BOOL, [1, 4]))
            g = helper.make_graph(nodes, "dp3", ins_in, gouts, inits)
            return helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])

        run_case("dropout3_train", dropout3(True), tmp, expect_err="training_mode")
        run_case("dropout3_dynamic", dropout3(True, dynamic=True), tmp, expect_err="第 3 个输入")
        run_case("dropout3_eval", dropout3(False), tmp)
        run_case("dropout3_conflict", dropout3(False, attr_conflict=True), tmp, expect_err="对不上")
        run_case("dropout3_mask", dropout3(False, mask=True), tmp, expect_err="掩码")

        # 27. B06：Gelu 的两种模式——tanh（跟编辑器一致）照导，none（精确 erf）照导但
        #     必须在报告里写成「数值近似」。以前是反的：tanh 被拒，none 被当成等价。
        def gelu_model(approx=None):
            W = rand_w(4, 4)
            kw = {} if approx is None else {"approximate": approx}
            nodes = [helper.make_node("Gemm", ["X", "W"], ["g0"], transB=1),
                     helper.make_node("Gelu", ["g0"], ["Y"], **kw)]
            g = helper.make_graph(nodes, "gelu",
                                  [helper.make_tensor_value_info("X", TensorProto.FLOAT, [1, 4])],
                                  [helper.make_tensor_value_info("Y", TensorProto.FLOAT, [1, 4])],
                                  [numpy_helper.from_array(np.ascontiguousarray(W, dtype=np.float32), "W")])
            return helper.make_model(g, opset_imports=[helper.make_opsetid("", 20)])

        m27 = gelu_model("tanh")
        run_case("gelu_tanh", m27, tmp)
        opts27, b27 = _import(tmp, "gelu_tanh", onnx.load(os.path.join(tmp, "gelu_tanh.onnx")))
        log(b27.source["report"]["numeric"] == "exact" and b27.approx == [],
            "Gelu approximate=tanh：跟编辑器同一个函数，报告写 exact",
            str(b27.source["report"]["numeric"]))

        m27n = gelu_model()          # 缺省 = none = 精确 erf
        run_case("gelu_erf", m27n, tmp, num_tol=2e-3)
        opts27n, b27n = _import(tmp, "gelu_erf", onnx.load(os.path.join(tmp, "gelu_erf.onnx")))
        rep27 = b27n.source["report"]
        log(rep27["structure"] == "exact" and rep27["numeric"] == "approximate" and
            any(i["k"] == "approx" for i in rep27["items"]) and rep27["exactAll"] is False,
            "Gelu approximate=none（精确 erf）：能导进来，但报告里写成「数值近似」而不是等价",
            f'structure={rep27["structure"]} numeric={rep27["numeric"]} '
            f'items={[i["k"] for i in rep27["items"]]}')
        # 两种模式的差真的只有 5e-4 量级（说明记的是"近似"而不是"算错"）。上面那条
        # run_case 已经用 ONNX 参考执行器（erf 版）对过完整管线；这里再单看函数本身。
        xs = np.linspace(-3.0, 3.0, 601)
        gap = float(np.max(np.abs(gelu_tanh(xs) - 0.5 * xs * (1.0 + _ref_erf(xs)))))
        log(gap < 2e-3, "精确 erf 与编辑器 tanh 近似的最大差在 5e-4 量级（不是算错）",
            f"最大绝对差 {gap:.6g}")

        run_case("gelu_bogus", gelu_model("fastgelu"), tmp, expect_err="approximate")

        # 28. B13：分类报告——结构 / 数值 / 精度 / 共享四项分开记，verified 不假装已验证
        opts28, b28 = _import(tmp, "double_weights", onnx.load(os.path.join(tmp, "double_weights.onnx")))
        rep28 = b28.source["report"]
        log(rep28["structure"] == "exact" and rep28["numeric"] == "exact" and
            rep28["dtype"] == "widened" and rep28["verified"] == "none" and
            rep28["exactAll"] is False and
            any(i["k"] == "dtype" for i in rep28["items"]),
            "float64 权重：报告写 结构=exact / 数值=exact / 精度=widened / 未验证数值等价",
            f'{rep28["structure"]}/{rep28["numeric"]}/{rep28["dtype"]}/{rep28["verified"]}')
        opts28b, b28b = _import(tmp, "tied_weights", onnx.load(os.path.join(tmp, "tied_weights.onnx")),
                                blocks="always")
        rep28b = b28b.source["report"]
        log(rep28b["shared"] == "kept" and rep28b["structure"] == "exact" and
            rep28b["numeric"] == "exact" and b28b.source["exact"] is True and
            b28b.source["structureExact"] is True and
            rep28b["exactAll"] == (rep28b["dtype"] == "exact"),
            "tied weights：报告写 共享=kept；exactAll 由四项一起决定"
            "（这里常量是 float64，所以精度那一项是 widened）",
            f'shared={rep28b["shared"]} dtype={rep28b["dtype"]} exactAll={rep28b["exactAll"]}')
        opts28c, b28c = _import(tmp, "bn_skip", onnx.load(os.path.join(tmp, "bn_skip.onnx")),
                                blocks="auto", allow_skip="BatchNormalization")
        rep28c = b28c.source["report"]
        log(rep28c["structure"] == "skipped" and rep28c["exactAll"] is False and
            any(i["k"] == "skip" for i in rep28c["items"]),
            "跳过的算子：报告里结构写成 skipped，exactAll=false，条目指向具体节点",
            f'structure={rep28c["structure"]} items={[i["k"] for i in rep28c["items"]]}')

    fails = [l for l in OUT if l.startswith("FAIL")]
    for l in OUT:
        print(l)
    print(f"\n== {len(OUT) - len(fails)} PASS / {len(fails)} FAIL ==")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
