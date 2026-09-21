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


class Gelu(OpRun):
    """onnx 1.22 的参考实现里没有 Gelu（opset 20 才进标准），这里补一个精确版。

    必须和编辑器里 gelu（激活码 5，erf 版）逐点一致，否则"数值等价"这句是空的。
    """

    op_domain = ""

    def _run(self, x, approximate=None):
        if approximate is not None and approximate not in ("", "none"):
            raise ValueError(f"参考实现只做精确版 Gelu，approximate={approximate} 不支持")
        x = np.asarray(x, dtype=np.float64)
        return (0.5 * x * (1.0 + _ref_erf(x)),)


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
        return 0.5 * t * (1.0 + _ref_erf(t))
    if code == 6:
        return np.where(t > 0, t, np.expm1(t))
    if code == 7:
        return t * _sigmoid(t)
    raise ValueError("未知激活码 " + str(code))


def ir_forward(neu, edg, x, out_ids, blk=None):
    """按编辑器的语义前向：先取偏置，输入神经元由外部写入，再按拓扑序推进。

    权重块在这里被摊成逐条贡献——只是求值方式不同，语义跟编译产物里那次 matmul 一致：
    h[列 j] += Σ_行 W[行, j] · h[src[行]]。
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
    val = neu.bias.astype(np.float64).copy()
    ins = np.nonzero(neu.io & nforge.IO_IN)[0]   # 双向接口（IO_BOTH）的也要当输入喂
    xf = np.asarray(x, dtype=np.float64).reshape(-1)
    if len(ins) != len(xf):
        raise ValueError(f"输入神经元 {len(ins)} 个，喂进来 {len(xf)} 个")
    for k, i in enumerate(ins):
        val[i] = xf[k]
    ins_set = set(ins.tolist())
    q = deque(np.nonzero(indeg == 0)[0].tolist())
    order = []
    while q:
        i = q.popleft()
        order.append(i)
        for d, _ in succ[i]:
            indeg[d] -= 1
            if indeg[d] == 0:
                q.append(d)
    if len(order) != n:
        raise ValueError("导入出来的图有环")
    for i in order:
        if i not in ins_set:
            pass                      # val[i] 已经累加完所有上游贡献
        val[i] = ACT_VALUES(int(neu.act[i]), val[i])
        for d, w in succ[i]:
            val[d] += w * val[i]
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
            nodes.append(helper.make_node(act, [cur], [f"a{i}"]))
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

    fails = [l for l in OUT if l.startswith("FAIL")]
    for l in OUT:
        print(l)
    print(f"\n== {len(OUT) - len(fails)} PASS / {len(fails)} FAIL ==")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
