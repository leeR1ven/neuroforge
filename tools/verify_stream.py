# -*- coding: utf-8 -*-
"""对拍：浏览器端「流式载入」解出来的每一块 == Python 端按块读解出来的同一块。

浏览器那半边由 prototype/_streamcheck.html 跑完写下的 _dump/streamcheck.json 提供
（chunkDigests）。这里只用 StreamReader 读文件头和每块那一小段字节，算出同样的摘要。

两个要点：
  * 「打开 = 只读文件头」这件事是可以量的：StreamReader 一构造完，read_bytes 就是
    16 + 头长度；读完全部神经元块之后，也仍然没碰过权重块区一个字节。
  * 摘要的格式化方式两边写死（浮点一律 %.6f、集合先排序、再走 FNV-1a），
    差一位都算不一致——所以它比的是数字本身，不是"能不能解析"。

（别拿 verify_import.py 当同类：那个比的是 ONNX 参考实现的数值结果，这个比的是
 同一个文件在两个语言的解码器手里会不会读出不同的东西。）

用法：
  node prototype/run_checks.mjs --only=streamcheck     # 先让浏览器产出 streamcheck.json
  py -3 tools/verify_stream.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np

import nforge as NF

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLE = os.path.join(ROOT, "prototype", "_streamdemo_raw.nforge")
DUMP = os.path.join(ROOT, "_dump", "streamcheck.json")

PASS = FAIL = 0


def ok(cond, name, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
    print(("PASS" if cond else "FAIL") + " | " + name + " | " + str(detail))
    return cond


def fnv(strings):
    """跟浏览器端那个 fnv 逐位等价：32 位溢出，最后按无符号十六进制打印。"""
    a = 2166136261
    for s in strings:
        for ch in s:
            a ^= ord(ch)
            a = (a * 16777619) & 0xFFFFFFFF
        a ^= 10
        a = (a * 16777619) & 0xFFFFFFFF
    return format(a, "x")


def neu_str(pos, io, act, bias, thr, lock, col_on, col):
    return "%.6f,%.6f,%.6f,%d,%d,%.6f,%.6f,%d,%d,%.6f,%.6f,%.6f" % (
        float(pos[0]), float(pos[1]), float(pos[2]), int(io), int(act),
        float(bias), float(thr), int(lock), int(col_on),
        float(col[0]), float(col[1]), float(col[2]))


def edge_str(s, d, w, l):
    return "%d>%d:%.6f:%d" % (int(s), int(d), float(w), int(l))


def main():
    if not os.path.exists(SAMPLE):
        raise SystemExit("没有样本：" + SAMPLE + "\n先跑： py -3 tools/gen_stream_demo.py")
    if not os.path.exists(DUMP):
        raise SystemExit("没有浏览器那半边的结果：" + DUMP
                         + "\n先跑： node prototype/run_checks.mjs --only=streamcheck")
    with open(DUMP, encoding="utf-8") as f:
        js = json.load(f)
    if js.get("error"):
        raise SystemExit("浏览器那半边先报错了：" + str(js["error"]))
    dig = js.get("chunkDigests") or {}

    rd = NF.StreamReader(SAMPLE)
    total = rd.byte_len()
    hdr = rd.header
    nch = len(rd.chunks)
    blk_len = (hdr.get("blocks") or {}).get("len", 0)

    print("样本 %s（%d B / %d 块 / 每块 %d 神经元）"
          % (os.path.basename(SAMPLE), total, nch, hdr["chunkNeurons"]))
    print("")

    ok(rd.read_bytes == NF.HEAD_OFF + rd.head_len, "构造 StreamReader 只读了文件头",
       "%d B = 16 + %d" % (rd.read_bytes, rd.head_len))
    ok(rd.read_bytes * 100 < total, "打开时读进来的不到全文件的 1%",
       "%.2f%%（%d / %d B）" % (100.0 * rd.read_bytes / total, rd.read_bytes, total))
    ok(NF.check_index(hdr) == [], "文件头索引表自洽", NF.check_index(hdr))
    ok(nch == js.get("chunks"), "块数跟浏览器报的一致", "%d vs %s" % (nch, js.get("chunks")))
    ok(hdr["chunkNeurons"] == js.get("chunkNeurons"), "每块神经元数一致",
       "%d vs %s" % (hdr["chunkNeurons"], js.get("chunkNeurons")))
    ok(len(dig) == nch, "浏览器给出了每一块的摘要", "%d / %d" % (len(dig), nch))

    bad_n = bad_e = 0
    tot_n = tot_e = 0
    first_bad = ""
    for k in range(nch):
        c = rd.chunks[k]
        f = rd.chunk(k)          # 只读 + 解压这一块
        nh = [neu_str(f["pos"][i], f["io"][i], f["act"][i], f["bias"][i], f["thr"][i],
                      f["lock"][i], f["col_on"][i], f["col"][i])
              for i in range(c["n1"] - c["n0"])]
        eh = sorted(edge_str(f["src"][j], f["dst"][j], f["w"][j], f["elock"][j])
                    for j in range(c["e1"] - c["e0"]))
        got = dig.get(str(k))
        tot_n += len(nh)
        tot_e += len(eh)
        if got is None:
            bad_n += 1
            bad_e += 1
            first_bad = first_bad or ("第 %d 块浏览器没给摘要" % k)
            continue
        if fnv(nh) != got["nh"] or len(nh) != got["n"]:
            bad_n += 1
            first_bad = first_bad or ("第 %d 块神经元：JS %s/%s，Python %d/%s"
                                      % (k, got["n"], got["nh"], len(nh), fnv(nh)))
        if fnv(eh) != got["eh"] or len(eh) != got["e"]:
            bad_e += 1
            first_bad = first_bad or ("第 %d 块边：JS %s/%s，Python %d/%s"
                                      % (k, got["e"], got["eh"], len(eh), fnv(eh)))

    ok(bad_n == 0, "%d 块的神经元字段全部逐位一致" % nch,
       "比了 %d 个神经元" % tot_n + ("" if bad_n == 0 else "；例：" + first_bad))
    ok(bad_e == 0, "%d 块的边全部逐位一致" % nch,
       "比了 %d 条边" % tot_e + ("" if bad_e == 0 else "；例：" + first_bad))
    ok(rd.read_bytes == total - blk_len,
       "读完所有神经元块之后，剩下的权重块区一个字节都没碰",
       "%d 读了，%d 没读（全文件 %d）" % (rd.read_bytes, blk_len, total))

    # StreamReader 自己也得跟老的整份 read() 解出一样的东西，否则它只是"另一套解码"
    _h2, neu, edg, blk = NF.read(SAMPLE)
    parts = rd.read_all()
    cat = lambda key, dt: np.concatenate([p[key] for p in parts]).astype(dt)
    pairs = [
        # 块里的字段名 -> (读回来的对象, 属性名, dtype)
        ("pos", neu, "pos", "<f4"), ("io", neu, "io", np.uint8),
        ("thr", neu, "thr", "<f4"), ("act", neu, "act", np.uint8),
        ("bias", neu, "bias", "<f4"), ("lock", neu, "lock", np.uint8),
        ("col_on", neu, "col_on", np.uint8), ("col", neu, "col", "<f4"),
        ("src", edg, "src", "<u4"), ("dst", edg, "dst", "<u4"),
        ("w", edg, "w", "<f4"), ("elock", edg, "lock", np.uint8),
    ]
    diff = []
    for key, obj, attr, dt in pairs:
        if not np.array_equal(cat(key, dt), getattr(obj, attr)):
            diff.append(key)
    ok(not diff, "StreamReader 逐块读出来的东西，跟整份 read() 完全一样",
       "比了 12 个字段，神经元 %d / 连接 %d" % (len(neu), len(edg))
       + ("" if not diff else "；对不上：" + ",".join(diff)))
    ok(blk is not None and len(blk) == (hdr.get("blocks") or {}).get("count", 0),
       "整份 read() 也照旧读得到权重块",
       "%d 块" % (0 if blk is None else len(blk)))

    # ---- 权重块按段读：Python 侧也得能"只读那几段"，而且挑段结果跟浏览器一致 ----
    bs = js.get("blockSel") or {}
    parts = rd.block_parts()
    bmeta = rd.blocks
    ok(len(parts) == bmeta.get("count") and bmeta.get("codec") == NF.PARTS_CODEC,
       "权重块区是「一块一段」存的（codec=parts）",
       "%s / %d 段 / %d 块" % (bmeta.get("codec"), len(parts), bmeta.get("count", 0)))
    ok(int(bs.get("parts", -1)) == len(parts) and int(bs.get("len", -1)) == int(bmeta.get("len", -2)),
       "浏览器报的段数 / 区长跟 Python 读到的一致",
       "%s 段 · %s B vs %d 段 · %s B"
       % (bs.get("parts"), bs.get("len"), len(parts), bmeta.get("len")))
    ok(all(len(p.get("bbox") or []) == 6 for p in parts), "每一段都带包围盒",
       "第 0 段 %s" % (parts[0]["bbox"] if parts else "无"))
    acc, gaps = 0, 0
    for p in parts:
        if int(p["off"]) != acc:
            gaps += 1
        acc += int(p["len"])
    ok(gaps == 0 and acc == int(bmeta.get("len", -1)), "各段首尾相接，长度之和 = 区长",
       "%d B / %s B" % (acc, bmeta.get("len")))

    # 用包围盒挑「跟中间那三块相交」的段：挑出来的段数必须跟浏览器挑的一样
    mid = nch // 2
    boxes = [rd.chunks[k]["bbox"] for k in (mid - 1, mid, mid + 1)]
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes); z0 = min(b[2] for b in boxes)
    x1 = max(b[3] for b in boxes); y1 = max(b[4] for b in boxes); z1 = max(b[5] for b in boxes)
    near = [int(p["i"]) for p in parts
            if p["bbox"][3] >= x0 and p["bbox"][0] <= x1
            and p["bbox"][4] >= y0 and p["bbox"][1] <= y1
            and p["bbox"][5] >= z0 and p["bbox"][2] <= z1]
    ok(near and len(near) == int(bs.get("tried", -1)),
       "Python 用包围盒挑出的段数 = 浏览器单次载入时挑的段数",
       "%d vs %s（挑中 %s，共 %d 段）" % (len(near), bs.get("tried"), near, len(parts)))

    # 只读一段：读的字节数必须正好是那一段
    before = rd.read_bytes
    one, _d1 = rd.read_blocks(ids=[near[0]])
    ok(rd.read_bytes - before == int(parts[near[0]]["len"]),
       "只读一段时，从盘上读的字节数 = 那一段的长度",
       "%d B / %d B" % (rd.read_bytes - before, parts[near[0]]["len"]))
    ok(one is not None and len(one) == 1, "只读一段解出来正好一块",
       "%d 块" % (0 if one is None else len(one)))

    # 只读这几段：字节数与块数必须跟浏览器报的逐字对上
    before = rd.read_bytes
    few, few_drop = rd.read_blocks(ids=near)
    got_bytes = rd.read_bytes - before
    ok(got_bytes == int(bs.get("bytes", -1)),
       "只读这几段时，Python 读的字节数 = 浏览器读的字节数",
       "%d B vs %s B" % (got_bytes, bs.get("bytes")))
    ok(len(few) == int(bs.get("loaded", -1)) and few_drop == 0,
       "解出来的块数一致，而且一块都没丢",
       "%d vs %s（丢 %d）" % (len(few), bs.get("loaded"), few_drop))
    ok(got_bytes * 4 < int(bmeta["len"]), "只读了几段，字节数远小于整段",
       "%d B < 整段 %d B（%d 段）" % (got_bytes, bmeta["len"], len(parts)))

    # 整段读：跟按段读出来的东西必须对得上
    all_blk, all_drop = rd.read_blocks()
    ok(all_blk is not None and len(all_blk) == int(bmeta.get("count", -1)),
       "整段读能读出全部权重块", "%d 块（丢 %d）" % (0 if all_blk is None else len(all_blk), all_drop))
    ok(all_blk.total_weights == hdr["counts"]["blockWeights"],
       "权重总数 = 文件头里的值",
       "%d vs %d" % (all_blk.total_weights, hdr["counts"]["blockWeights"]))
    shape = lambda b: [(int(b.ks[i]), int(b.ns[i])) for i in range(len(b))]
    ok(shape(few) == [shape(all_blk)[j] for j in near],
       "按段读出来的块 = 整段读里对应的那几块（顺序也一致）",
       "%s vs %s" % (shape(few), [shape(all_blk)[j] for j in near]))
    ok(js.get("blockSel", {}).get("allBlocks") == len(all_blk)
       and js.get("blockSel", {}).get("allWeights") == all_blk.total_weights,
       "浏览器「全部载入」之后的权重块数 / 权重总数 = Python 整段读的结果",
       "%s / %s vs %d / %d" % (bs.get("allBlocks"), bs.get("allWeights"),
                               len(all_blk), all_blk.total_weights))

    print("")
    print("== %d PASS / %d FAIL ==" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
