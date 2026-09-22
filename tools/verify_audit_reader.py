# -*- coding: utf-8 -*-
"""B21 / B22 回归：公共读取入口必须拒绝被截断的文件与块内自相矛盾的计数。

Run: py -3 -B -X utf8 tools/verify_audit_reader.py
样本全部在临时目录里现造现删，不碰任何真实工程。
"""
from __future__ import annotations

import json
import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np

import nforge


def make_neurons(n=2, e=1):
    return nforge.Neurons(
        pos=np.arange(n * 3, dtype=np.float32).reshape(-1, 3),
        io=np.zeros(n, np.uint8),
        thr=np.full(n, 1.0, np.float32),
        act=np.zeros(n, np.uint8),
        bias=np.zeros(n, np.float32),
        lock=np.zeros(n, np.uint8),
        col_on=np.zeros(n, np.uint8),
        col=np.zeros((n, 3), np.float32),
    )


def make_edges(e=1):
    return nforge.Edges(src=np.zeros(e, np.uint32), dst=np.ones(e, np.uint32),
                        w=np.full(e, 0.5, np.float32), lock=np.zeros(e, np.uint8))


def make_blocks(ks, ns, sg=None, lock=None):
    """按 ks/ns 造一组权重块：权重按块顺序编号，方便看出读到了哪一块。"""
    ks = np.asarray(ks, np.uint32)
    ns = np.asarray(ns, np.uint32)
    src, dst, w = [], [], []
    for i in range(len(ks)):
        src.append(np.arange(int(ks[i]), dtype=np.uint32))
        dst.append(np.arange(1, int(ns[i]) + 1, dtype=np.uint32))
        w.append(np.full(int(ks[i]) * int(ns[i]), float(i + 1), np.float32))
    return nforge.Blocks(
        ks=ks, ns=ns,
        src=np.concatenate(src) if src else np.zeros(0, np.uint32),
        dst=np.concatenate(dst) if dst else np.zeros(0, np.uint32),
        w=np.concatenate(w) if w else np.zeros(0, np.float32),
        lock=None if lock is None else np.asarray(lock, np.uint8),
        sg=None if sg is None else np.asarray(sg, np.uint32),
    )


def head_of(path):
    return nforge.read_header(path)


def parts_of(path):
    """(文件头, data_start, 第 0 块那一段字节)。"""
    data = path.read_bytes()
    head_len = struct.unpack_from("<I", data, 8)[0]
    head = json.loads(data[nforge.HEAD_OFF:nforge.HEAD_OFF + head_len].decode("utf-8"))
    start = nforge.HEAD_OFF + head_len
    c = head["chunks"][0]
    return head, start, data[start + c["off"]:start + c["off"] + c["len"]]


def rebuild(path, head, body):
    """按 head 重写文件：MAGIC + 头长 + 头 + body（偏移都是相对 data_start 的，照样成立）。"""
    blob = json.dumps(head, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    path.write_bytes(nforge.MAGIC + struct.pack("<II", len(blob), 0) + blob + body)


class ReaderAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nf-reader-audit-")
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)

    def write_small(self, name="small.nforge", neurons=None, edges=None, **kw):
        p = self.dir / name
        nforge.write(p, neurons if neurons is not None else make_neurons(),
                     edges if edges is not None else make_edges(), name="audit", **kw)
        return p

    # ---------------- B21：截断 ----------------

    def test_cutting_a_chunk_below_its_minimum_length_is_rejected(self):
        """文件比布局要求的最小长度还短：nf.read 必须报错，不能返回短数组。"""
        p = self.write_small(compress=False)
        head, start, body = parts_of(p)
        need = nforge.layout(head["counts"]["neurons"], head["counts"]["edges"])["total"]
        self.assertGreaterEqual(len(body), need)
        for cut in (0, 12, 24, 48, 76, 88, need - 1):
            with self.subTest(cut=cut):
                rebuild(p, head, body[:cut])
                with self.assertRaises(ValueError):
                    nforge.read(p)

    def test_cutting_a_chunk_with_updated_header_length_is_rejected(self):
        """连文件头里的块长也一起改短：解码那一层要自己发现字段不够。"""
        p = self.write_small(compress=False)
        head, start, body = parts_of(p)
        need = nforge.layout(head["counts"]["neurons"], head["counts"]["edges"])["total"]
        for cut in (0, 24, 76, need - 1):
            with self.subTest(cut=cut):
                h = json.loads(json.dumps(head))
                h["chunks"][0]["len"] = cut
                rebuild(p, h, body[:cut])
                with self.assertRaises(ValueError):
                    nforge.read(p)
                with self.assertRaises(ValueError):
                    nforge.StreamReader(p).chunk(0)

    def test_trailing_padding_inside_a_chunk_is_still_accepted(self):
        """老编码器会在块尾多留字节：多出来要能读，少一个字节才算坏。"""
        p = self.write_small("padded.nforge", compress=False)
        head, start, body = parts_of(p)
        need = nforge.layout(head["counts"]["neurons"], head["counts"]["edges"])["total"]
        for cut in (need, len(body) - 1, len(body)):
            with self.subTest(cut=cut):
                h = json.loads(json.dumps(head))
                h["chunks"][0]["len"] = cut
                rebuild(p, h, body[:cut] + (b"\x00" * (len(body) - cut) if cut >= need else b""))
                _, neurons, edges, _ = nforge.read(p)
                self.assertEqual(len(neurons), 2)
                self.assertEqual(len(edges), 1)
                self.assertEqual(len(nforge.StreamReader(p).chunk(0)["pos"]), 2)

    def test_padded_chunk_written_by_the_legacy_encoder_still_loads(self):
        """Python 老写入器整段就是带尾部填充的（149 字节装 92 字节的字段），照旧能读。"""
        p = self.write_small("legacy.nforge", compress=False)
        head, start, body = parts_of(p)
        need = nforge.layout(head["counts"]["neurons"], head["counts"]["edges"])["total"]
        self.assertGreater(len(body), need)
        _, neurons, edges, _ = nforge.read(p)
        self.assertEqual(len(neurons), 2)
        self.assertTrue(np.allclose(neurons.pos, make_neurons().pos))

    def test_truncated_deflate_chunk_is_rejected(self):
        """真走 deflate 的块：压缩流被截断要报错（统一成 ValueError）。"""
        big = make_neurons(400)
        p = self.dir / "big.nforge"
        nforge.write(p, big, nforge.Edges(
            src=np.zeros(0, np.uint32), dst=np.zeros(0, np.uint32),
            w=np.zeros(0, np.float32), lock=np.zeros(0, np.uint8)),
            name="big", compress=True)
        head, start, body = parts_of(p)
        self.assertEqual(head["chunks"][0]["codec"], "deflate")
        for cut in (1, len(body) // 2, len(body) - 1):
            with self.subTest(cut=cut):
                h = json.loads(json.dumps(head))
                h["chunks"][0]["len"] = cut
                rebuild(p, h, body[:cut])
                with self.assertRaises(ValueError):
                    nforge.read(p)
                with self.assertRaises(ValueError):
                    nforge.StreamReader(p).chunk(0)

    def test_stream_reader_short_read_is_rejected(self):
        p = self.write_small("stream.nforge", compress=False)
        head, start, body = parts_of(p)
        rebuild(p, head, body[:-4])
        with self.assertRaises(ValueError):
            nforge.StreamReader(p).chunk(0)

    def test_whole_file_still_loads_and_matches(self):
        p = self.write_small("ok.nforge", compress=False)
        head, neurons, edges, blocks = nforge.read(p)
        self.assertEqual(len(neurons), 2)
        self.assertEqual(len(edges), 1)
        self.assertEqual(nforge.check_index(head), [])
        rd = nforge.StreamReader(p)
        self.assertEqual(len(rd.chunk(0)["pos"]), 2)
        self.assertEqual(len(rd.read_all()), len(rd.chunks))

    # ---------------- B22：块内计数 ----------------

    def block_file(self, name, blocks, **kw):
        p = self.dir / name
        nforge.write(p, make_neurons(4), make_edges(2), name="blk", blocks=blocks, **kw)
        return p

    def patch_region(self, p, patch, parts=False, has_lock=False, has_ref=False):
        head = head_of(p)
        base = nforge.block_region_base(nforge.HEAD_OFF + _head_len(p), head)
        data = bytearray(p.read_bytes())
        bm = head["blocks"]
        if parts:
            p0 = bm["parts"][0]
            base += int(p0["off"])
            nb = 1
            L = nforge.block_region_layout(
                nb, int(p0.get("weights", p0["k"] * p0["n"])), int(p0["k"]), int(p0["n"]),
                has_lock, has_ref)
        else:
            L = nforge.block_region_layout(int(bm["count"]), int(bm["weights"]),
                                           int(bm["rows"]), int(bm["cols"]), has_lock, has_ref)
        patch(data, base, L)
        p.write_bytes(bytes(data))

    def test_block_column_sum_mismatch_is_rejected(self):
        """块内列数之和跟块区头声明对不上：必须报错（原来会切出 2x1 的空壳）。"""
        p = self.block_file("blk.nforge", make_blocks([1], [2]), block_parts=False)
        # meta = [k0, n0] 两个 u4；n0 在 meta+4
        self.patch_region(p, lambda d, base, L: struct.pack_into("<I", d, base + L["meta"] + 4, 3))
        with self.assertRaises(ValueError) as cm:
            nforge.read(p)
        self.assertIn("行列计数", str(cm.exception))

    def test_block_stored_weight_count_mismatch_is_rejected(self):
        """k/n 之和都自洽，但真正存着的权重个数跟 total_w 对不上：必须报错。"""
        p = self.block_file("blk2.nforge", make_blocks([1], [2]), block_parts=False)

        def patch(d, base, L):
            struct.pack_into("<I", d, base + L["meta"] + 4, 1)   # n0: 2 -> 1
            struct.pack_into("<I", d, base + 12, 1)              # sum_n: 2 -> 1
        self.patch_region(p, patch)
        with self.assertRaises(ValueError) as cm:
            nforge.read(p)
        self.assertIn("真正存着", str(cm.exception))

    def test_block_forward_reference_is_rejected(self):
        """引用表只能往前指；往后指要报错。"""
        p = self.block_file("blk3.nforge", make_blocks([1, 1], [1, 1], sg=[1, 1]),
                            block_parts=False)
        head = head_of(p)
        base = nforge.block_region_base(nforge.HEAD_OFF + _head_len(p), head)
        data = bytearray(p.read_bytes())
        L = nforge.block_region_layout(2, 1, 2, 2, False, True)
        struct.pack_into("<I", data, base + L["ref"], 1)     # 块 0 -> 块 1（往后指）
        p.write_bytes(bytes(data))
        with self.assertRaises(ValueError) as cm:
            nforge.read(p)
        self.assertIn("引用表", str(cm.exception))

    def test_legal_shared_blocks_still_load(self):
        """合法共享组（3x2 与 2x3 互为转置、共用一份数值）仍然读得回来。"""
        p = self.block_file("share.nforge", make_blocks([3, 2], [2, 3], sg=[1, 1]),
                            block_parts=False)
        head, neurons, edges, blk = nforge.read(p)
        self.assertIsNotNone(blk)
        self.assertEqual(list(blk.ks), [3, 2])
        self.assertEqual(list(blk.ns), [2, 3])
        self.assertAlmostEqual(float(blk.w[0]), 1.0)
        self.assertEqual(blk.share_n, 1)
        self.assertEqual(nforge.check_index(head), [])

    def test_multipart_blocks_still_load(self):
        """分段形式（每一块一段）照旧能读，且每块读到的数值对得上。"""
        p = self.block_file("parts.nforge", make_blocks([1, 1, 1], [1, 1, 1]),
                            block_parts=True)
        head, neurons, edges, blk = nforge.read(p)
        self.assertEqual([round(float(x), 3) for x in blk.w], [1.0, 2.0, 3.0])
        self.assertEqual(nforge.check_index(head), [])

    def test_truncated_block_region_is_rejected(self):
        p = self.block_file("cut.nforge", make_blocks([1], [1]), block_parts=False)
        data = p.read_bytes()
        p.write_bytes(data[:-2])
        with self.assertRaises(ValueError):
            nforge.read(p)


def _head_len(p):
    return struct.unpack_from("<I", p.read_bytes(), 8)[0]


if __name__ == "__main__":
    unittest.main(verbosity=2)
