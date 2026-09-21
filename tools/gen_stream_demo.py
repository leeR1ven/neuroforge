# -*- coding: utf-8 -*-
"""造一份「块数很多」的 .nforge 样本，专门用来验流式载入。

跟 gen_blk_demo.py 的区别：那份是给分块渲染 / 权重块看的（2 块），这份要的是
**几十块**，而且刻意让大量边跨块（src 在本块、dst 在后面的块），这样才走得到
「挂起 -> 对端块载入时补上」那条路。权重块也是**每块一个**（24 个 32x16 的块），
而且它们在文件里是「一块一段」存的，于是能验"只读相机附近的那几段权重块"。

块的排布也刻意拉开：第 k 块坐落在 x = k * GAP 上，每块内部是一个 16x8x16 的立方
网格。于是「相机靠近哪一块」是个真实可判的几何问题，而不是所有块挤在一起。

用法：
  py -3 tools/gen_stream_demo.py                     # 默认 24 块 x 2048 神经元
  py -3 tools/gen_stream_demo.py --chunks 40 --per 1024
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np

import nforge as NF

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "prototype", "_streamdemo_raw.nforge")

GAP = 1500.0        # 块与块之间的中心距（越大，远处块越容易被判成「不值得解压」）
STEP = 30.0         # 块内格点间距


def build(nchunks: int, per: int, compress: bool, seed: int = 11):
    assert per == 2048, "块内网格按 16x8x16 = 2048 写死，换 per 要顺手改网格"
    rng = np.random.default_rng(seed)
    n = nchunks * per

    a = np.arange(per)
    gx = (a % 16) - 7.5
    gy = ((a // 16) % 8) - 3.5
    gz = (a // 128) - 7.5
    local = np.stack([gx * STEP, gy * STEP, gz * STEP], axis=1).astype(np.float32)

    pos = np.zeros((n, 3), dtype=np.float32)
    for k in range(nchunks):
        pos[k * per:(k + 1) * per] = local + np.array([k * GAP, 0.0, 0.0], dtype=np.float32)

    io = np.zeros(n, dtype=np.uint8)
    io[:16] = NF.IO_IN                       # 头一块的头几个：接收外界信号
    io[-8:] = NF.IO_OUT                      # 最后一块的末尾几个：输出到外界
    io[per] = NF.IO_BOTH

    thr = np.full(n, 0.5, dtype=np.float32)
    thr[::7] = 0.25
    thr[::11] = 0.8

    act = np.zeros(n, dtype=np.uint8)
    act[3::4] = 1                            # relu
    act[5::13] = 3                           # sigmoid

    bias = (rng.random(n).astype(np.float32) - 0.5) * 0.2

    lock = np.zeros(n, dtype=np.uint8)
    lock[per:per + 4] = 1

    col_on = np.zeros(n, dtype=np.uint8)
    col_on[8::64] = 1
    col = np.zeros((n, 3), dtype=np.float32)
    col[:, 0] = 0.2 + 0.6 * ((np.tile(a, nchunks) % 16) / 15.0)
    col[:, 2] = 0.4

    srcs, dsts, ws, elock = [], [], [], []
    for k in range(nchunks):
        lo, hi = k * per, (k + 1) * per
        s = np.arange(lo, hi, dtype=np.uint32)

        # (a) 块内：往前跳 3 个（dst 一定在本块里，载入时立刻就能接上）
        dsts.append((lo + ((s - lo + 3) % per)).astype(np.uint32))
        srcs.append(s)
        ws.append(((rng.random(per).astype(np.float32) * 2 - 1) * 0.5))
        elock.append(np.zeros(per, dtype=np.uint8))

        # (b) 跨到下一块：src 在 k、dst 在 k+1 -> 载 k 时 dst 还没来，必须挂起
        if k + 1 < nchunks:
            srcs.append(s)
            dsts.append(((k + 1) * per + ((s - lo) % per)).astype(np.uint32))
            ws.append(((rng.random(per).astype(np.float32) * 2 - 1) * 0.3))
            elock.append(np.zeros(per, dtype=np.uint8))

        # (c) 跨到后面第 3 块：挂得更久一点
        if k + 3 < nchunks:
            srcs.append(s)
            dsts.append(((k + 3) * per + ((s - lo + 7) % per)).astype(np.uint32))
            ws.append(((rng.random(per).astype(np.float32) * 2 - 1) * 0.2))
            elock.append(np.ones(per, dtype=np.uint8))

    src = np.concatenate(srcs)
    dst = np.concatenate(dsts)
    w = np.concatenate(ws)
    el = np.concatenate(elock)

    # 定几个名字（按文件 id 存），验流式载入时名字能不能正确对到 live id 上
    names = {}
    for k in range(nchunks):
        if k % 4 == 0:
            names[str(k * per)] = "块%d_头" % k
        if k == nchunks - 1:
            names[str(n - 1)] = "out_末"

    # 权重块：**每块神经元配一个**（src/dst 都取自本块），于是每个权重块都待在本块
    # 那一带。文件里块区是「一块一段」存的、每段带包围盒，所以"只载入相机附近的
    # 权重块"才是个真实可判的几何问题——这也是这份样本存在的意义之一。
    # 每段 32x16 = 512 个权重 = 2272 字节，刚好越过"值得压缩"的门槛，顺带验分段压缩。
    bk, bn = 32, 16
    ks, ns, bsrc, bdst, bw = [], [], [], [], []
    for k in range(nchunks):
        lo = k * per
        ks.append(bk)
        ns.append(bn)
        bsrc.append(np.arange(lo, lo + bk, dtype=np.uint32))
        bdst.append(np.arange(lo + bk, lo + bk + bn, dtype=np.uint32))
        bw.append(rng.random(bk * bn).astype(np.float32))
    blk = NF.Blocks(
        ks=np.array(ks, dtype=np.uint32), ns=np.array(ns, dtype=np.uint32),
        src=np.concatenate(bsrc), dst=np.concatenate(bdst),
        w=np.concatenate(bw), lock=np.zeros(nchunks * bk * bn, dtype=np.uint8),
    )

    neu = NF.Neurons(pos=pos, io=io, thr=thr, act=act, bias=bias,
                     lock=lock, col_on=col_on, col=col)
    edg = NF.Edges(src=src, dst=dst, w=w, lock=el)
    r = NF.write(OUT, neu, edg, name="stream_demo", chunk_neurons=per,
                 names=names, compress=compress, blocks=blk)
    return r


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunks", type=int, default=24)
    ap.add_argument("--per", type=int, default=2048)
    ap.add_argument("--no-compress", action="store_true")
    args = ap.parse_args(argv)

    r = build(args.chunks, args.per, not args.no_compress)
    h = r["header"]
    by = {}
    for c in h["chunks"]:
        by[c["codec"]] = by.get(c["codec"], 0) + 1
    print("样本就绪：", OUT)
    print("  %d 字节（%.1f KB）  块 %d  神经元 %d  连接 %d  权重块 %d（%s，%d 段 / %d 字节）"
          % (r["bytes"], r["bytes"] / 1024.0, len(h["chunks"]),
             h["counts"]["neurons"], h["counts"]["edges"], h.get("blocks", {}).get("count", 0),
             h.get("blocks", {}).get("codec"), len(h.get("blocks", {}).get("parts", [])),
             h.get("blocks", {}).get("len", 0)))
    print("  压缩方式：", by, " 头长度", len(h.get("chunks", [])), "条索引")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
