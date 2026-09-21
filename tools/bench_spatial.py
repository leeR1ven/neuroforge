"""空间分块（Morton Z 序 + 八叉树）的实测基准。

跑法：
    py -3 tools/bench_spatial.py            # 默认 20000 神经元
    py -3 tools/bench_spatial.py 60000

为什么单独一个脚本：README 里“块从一堆散点变成一小片空间”
这句话必须有个能重跑的数字撑着。这里造一张**编号与空间
完全无关**的随机 3D 图（这才是真实模型的常态），分别按“神经元
区间”和“空间 Z 序”写两份 .nforge，然后比：

    * 块数 / 文件字节数 / 写盘耗时
    * 每块包围盒的平均体积（这才是“靠近才载入”真正省下的东西）
    * 块内坐标的标准差（越小说明块里越挤在一处）
    * 一个随机点落在多少个块的包围盒里（相机看向哪里，大概就要解压这些块）
    * 两种切法写出来的图是不是**逐字段等价**（重排只许改编号，不许改内容）

任何一项对不上就退出码非 0。跟 Python 侧的实现一样，这里也只用
tools/nforge.py 已有的函数，不另写一套。
"""
from __future__ import annotations

import os
import sys
import time

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nforge  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUMP = os.path.join(ROOT, "_dump")
SEED = 7
TARGET = 2000        # 每块神经元数的软目标（八叉树只会切得更细）


def make_graph(n, e, span=1000.0):
    rng = np.random.default_rng(SEED)
    pos = (rng.random((n, 3)) * span).astype(np.float32)
    src = rng.integers(0, n, e).astype(np.uint32)
    dst = rng.integers(0, n, e).astype(np.uint32)
    same = src == dst
    dst[same] = (dst[same] + 1) % n
    w = (rng.random(e).astype(np.float32) - 0.5) * 2.0
    return pos, src, dst, w


def graph_of(pos, src, dst, w):
    i = np.arange(len(pos))
    neu = nforge.Neurons(
        pos=pos, io=(i % 4).astype(np.uint8),
        thr=((i % 13) / 64.0).astype(np.float32), act=(i % 8).astype(np.uint8),
        bias=((i % 17) / 64.0 - 0.125).astype(np.float32), lock=(i % 2).astype(np.uint8),
        col_on=(i % 3 == 0).astype(np.uint8),
        col=(((np.arange(len(pos) * 3) % 32) / 32.0).reshape(-1, 3)).astype(np.float32),
    )
    edg = nforge.Edges(src=src, dst=dst, w=w, lock=(np.arange(len(src)) % 2).astype(np.uint8))
    return neu, edg


def box_vols(header):
    out = []
    for c in header["chunks"]:
        b = c["bbox"]
        out.append(max(1e-9, (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2])))
    return np.asarray(out)


def spread(pos, header):
    """块内坐标标准差的加权平均（按块大小加权）。越小 = 块里越挤在一处。"""
    acc, tot = 0.0, 0
    for c in header["chunks"]:
        sl = pos[c["n0"]:c["n1"]]
        if len(sl) < 2:
            continue
        acc += float(np.mean(np.std(sl, axis=0))) * len(sl)
        tot += len(sl)
    return acc / tot if tot else 0.0


def etrip(edg):
    """把边变成可比的多重集。文件里的边是**按新起点升序**存的（这样
    每块才自带一段连续的出边），所以只能比多重集，不能直接比数组。"""
    return sorted(zip(edg.src.tolist(), edg.dst.tolist(), edg.w.tolist(), edg.lock.tolist()))


def boxes_hit(header, pt):
    """包围盒含这个点的块有几个。相机看向一个小区域时，大概就这么多块需要解压。"""
    k = 0
    for c in header["chunks"]:
        b = c["bbox"]
        if b[0] <= pt[0] <= b[3] and b[1] <= pt[1] <= b[4] and b[2] <= pt[2] <= b[5]:
            k += 1
    return k


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20000
    e = n * 3
    os.makedirs(DUMP, exist_ok=True)
    pos, src, dst, w = make_graph(n, e)
    neu, edg = graph_of(pos, src, dst, w)
    perm, rank, plan = nforge.spatial_order(neu.pos, TARGET)
    print(f"{n:,} 神经元 / {e:,} 连接 / 随机撒在 1000^3 立方体里（编号与空间无关）")
    print()

    res = {}
    for tag, order in (("linear", nforge.ORDER_LINEAR), ("spatial", nforge.ORDER_SPATIAL)):
        p = os.path.join(DUMP, "bench_" + tag + ".nforge")
        t0 = time.perf_counter()
        info = nforge.write(p, neu, edg, name="bench-" + tag, chunk_neurons=TARGET, order=order)
        ms = (time.perf_counter() - t0) * 1000.0
        res[tag] = (p, info)
        h = info["header"]
        v = box_vols(h)
        pos_w = neu.pos[perm] if order == nforge.ORDER_SPATIAL else neu.pos
        print(f"  {tag:7s} order={order:7s} -> {len(h['chunks']):5d} 块 / {info['bytes']:10,d} 字节 / "
              f"写盘 {ms:7.1f} ms / 平均包围盒体积 {v.mean():18,.0f} / "
              f"块内坐标标准差 {spread(pos_w, h):7.1f}")

    hl = res["linear"][1]["header"]
    hs = res["spatial"][1]["header"]
    vl, vs = box_vols(hl), box_vols(hs)
    rng_ = np.random.default_rng(SEED + 1)
    pts = rng_.random((20, 3)) * 1000.0
    hit_l = float(np.mean([boxes_hit(hl, p) for p in pts]))
    hit_s = float(np.mean([boxes_hit(hs, p) for p in pts]))
    sp_l, sp_s = spread(neu.pos, hl), spread(neu.pos[perm], hs)
    print()
    print(f"  包围盒体积：平均 {vl.mean():,.0f} -> {vs.mean():,.0f}"
          f"（收紧 {vl.mean() / vs.mean():.1f} 倍），总和 {vl.sum():,.0f} -> {vs.sum():,.0f}")
    print(f"  块内坐标标准差：{sp_l:.1f} -> {sp_s:.1f}（收紧 {sp_l / sp_s:.1f} 倍）")
    print(f"  随机取 20 个点，包围盒含它的块数平均：{hit_l:.1f} -> {hit_s:.1f}"
          f"（即“看向一处大概要解压多少块”）")
    print()

    # ---- 等价性：重排只允许改编号，不允许改内容 ----
    ok = True
    bad = nforge.check_index(hl) + nforge.check_index(hs)
    hl2, nl, el, _ = nforge.read(res["linear"][0])
    hs2, ns, es, _ = nforge.read(res["spatial"][0])
    checks = [
        ("两份文件的索引表都自洽", not bad),
        ("spatial 块界 = spatial_order() 算出来的 plan",
         [(c["n0"], c["n1"]) for c in hs["chunks"]] == [(int(a), int(b)) for a, b in plan]),
        ("spatial 神经元字段 = 原图按 perm 重排（逐位）",
         all(np.array_equal(a, b) for a, b in (
             (ns.pos, neu.pos[perm]), (ns.io, neu.io[perm]), (ns.thr, neu.thr[perm]),
             (ns.act, neu.act[perm]), (ns.bias, neu.bias[perm]), (ns.lock, neu.lock[perm]),
             (ns.col_on, neu.col_on[perm]), (ns.col, neu.col[perm])))),
        ("linear 读回来跟原图逐位一致",
         all(np.array_equal(a, b) for a, b in (
             (nl.pos, neu.pos), (nl.io, neu.io), (nl.thr, neu.thr), (nl.act, neu.act),
             (nl.bias, neu.bias), (nl.lock, neu.lock), (nl.col_on, neu.col_on), (nl.col, neu.col)))),
        ("spatial 边集 = 原图两端按 rank 重映射（含权重与冻结位）",
         etrip(es) == etrip(nforge.Edges(src=rank[edg.src], dst=rank[edg.dst],
                                         w=edg.w, lock=edg.lock))),
        ("spatial 的边按新起点升序（块才能自带一段连续的出边）",
         bool(np.all(np.diff(es.src.astype(np.int64)) >= 0))),
        ("两份文件的神经元数 / 连接数一致",
         len(ns) == len(nl) and len(es) == len(el) == e),
    ]
    for name, good in checks:
        print(("  ok   " if good else "  FAIL ") + name)
        ok = ok and bool(good)
    print()
    print("结论: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
