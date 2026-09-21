"""`.nforge` v3 的 JS <-> Python 逐字节兼容对拍。

为什么单独一个脚本：两边各写一半格式，最容易错的就是"我读得懂我自己写的"。
所以这里要的是**交叉**验证：

  prep   造一份 v2 JSON 工程文档（两边共用的唯一真值）放进 prototype/，
         再用 Python 把它写成 prototype/cross_from_py.nforge 给浏览器读。
         文档里带权重块：v3 的块区是第二段，这一段的编解码同样必须两边对得上。
  浏览器 _crosscheck.html 干两件事：
         1. 读同一份 cross_doc.json -> NF.encodeV3() -> POST 成 cross_from_js.nforge
         2. 读 cross_from_py.nforge -> NF.loadBuffer() -> POST 成 cross_js_readback.json
  check  Python 读 cross_from_js.nforge，跟 cross_doc.json 逐字段对；
         再读 cross_js_readback.json，跟 cross_from_py.nforge 逐字段对。

数值全部取 k/2^n 这种能精确放进 float32 的数，这样"对不上"只会是格式问题，
不会是二进制舍入问题。
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nforge  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROTO = os.path.join(ROOT, "prototype")
DUMP = os.path.join(ROOT, "_dump")
DOC = os.path.join(PROTO, "cross_doc.json")
CFG = os.path.join(PROTO, "cross_cfg.json")
PY_NFORGE = os.path.join(PROTO, "cross_from_py.nforge")
JS_NFORGE = os.path.join(DUMP, "cross_from_js.nforge")
JS_BACK = os.path.join(DUMP, "cross_js_readback.json")
JS_SPATIAL = os.path.join(DUMP, "cross_spatial_js.nforge")
JS_SPATIAL_PLAN = os.path.join(DUMP, "cross_spatial_plan.json")
JS_SPATIAL_BACK = os.path.join(DUMP, "cross_spatial_back.json")
PY_SPATIAL = os.path.join(PROTO, "cross_from_py_spatial.nforge")
JS_WHOLE = os.path.join(DUMP, "cross_from_js_whole.nforge")
PY_WHOLE = os.path.join(PROTO, "cross_from_py_whole.nforge")
JS_WHOLE_BACK = os.path.join(DUMP, "cross_whole_back.json")

N = 300
E = 1200
NAME = "对拍工程 · cross"
CHUNK_PY = 64         # Python 侧切块故意跟浏览器侧不一样：文件头必须自描述
CHUNK_JS = 256        # 块要大到能触发 deflate，压缩这条路才是真跑过的
CHUNK_SP = 40         # 空间分块的软目标（八叉树会切得比它更细）

OUT = []


def log(ok, name, detail=""):
    OUT.append(("PASS" if ok else "FAIL") + " | " + name + " | " + str(detail))


def make_doc():
    """造文档。所有数字都是 k/2^n，float32 精确表示。"""
    pos, col, blocks = [], [], []
    for i in range(N):
        pos += [(i - 8) * 1.25, (i % 5) * 0.75 - 1.5, ((i * 3) % 7) * 0.5 - 1.0]
        col += [((i * 3) % 16) / 16.0, ((i * 5) % 16) / 16.0, ((i * 7) % 16) / 16.0]
    edges = []
    for k in range(E):
        s = k % N
        d = (k * 7 + 3) % N
        if d == s:
            d = (d + 1) % N
        edges.append([s, d, ((k * 11) % 32) / 128.0 - 0.125, k % 2])
    # 权重块：形状 / 有无锁掩码都覆盖到。行与列的 id 都取小值，方便人肉核对。
    # 第 1、2 块是**共享参数组**（同一个 sg = 7），而且是"转置"共享：3×2 和 2×3
    # 元素总数一样、形状不同 —— 同一段数值按各自的行主序读。写文件时只存第一份 +
    # 一张引用表，跨语言对拍就是拿它验引用表的（两边都必须接受形状不同、元素总数相同）。
    plan = [(2, 3, False, 0), (3, 2, True, 7), (2, 3, True, 7), (4, 1, True, 0), (2, 2, False, 0)]
    lead_sg = {}
    for bi, (bk, bn, locked, sg) in enumerate(plan):
        bsrc = [(bi + t * 3) % N for t in range(bk)]
        bdst = [(40 + bi * 5 + t) % N for t in range(bn)]
        if sg and sg in lead_sg:
            bw = list(blocks[lead_sg[sg]]["w"])      # 同一个参数：值也必须一模一样
        else:
            bw = [((bi * 7 + t * 5) % 32) / 128.0 - 0.125 for t in range(bk * bn)]
            if sg:
                lead_sg[sg] = bi
        blocks.append({"k": bk, "n": bn, "src": bsrc, "dst": bdst, "w": bw,
                       "lock": ([t % 2 for t in range(bk * bn)] if locked else None),
                       "label": "块 " + str(bi + 1), "sg": sg})
    return {
        "format": "neuroforge-project", "version": 2, "name": NAME,
        "created": "2026-09-11T00:00:00.000Z",
        "neurons": {
            "pos": pos,
            "io": [i % 4 for i in range(N)],
            "colOn": [1 if i % 3 == 0 else 0 for i in range(N)],
            "col": col,
            "thr": [((i * 5) % 13) / 64.0 for i in range(N)],
            "act": [i % 8 for i in range(N)],
            "bias": [((i * 7) % 17) / 64.0 - 0.125 for i in range(N)],
            "lock": [i % 2 for i in range(N)],
            "names": {0: "输入·甲", 3: "hidden_α", 7: "带空格 的名字",
                      12: "🚀发射", N - 1: "输出∂"},
        },
        "edges": edges,
        "blocks": blocks,
    }


def doc_to_arrays(doc):
    nn = doc["neurons"]
    neu = nforge.Neurons(
        pos=np.asarray(nn["pos"], dtype=np.float32).reshape(-1, 3),
        io=np.asarray(nn["io"], dtype=np.uint8),
        thr=np.asarray(nn["thr"], dtype=np.float32),
        act=np.asarray(nn["act"], dtype=np.uint8),
        bias=np.asarray(nn["bias"], dtype=np.float32),
        lock=np.asarray(nn["lock"], dtype=np.uint8),
        col_on=np.asarray(nn["colOn"], dtype=np.uint8),
        col=np.asarray(nn["col"], dtype=np.float32).reshape(-1, 3),
    )
    ed = np.asarray(doc["edges"], dtype=np.float64)
    edg = nforge.Edges(src=ed[:, 0].astype(np.uint32), dst=ed[:, 1].astype(np.uint32),
                       w=ed[:, 2].astype(np.float32), lock=ed[:, 3].astype(np.uint8))
    names = {int(k): v for k, v in nn["names"].items()}
    return neu, edg, names


def doc_to_blocks(doc):
    """文档里的块 -> nforge.Blocks（权重块区和神经元块区拼在同一个文件里）。"""
    bs = doc.get("blocks") or []
    if not bs:
        return None
    ks, ns, src, dst, w, lock, sg = [], [], [], [], [], [], []
    any_lock = False
    for b in bs:
        s = [int(x) for x in b["src"]]
        d = [int(x) for x in b["dst"]]
        ks.append(len(s)); ns.append(len(d)); src += s; dst += d
        w += [float(x) for x in b["w"]]
        lk = b.get("lock")
        if lk:
            any_lock = True
        lock += [1 if (lk and lk[t]) else 0 for t in range(len(s) * len(d))]
        sg.append(int(b.get("sg") or 0))
    return nforge.Blocks(
        ks=np.asarray(ks, dtype=np.uint32), ns=np.asarray(ns, dtype=np.uint32),
        src=np.asarray(src, dtype=np.uint32), dst=np.asarray(dst, dtype=np.uint32),
        w=np.asarray(w, dtype=np.float32),
        lock=np.asarray(lock, dtype=np.uint8) if any_lock else None,
        sg=np.asarray(sg, dtype=np.uint32))


def sg_canonical(sgs):
    """把共享组号归一成「组内最靠前那块的下标 + 1」（0 = 独占）。

    文件里存的组号只在**段内**唯一，读回来本来就会变（文档里写 7，读回来可能是 1）；
    真正必须一致的是「谁跟谁一组」，不是那个数字本身。
    """
    first = {}
    for i, g in enumerate(sgs):
        g = int(g)
        if g and g not in first:
            first[g] = i
    return [0 if not int(g) else first[int(g)] + 1 for g in sgs]


def sg_shape(seq):
    """一组块的分组形状：只留「每组几个块」，不认组号本身。

    为什么不能直接比组号：文件里的组号是**段内**编号，只读其中一段时它必然从 1 重新数，
    所以"读一段"这种子集比较只能比分组形状（谁跟谁一组），不能比那个数字。
    """
    g = {}
    for x in seq:
        g.setdefault(x[-1], 0)
        g[x[-1]] += 1
    return sorted(g.values())


def norm_py_blocks(blk):
    """Blocks -> 每块一个元组，锁掩码全 0 的按「没有锁」算（跟浏览器端一致）。"""
    if blk is None or len(blk) == 0:
        return []
    ow, os_, od = blk.offsets
    canon = sg_canonical(blk.sg if blk.sg is not None else [0] * len(blk))
    out = []
    for i in range(len(blk)):
        lk = None
        if blk.lock is not None:
            sl = blk.lock[ow[i]:ow[i + 1]]
            if sl.any():
                lk = tuple(int(x) for x in sl)
        out.append((int(blk.ks[i]), int(blk.ns[i]),
                    tuple(int(x) for x in blk.src[os_[i]:os_[i + 1]]),
                    tuple(int(x) for x in blk.dst[od[i]:od[i + 1]]),
                    tuple(float(x) for x in blk.w[ow[i]:ow[i + 1]]), lk, canon[i]))
    return out


def norm_js_blocks(js):
    """浏览器回读的 blocks 数组 -> 跟 norm_py_blocks 同一种形状。"""
    out = []
    canon = sg_canonical([int(b.get("sg") or 0) for b in (js or [])])
    for bi, b in enumerate(js or []):
        lk = tuple(int(x) for x in b["lock"]) if b.get("lock") else None
        out.append((int(b["k"]), int(b["n"]),
                    tuple(int(x) for x in b["src"]),
                    tuple(int(x) for x in b["dst"]),
                    tuple(float(x) for x in b["w"]), lk, canon[bi]))
    return out


def edges_sorted(neu=None, edg=None, triples=None):
    if triples is None:
        triples = [(int(s), int(d), float(w), int(lk)) for s, d, w, lk
                   in zip(edg.src.tolist(), edg.dst.tolist(), edg.w.tolist(), edg.lock.tolist())]
    return sorted(triples)


def compare(tag, neu, edg, names, doc, blk=None):
    """把读回来的东西跟真值逐字段对。"""
    exp, exp_e, exp_names = doc_to_arrays(doc)
    log(len(neu) == N, tag + " 神经元数", f"{len(neu)} / {N}")
    log(np.array_equal(np.asarray(neu.pos, dtype=np.float32), exp.pos),
        tag + " 位置逐位一致（float32）")
    log(np.array_equal(neu.io, exp.io), tag + " 对外接口逐位一致")
    log(np.array_equal(neu.thr, exp.thr), tag + " 阈值逐位一致")
    log(np.array_equal(neu.act, exp.act), tag + " 激活函数逐位一致")
    log(np.array_equal(neu.bias, exp.bias), tag + " 偏置逐位一致")
    log(np.array_equal(neu.lock, exp.lock), tag + " 冻结位逐位一致")
    log(np.array_equal(neu.col_on, exp.col_on), tag + " 自定义色开关逐位一致")
    log(np.array_equal(np.asarray(neu.col, dtype=np.float32), exp.col),
        tag + " 颜色逐位一致（float32）")
    log(names == exp_names, tag + " 神经元名字表一致",
        "; ".join(f"{k}={v}" for k, v in sorted(names.items())))
    got_e = edges_sorted(edg=edg)
    want_e = edges_sorted(edg=exp_e)
    log(len(got_e) == len(want_e), tag + " 连接数", f"{len(got_e)} / {len(want_e)}")
    log(got_e == want_e, tag + " 每条连接的起点/终点/权重/冻结都一致",
        "" if got_e == want_e else f"首处不同 {got_e[:1]} vs {want_e[:1]}")
    want_b = norm_py_blocks(doc_to_blocks(doc))
    got_b = norm_py_blocks(blk)
    log(len(got_b) == len(want_b), tag + " 权重块数", f"{len(got_b)} / {len(want_b)}")
    log(got_b == want_b, tag + " 每个块的形状/两端 id/权重/锁掩码都逐位一致",
        "" if got_b == want_b else f"首处不同 {[got_b[:1], want_b[:1]]}")


def vol_of(chunks):
    """块的包围盒平均体积。这个数字就是空间分块的收益：相机靠近哪块，那块里
    到底包了多大的空间。线性切块下这个体积跟全图一个量级。"""
    vs = []
    for c in chunks:
        bx = c["bbox"]
        vs.append(max(1e-9, (bx[3] - bx[0]) * (bx[4] - bx[1]) * (bx[5] - bx[2])))
    return float(np.mean(vs)) if vs else 0.0


def compare_permuted(tag, neu, edg, names, blk, doc, perm, rank):
    """重排过的文件：文件里第 k 个神经元 = 文档里第 perm[k] 个。

    这里比的是"逐下标按位一致"，比"多重集相等"强得多：重排错一点、搬错一个
    字段，这里立刻见红。边与权重块的两端 id 按 rank 换算。
    """
    exp, exp_e, exp_names = doc_to_arrays(doc)
    perm = np.asarray(perm, dtype=np.int64)
    rank = np.asarray(rank, dtype=np.int64)
    log(len(neu) == N, tag + " 神经元数", f"{len(neu)} / {N}")
    log(np.array_equal(np.asarray(neu.pos, dtype=np.float32), exp.pos[perm]),
        tag + " 位置 = 文档按 perm 重排（按位）")
    log(np.array_equal(neu.io, exp.io[perm]), tag + " 对外接口 = 按 perm 重排（按位）")
    log(np.array_equal(neu.thr, exp.thr[perm]), tag + " 阈值 = 按 perm 重排（按位）")
    log(np.array_equal(neu.act, exp.act[perm]), tag + " 激活函数 = 按 perm 重排（按位）")
    log(np.array_equal(neu.bias, exp.bias[perm]), tag + " 偏置 = 按 perm 重排（按位）")
    log(np.array_equal(neu.lock, exp.lock[perm]), tag + " 冻结位 = 按 perm 重排（按位）")
    log(np.array_equal(neu.col_on, exp.col_on[perm]), tag + " 自定义色开关 = 按 perm 重排（按位）")
    log(np.array_equal(np.asarray(neu.col, dtype=np.float32), exp.col[perm]),
        tag + " 颜色 = 按 perm 重排（按位）")
    want_names = {int(rank[int(k)]): v for k, v in exp_names.items()}
    log(names == want_names, tag + " 神经元名字跟着重排",
        "; ".join(f"{k}={v}" for k, v in sorted(names.items())))
    got_e = edges_sorted(edg=edg)
    want_e = edges_sorted(edg=nforge.Edges(src=rank[exp_e.src], dst=rank[exp_e.dst],
                                           w=exp_e.w, lock=exp_e.lock))
    log(len(got_e) == len(want_e), tag + " 连接数", f"{len(got_e)} / {len(want_e)}")
    log(got_e == want_e, tag + " 每条连接的两端按 rank 重映射后逐位一致",
        "" if got_e == want_e else f"首处不同 {got_e[:1]} vs {want_e[:1]}")
    wb = doc_to_blocks(doc)
    if wb is not None:
        wb = nforge.Blocks(ks=wb.ks, ns=wb.ns, src=rank[wb.src], dst=rank[wb.dst],
                           w=wb.w, lock=wb.lock, sg=wb.sg)
    got_b, want_b = norm_py_blocks(blk), norm_py_blocks(wb)
    log(len(got_b) == len(want_b), tag + " 权重块数", f"{len(got_b)} / {len(want_b)}")
    log(got_b == want_b, tag + " 每个权重块的两端 id 按 rank 重映射后逐位一致",
        "" if got_b == want_b else f"首处不同 {[got_b[:1], want_b[:1]]}")


def prep():
    os.makedirs(DUMP, exist_ok=True)
    doc = make_doc()
    with open(DOC, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    neu, edg, names = doc_to_arrays(doc)
    blocks = doc_to_blocks(doc)
    with open(CFG, "w", encoding="utf-8") as f:
        # 切块大小只在这里定义一次：页面读它，Python 读它，两边不可能再写岔
        json.dump({"chunkJs": CHUNK_JS, "chunkPy": CHUNK_PY, "chunkSpatial": CHUNK_SP,
                   "n": N, "e": E}, f)
    info = nforge.write(PY_NFORGE, neu, edg, name=NAME, chunk_neurons=CHUNK_PY, names=names,
                        blocks=blocks)
    bad = nforge.check_index(info["header"])
    # 同一张图另写一份空间分块的（order=spatial）：两边各读一次对方写的
    info_s = nforge.write(PY_SPATIAL, neu, edg, name=NAME, chunk_neurons=CHUNK_SP, names=names,
                          blocks=blocks, order=nforge.ORDER_SPATIAL)
    bad_s = nforge.check_index(info_s["header"])
    # 同一张图再写一份"整段一个 blob"的旧形式：验证两种形式解出来完全一样
    info_w = nforge.write(PY_WHOLE, neu, edg, name=NAME, chunk_neurons=CHUNK_PY, names=names,
                          blocks=blocks, block_parts=False)
    bad_w = nforge.check_index(info_w["header"])
    print(f"prep: {DOC} 与 {PY_NFORGE}")
    hb = info["header"]
    print(f"      {N} 神经元 / {len(edg)} 连接 / {len(hb['chunks'])} 神经元块 / "
          f"{hb.get('blocks', {}).get('count', 0)} 权重块（{hb['counts']['blockWeights']} 个权重）/ "
          f"{info['bytes']} 字节")
    hs = info_s["header"]
    v_lin, v_sp = vol_of(hb["chunks"]), vol_of(hs["chunks"])
    print(f"      空间分块 order={hs['order']}：{len(hs['chunks'])} 块 / {info_s['bytes']} 字节；"
          f"平均包围盒体积 {v_lin:,.0f} -> {v_sp:,.0f}（收紧 {v_lin / v_sp:.1f} 倍）")
    hw = info_w["header"]
    print(f"      块区两种形式：分段 codec={hb.get('blocks', {}).get('codec')}"
          f"（{hb.get('blocks', {}).get('len', 0)} 字节 / {len(hb.get('blocks', {}).get('parts', []))} 段）"
          f"；整段 codec={hw.get('blocks', {}).get('codec')}（{hw.get('blocks', {}).get('len', 0)} 字节）")
    if bad or bad_s or bad_w:
        print("索引表自检没过：" + "；".join(bad + bad_s + bad_w), file=sys.stderr)
        return 1
    return 0


def check():
    fail_before = len([l for l in OUT if l.startswith("FAIL")])
    doc = json.load(open(DOC, encoding="utf-8"))

    # ---- A. 浏览器写、Python 读 ----
    if not os.path.exists(JS_NFORGE):
        log(False, "浏览器导出文件存在", JS_NFORGE + "（先跑 _crosscheck.html）")
    else:
        header, neu, edg, blk = nforge.read(JS_NFORGE)
        log(header["chunkNeurons"] == CHUNK_JS,
            "A. 文件头里的切块大小是浏览器写的那个", f"{header['chunkNeurons']}")
        log(len(header["chunks"]) == (N + CHUNK_JS - 1) // CHUNK_JS,
            "A. 块数", f"{len(header['chunks'])}")
        log(not nforge.check_index(header), "A. 索引表自洽")
        log(header.get("name") == NAME, "A. 工程名（UTF-8 走通）", header.get("name"))
        log(sum(1 for c in header["chunks"] if c["codec"] == "deflate") > 0,
            "A. 至少有一块真的是 deflate 压过的",
            "/".join(c["codec"] for c in header["chunks"]))
        log((header.get("blocks") or {}).get("count") == len(doc["blocks"]),
            "A. 文件头里的权重块数", str((header.get("blocks") or {}).get("count")))
        _wb0 = doc_to_blocks(doc)
        log(header["counts"].get("blockWeights") == _wb0.stored_weights,
            "A. 文件头里的块权重数是去重后的（共享组只算一份）",
            f"{header['counts'].get('blockWeights')} / 不去重 {_wb0.total_weights}")
        compare("A", neu, edg, {int(k): v for k, v in (header.get("names") or {}).items()}, doc, blk)

        # ---- A2. 块区"一块一段"：分段元数据必须跟 Python 算的逐字段一致 ----
        exp, _, _ = doc_to_arrays(doc)
        wb = doc_to_blocks(doc)
        bm = header.get("blocks") or {}
        parts = bm.get("parts") or []
        exp_parts, _exp_raws = nforge.encode_block_parts(wb, exp.pos)
        log(bm.get("codec") == "parts", "A. 块区是按段存的（codec=parts）", str(bm.get("codec")))
        log(len(parts) == len(exp_parts), "A. 分段数 = Python 算的分段数",
            f"{len(parts)} / {len(exp_parts)}")
        log(len(parts) < bm.get("count"),
            "A. 共享参数组整组一段：段数少于块数", f"{len(parts)} 段 / {bm.get('count')} 块")
        log(sum(len(p.get("blocks") or [p["i"]]) for p in parts) == bm.get("count"),
            "A. 每一块都恰好被一段装着")
        keys = ("k", "n", "weights", "all", "raw", "blocks", "bbox")
        def _mk(p):
            return tuple(tuple(v) if isinstance(v, list) else v for v in (p.get(k) for k in keys))
        got_meta = [_mk(p) for p in parts]
        want_meta = [_mk(p) for p in exp_parts]
        log(got_meta == want_meta,
            "A. 每段的形状/权重数(去重前后)/原始字节数/装着哪几块/包围盒 = Python 算的",
            "" if got_meta == want_meta else f"首处不同 {[got_meta[:1], want_meta[:1]]}")
        bad_codec = [p["i"] for p in parts if p.get("codec") not in ("raw", "deflate")]
        log(not bad_codec, "A. 每段的压缩方式合法", str(bad_codec))
        bad_len = [p["i"] for p in parts if not (p.get("len", 0) > 0)
                   or (p["codec"] == "raw" and p["len"] != p["raw"])
                   or (p["codec"] == "deflate" and p["len"] >= p["raw"])]
        log(not bad_len, "A. 每段的长度跟压缩方式对得上", str(bad_len))
        acc, gaps = 0, 0
        for p in parts:
            if p["off"] != acc:
                gaps += 1
            acc += p["len"]
        log(gaps == 0, "A. 各段首尾相接（off 就是前面所有段长度之和）", f"共 {acc} 字节")
        log(acc == bm.get("len") and sum(p["raw"] for p in parts) == bm.get("raw"),
            "A. 各段长度之和 = 区长，各段原始字节之和 = 区原始字节",
            f"{acc} / {bm.get('len')}，{sum(p['raw'] for p in parts)} / {bm.get('raw')}")
        log(sum(p["k"] for p in parts) == bm.get("rows")
            and sum(p["n"] for p in parts) == bm.get("cols"),
            "A. 各段行列之和 = 区的行列", f"{bm.get('rows')} / {bm.get('cols')}")
        # 只读一段：读的字节数必须正好是那一段，解出来的块跟文档里对应的那几块一致
        # （共享组那一段装两块；引用表在段内解析，所以解出来两块是"同一个参数"）
        gp = [p for p in parts if len(p.get("blocks") or []) > 1]
        log(len(gp) == 1, "A. 恰好一段装着共享参数组（两块一段）", str(len(gp)))
        sel = gp[0] if gp else parts[0]
        _h2, one, _d2, nbytes = nforge.read_blocks(JS_NFORGE, ids=[sel["i"]])
        got_one = norm_py_blocks(one)
        want_one = [norm_py_blocks(wb)[i] for i in (sel.get("blocks") or [sel["i"]])]
        log([x[:6] for x in got_one] == [x[:6] for x in want_one]
            and sg_shape(got_one) == sg_shape(want_one),
            "A. 只读那一段：解出来的就那几块（含共享组），跟文档逐位一致", f"{len(got_one)} 块")
        log(nbytes == sel["len"], "A. 只读那一段：从盘上读的字节数 = 那一段的长度",
            f"{nbytes} / {sel['len']}")
        if gp:
            log(sorted(int(x) for x in one.sg) == [1, 1],
                "A. 共享组读回来两块同组（段内组号 1）",
                str([int(x) for x in one.sg]))
            _gw, _gs, _gd = one.offsets
            log(np.array_equal(one.w[_gw[0]:_gw[1]], one.w[_gw[1]:_gw[2]]),
                "A. 共享组两块读回来的权重完全一样")
            log(one.stored_weights < one.total_weights,
                "A. 共享组这一段只存了一份权重",
                f"{one.stored_weights} / 不去重 {one.total_weights}")
            _ks = [int(x) for x in one.ks]
            _ns = [int(x) for x in one.ns]
            log(_ks == [3, 2] and _ns == [2, 3],
                "A. 共享组那两块形状互为转置（3×2 / 2×3），元素总数一样",
                f"{_ks} / {_ns}")
            _ow, _os, _od = one.offsets
            log(int(_ow[1] - _ow[0]) == int(_ow[2] - _ow[1]) == 6,
                "A. 转置共享：两块的权重区间长度一样（同一段 6 个数值各按自己的形状读）",
                f"{int(_ow[1] - _ow[0])} / {int(_ow[2] - _ow[1])}")

    # ---- B. Python 写、浏览器读 ----
    if not os.path.exists(JS_BACK):
        log(False, "浏览器回读结果存在", JS_BACK + "（先跑 _crosscheck.html）")
    else:
        back = json.load(open(JS_BACK, encoding="utf-8"))
        if back.get("error"):
            log(False, "B. 浏览器读 cross_from_py.nforge", back["error"])
        else:
            log(back["counts"]["neurons"] == N, "B. 浏览器读出来的神经元数",
                f"{back['counts']['neurons']} / {N}")
            log(back["counts"]["edges"] == E, "B. 浏览器读出来的连接数",
                f"{back['counts']['edges']}")
            log(back["header"]["chunkNeurons"] == CHUNK_PY,
                "B. 浏览器认出了 Python 写的切块大小", str(back["header"]["chunkNeurons"]))
            log(back["counts"]["chunks"] == (N + CHUNK_PY - 1) // CHUNK_PY,
                "B. 浏览器认出的块数", str(back["counts"]["chunks"]))
            log(back.get("dropped") == 0, "B. 全量载入没有丢连接", str(back.get("dropped")))
            log(back["name"] == NAME, "B. 工程名（UTF-8 反向走通）", back["name"])

            exp, _, _ = doc_to_arrays(doc)
            got_pos = np.asarray(back["pos"], dtype=np.float32).reshape(-1, 3)
            log(np.array_equal(got_pos, exp.pos), "B. 位置逐位一致（float32）")
            log(np.array_equal(np.asarray(back["io"], dtype=np.uint8), exp.io),
                "B. 对外接口逐位一致")
            log(np.array_equal(np.asarray(back["thr"], dtype=np.float32), exp.thr),
                "B. 阈值逐位一致")
            log(np.array_equal(np.asarray(back["act"], dtype=np.uint8), exp.act),
                "B. 激活函数逐位一致")
            log(np.array_equal(np.asarray(back["bias"], dtype=np.float32), exp.bias),
                "B. 偏置逐位一致")
            log(np.array_equal(np.asarray(back["lock"], dtype=np.uint8), exp.lock),
                "B. 冻结位逐位一致")
            log(np.array_equal(np.asarray(back["colOn"], dtype=np.uint8), exp.col_on),
                "B. 自定义色开关逐位一致")
            log(np.array_equal(np.asarray(back["col"], dtype=np.float32).reshape(-1, 3), exp.col),
                "B. 颜色逐位一致（float32）")
            log({int(k): v for k, v in (back.get("names") or {}).items()} ==
                {int(k): v for k, v in doc["neurons"]["names"].items()},
                "B. 神经元名字表一致（含中文与 emoji）",
                "; ".join(f"{k}={v}" for k, v in sorted(
                    {int(k): v for k, v in (back.get("names") or {}).items()}.items())))
            got_b = norm_js_blocks(back.get("blocks"))
            want_b = norm_py_blocks(doc_to_blocks(doc))
            log(back.get("blocksLoaded") == len(doc["blocks"]),
                "B. 浏览器认出并载入的权重块数", str(back.get("blocksLoaded")))
            log(back.get("blocksDropped") == 0, "B. 全量载入没有丢权重块",
                str(back.get("blocksDropped")))
            log(back.get("blocksSkipped") == 0, "B. 全量载入一段都没跳过",
                str(back.get("blocksSkipped")))
            bm_py = nforge.read_header(PY_NFORGE).get("blocks") or {}
            log(back.get("blockBytes") == bm_py.get("len"),
                "B. 全量载入时按段读的字节数 = 各段长度之和",
                f"{back.get('blockBytes')} / {bm_py.get('len')}")
            log(got_b == want_b, "B. 每个块的形状/两端 id/权重/锁掩码/共享组号都逐位一致",
                "" if got_b == want_b else f"首处不同 {[got_b[:1], want_b[:1]]}")
            sh = back.get("share") or []
            grp = [x for x in sh if x[1]]
            log(len(grp) == 2 and all(x[2] for x in grp),
                "B. 共享参数组跨语言读回来还在（2 块同组、互相指认）", json.dumps(grp))
            _gblocks = back.get("blocks") or []
            _gshapes = [f"{b['k']}×{b['n']}" for b in _gblocks if int(b.get("sg") or 0)]
            log(sorted(_gshapes) == ["2×3", "3×2"],
                "B. 转置共享：浏览器这边也认形状不同、元素总数相同的一组（3×2 / 2×3）",
                str(_gshapes))
            _garr = [int(x) for x in (back.get("blockArr") or [])]
            _gidx = [i for i, b in enumerate(_gblocks) if int(b.get("sg") or 0)]
            _gids = [_garr[i] for i in _gidx if i < len(_garr)]
            log(len(set(_gids)) == 1 and _gids and _gids[0] > 0,
                "B. 转置共享：浏览器读回来两块是同一份数组（身份号相同）", str(_gids))
            log(back.get("blockTotal") == _wb0.stored_weights
                and back.get("blockTotalAll") == _wb0.total_weights,
                "B. 浏览器算的去重前后权重数 = Python 算的",
                f"{back.get('blockTotal')} / {back.get('blockTotalAll')}")
            got_e = edges_sorted(triples=[tuple(x) for x in back["edges"]])
            want_e = edges_sorted(edg=nforge.Edges(
                src=np.asarray([e[0] for e in doc["edges"]], dtype=np.uint32),
                dst=np.asarray([e[1] for e in doc["edges"]], dtype=np.uint32),
                w=np.asarray([e[2] for e in doc["edges"]], dtype=np.float32),
                lock=np.asarray([e[3] for e in doc["edges"]], dtype=np.uint8)))
            log(got_e == want_e, "B. 每条连接的起点/终点/权重/冻结都一致",
                "" if got_e == want_e else "首处不同")

    # ---- E. 同一张图，浏览器写成"整段一个 blob"的旧形式 ----
    if not os.path.exists(JS_WHOLE):
        log(False, "浏览器导出的整段形式文件存在", JS_WHOLE + "（先跑 _crosscheck.html）")
    else:
        hdr_w, _neu_w, _edg_w, blk_w = nforge.read(JS_WHOLE)
        bmw = hdr_w.get("blocks") or {}
        log(bmw.get("codec") in ("raw", "deflate") and "parts" not in bmw,
            "E. 整段形式：codec 是 raw/deflate 且没有 parts", str(bmw.get("codec")))
        log(not nforge.check_index(hdr_w), "E. 索引表自洽")
        log(norm_py_blocks(blk_w) == norm_py_blocks(doc_to_blocks(doc)),
            "E. 整段形式解出来的块跟文档逐位一致",
            f"{len(norm_py_blocks(blk_w))} 块")

    # ---- 两种形式等价：同一张图，Python 写的分段与整段两份，解出来必须一样 ----
    if os.path.exists(PY_WHOLE):
        _hw, _n2, _e2, blk_whole = nforge.read(PY_WHOLE)
        _hp, _n3, _e3, blk_parts = nforge.read(PY_NFORGE)
        log((_hw.get("blocks") or {}).get("codec") in ("raw", "deflate")
            and (_hp.get("blocks") or {}).get("codec") == "parts",
            "两种形式：codec 分别是 raw/deflate 与 parts")
        log(norm_py_blocks(blk_whole) == norm_py_blocks(blk_parts),
            "两种形式解出来的权重块完全一样")
        # 分段形式按段读（只读其中两段）跟整段形式读出来也必须一致
        _all_parts = (_hp.get("blocks") or {}).get("parts", [])
        _sel = [p for p in _all_parts if p["i"] in (1, 3)]
        _hb, blk_two, _d3, nb_two = nforge.read_blocks(PY_NFORGE, ids=[1, 3])
        _ref = norm_py_blocks(doc_to_blocks(doc))
        want_two = []
        for _p in _sel:
            for _bi in (_p.get("blocks") or [_p["i"]]):
                want_two.append(_ref[_bi])
        log([x[:6] for x in norm_py_blocks(blk_two)] == [x[:6] for x in want_two]
            and sg_shape(norm_py_blocks(blk_two)) == sg_shape(want_two),
            "按段读第 1、3 段 = 文档里对应的那几块", f"读了 {nb_two} 字节")
        log(nb_two == sum(p["len"] for p in _sel),
            "按段读两段只读了这两段的字节", f"{nb_two} 字节")

    # ---- C. 空间分块：浏览器写（先按 Z 序重排再切块），Python 读 ----
    exp, exp_e, exp_names = doc_to_arrays(doc)
    perm, rank, splan = nforge.spatial_order(exp.pos, CHUNK_SP)
    plan_py = [[int(a), int(b)] for a, b in splan]
    if not os.path.exists(JS_SPATIAL) or not os.path.exists(JS_SPATIAL_PLAN):
        log(False, "浏览器导出的空间分块文件存在",
            JS_SPATIAL + " / " + JS_SPATIAL_PLAN + "（先跑 _crosscheck.html）")
    else:
        pj = json.load(open(JS_SPATIAL_PLAN, encoding="utf-8"))
        log(pj.get("target") == CHUNK_SP, "C. 页面用的空间分块软目标", str(pj.get("target")))
        log(pj.get("perm") == perm.tolist(), "C. 神经元 Z 序 perm 跟 Python 逐位相同",
            f"{len(pj.get('perm') or [])} 个" if pj.get("perm") == perm.tolist() else "对不上")
        log(pj.get("rank") == rank.tolist(), "C. rank 跟 Python 逐位相同")
        log(pj.get("plan") == plan_py, "C. 八叉树叶子的块区间跟 Python 逐个相同",
            f"{len(plan_py)} 块" if pj.get("plan") == plan_py else f"{pj.get('plan')} vs {plan_py}")
        header, neu_s, edg_s, blk_s = nforge.read(JS_SPATIAL)
        log(header.get("order") == "spatial", "C. 文件头写明 order=spatial", str(header.get("order")))
        log(header.get("chunkNeurons") == CHUNK_SP, "C. 文件头里的软目标",
            str(header.get("chunkNeurons")))
        log(not nforge.check_index(header), "C. 索引表自洽")
        lin_chunks = (N + CHUNK_JS - 1) // CHUNK_JS
        log(len(header["chunks"]) > lin_chunks, "C. 块数比线性切块多（块 = 空间区域，切得更碎）",
            f"{len(header['chunks'])} > {lin_chunks}")
        log([c["n0"] for c in header["chunks"]] == [a for a, b in plan_py] and
            [c["n1"] for c in header["chunks"]] == [b for a, b in plan_py],
            "C. 文件里的块界 = Python 算出来的 plan（量化/稳定排序/八叉树切分都对上了）")
        bad_box = [c["i"] for c, (a, b) in zip(header["chunks"], plan_py)
                   if c["bbox"] != nforge._bbox(exp.pos[perm[a:b]])]
        log(not bad_box, "C. 每块的包围盒 = 按 perm 取坐标算出来的",
            f"第一个不对的是第 {bad_box[0]} 块" if bad_box else f"{len(plan_py)} 块全一致")
        v_lin = vol_of(nforge.read_header(PY_NFORGE)["chunks"])
        v_sp = vol_of(header["chunks"])
        log(v_sp < v_lin, "C. 空间分块的包围盒平均体积比线性切块小",
            f"{v_lin:,.0f} -> {v_sp:,.0f}（收紧 {v_lin / v_sp:.1f} 倍）")
        compare_permuted("C", neu_s, edg_s,
                         {int(k): v for k, v in (header.get("names") or {}).items()},
                         blk_s, doc, perm, rank)

    # ---- D. Python 写空间分块，浏览器读 ----
    if not os.path.exists(JS_SPATIAL_BACK):
        log(False, "浏览器回读空间分块文件的结果存在",
            JS_SPATIAL_BACK + "（先跑 _crosscheck.html）")
    else:
        back = json.load(open(JS_SPATIAL_BACK, encoding="utf-8"))
        if back.get("error"):
            log(False, "D. 浏览器读 cross_from_py_spatial.nforge", back["error"])
        else:
            log(back.get("header", {}).get("order") == "spatial",
                "D. 浏览器认出了 order=spatial", str(back.get("header", {}).get("order")))
            log(back["counts"]["neurons"] == N, "D. 浏览器读出来的神经元数",
                f"{back['counts']['neurons']} / {N}")
            log(back["counts"]["edges"] == E, "D. 浏览器读出来的连接数", str(back["counts"]["edges"]))
            log(back.get("dropped") == 0, "D. 全量载入没有丢连接", str(back.get("dropped")))
            log(np.array_equal(np.asarray(back["pos"], dtype=np.float32).reshape(-1, 3), exp.pos[perm]),
                "D. 位置 = Python 的空间重排结果（按位）")
            log(np.array_equal(np.asarray(back["io"], dtype=np.uint8), exp.io[perm]),
                "D. 对外接口 = 按 perm 重排")
            log(np.array_equal(np.asarray(back["thr"], dtype=np.float32), exp.thr[perm]),
                "D. 阈值 = 按 perm 重排")
            log(np.array_equal(np.asarray(back["act"], dtype=np.uint8), exp.act[perm]),
                "D. 激活函数 = 按 perm 重排")
            log(np.array_equal(np.asarray(back["bias"], dtype=np.float32), exp.bias[perm]),
                "D. 偏置 = 按 perm 重排")
            log(np.array_equal(np.asarray(back["lock"], dtype=np.uint8), exp.lock[perm]),
                "D. 冻结位 = 按 perm 重排")
            log(np.array_equal(np.asarray(back["colOn"], dtype=np.uint8), exp.col_on[perm]),
                "D. 自定义色开关 = 按 perm 重排")
            log(np.array_equal(np.asarray(back["col"], dtype=np.float32).reshape(-1, 3), exp.col[perm]),
                "D. 颜色 = 按 perm 重排")
            want_nm = {int(rank[int(k)]): v for k, v in exp_names.items()}
            got_nm = {int(k): v for k, v in (back.get("names") or {}).items()}
            log(got_nm == want_nm, "D. 名字表跟着重排",
                "; ".join(f"{k}={v}" for k, v in sorted(got_nm.items())))
            got_e = edges_sorted(triples=[tuple(x) for x in back["edges"]])
            want_e = edges_sorted(edg=nforge.Edges(src=rank[exp_e.src], dst=rank[exp_e.dst],
                                                   w=exp_e.w, lock=exp_e.lock))
            log(got_e == want_e, "D. 每条连接的两端按 rank 重映射后逐位一致",
                "" if got_e == want_e else "首处不同")
            wb = doc_to_blocks(doc)
            wb = nforge.Blocks(ks=wb.ks, ns=wb.ns, src=rank[wb.src], dst=rank[wb.dst],
                               w=wb.w, lock=wb.lock, sg=wb.sg)
            log(norm_js_blocks(back.get("blocks")) == norm_py_blocks(wb),
                "D. 权重块两端 id 按 rank 重映射后逐位一致")

    # ---- F. Python 写"整段一个 blob"，浏览器读 ----
    if not os.path.exists(JS_WHOLE_BACK):
        log(False, "浏览器回读整段形式的結果存在",
            JS_WHOLE_BACK + "（先跑 _crosscheck.html）")
    else:
        backw = json.load(open(JS_WHOLE_BACK, encoding="utf-8"))
        if backw.get("error"):
            log(False, "F. 浏览器读 cross_from_py_whole.nforge", backw["error"])
        else:
            log(backw.get("header", {}).get("blocksCodec") in ("raw", "deflate"),
                "F. 浏览器认出整段形式", str(backw.get("header", {}).get("blocksCodec")))
            log(backw["counts"]["neurons"] == N, "F. 整段形式读出来的神经元数",
                f"{backw['counts']['neurons']} / {N}")
            log(backw.get("blocksDropped") == 0 and backw.get("blocksSkipped") == 0,
                "F. 全量载入没丢块也没跳段",
                f"丢 {backw.get('blocksDropped')} / 跳 {backw.get('blocksSkipped')}")
            log(norm_js_blocks(backw.get("blocks")) == norm_py_blocks(doc_to_blocks(doc)),
                "F. 整段形式读出来的块跟文档逐位一致")
            if os.path.exists(JS_BACK):
                backb = json.load(open(JS_BACK, encoding="utf-8"))
                log(backw.get("blocks") == backb.get("blocks"),
                    "F. 分段形式与整段形式读出来的块完全一样")
                log(backw.get("sameAsParts") is True,
                    "F. 页面自己也对了一遍（两种形式的块逐字节相同）", str(backw.get("sameAsParts")))

    for l in OUT:
        print(l)
    fails = len([l for l in OUT if l.startswith("FAIL")]) - fail_before
    print(f"\n== {len(OUT) - fail_before - fails} PASS / {fails} FAIL ==")
    return 1 if fails else 0


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    sys.exit(prep() if mode == "prep" else check())
