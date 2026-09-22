"""nforge —— `.nforge` v3 分块二进制容器的 Python 实现。

和浏览器端 prototype/src/main.js 里的 12.5 节是同一套格式，两边必须逐字节兼容：

    +0    magic "NFORGE3\\0"（8 字节）
    +8    u32  headerLen
    +12   u32  flags（保留，恒为 0）
    +16   header JSON，headerLen 字节
    ...   块体依次拼接，块的 off 相对块区起点

header 里是索引表：每块的神经元区间 [n0,n1)、连接区间 [e0,e1)、包围盒、
压缩前后字节数。读文件时先只解析这个头，一块都不用解压。

块体是一段定长小端布局，字段按 4 字节对齐：

    [f32×3n 位置][u8 n 接口][pad][f32 n 阈值][u8 n 激活][pad]
    [f32 n 偏置][u8 n 冻结][u8 n 自定义色开关][pad][f32×3n 颜色]
    [u32 e 起点][u32 e 终点][f32 e 权重][u8 e 冻结][pad]

块体用 zlib（带 zlib 头）压缩，和浏览器的 CompressionStream('deflate') 一致。

权重块（dense block）放在**跟神经元块区并列的第二段**里，header["blocks"] 描述它：

    [u32 'BLK1'][u32 nb][u32 sumK][u32 sumN][u32 totalW][u32 flags]
    [u32 k,n × nb][f32 权重 × totalW][u32 行 id × sumK][u32 列 id × sumN][u8 锁掩码 × totalW?]

锁掩码只在 flags & 1 时存在。块的 k / n 按块顺序成对存放，权重按行主序首尾相接。
块区单独压缩、单独定位（off 相对神经元块区的末尾），所以"只载入附近的神经元块"
时要不要带上权重块是可以分开决定的。

算子节点（算子级聚合块）放在**第三段**里，header["ops"] 描述它。一个节点 = 一个算子
（Conv / MaxPool / Softmax …）+ 一个带形状的张量。参数张量（卷积核、BN 的均值方差…）
是几十 MB 级的东西，所以走独立分区而不是文件头 JSON；一个算子一段，段头 + 定长记录，
读的时候顺着走一遍就行。见下面 "算子节点" 那一节的段布局。
"""
from __future__ import annotations

import io
import json
import os
import struct
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np

MAGIC = b"NFORGE3\x00"
HEAD_OFF = 16
FORMAT = "neuroforge-project"
VERSION = 3
# 工程格式的兼容契约（改这块之前先读这段）
# version = 字节布局版本，只在「改动已有字段的含义或排布」时才 +1。加新功能 =
# 文件头里多一个可选键、或者文件末尾多一段独立分区；读的时候一律 header.get，
# 缺字段就当默认，所以「新版软件开旧工程」永远成立。可选键 layout = 这份文件真
# 正的布局版本（不写就等于 version），给「加了新键但布局没变」的将来留一条能读
# 下去的路。真到了必须 +1 的那天，要说清楚是哪个版本、该怎么办。


def header_error(header):
    """"None = 能按本版本的布局读下去，否则返回一句人话原因。"

    必须跟编辑器里的 nf3HeaderError 行为一模一样，改一边就要改另一边。
    """""
    if not isinstance(header, dict):
        return "文件头不是 JSON 对象，文件可能损坏"
    if header.get("format") != FORMAT:
        return "这不是 NeuroForge 工程文件（format=%r）" % (header.get("format"),)
    ver = header.get("version")
    if not isinstance(ver, int) or isinstance(ver, bool):
        return "工程文件没写版本号，认不出来"
    lay = header.get("layout")
    if not isinstance(lay, int) or isinstance(lay, bool):
        lay = ver
    if lay == VERSION:
        return None
    if lay > VERSION:
        return ("这份工程是按 v%d 布局存的新版文件，当前软件只认到 v%d。"
                "请用能读 v%d 的软件打开它——升级后的软件仍然能打开你以前存的所有工程。"
                % (lay, VERSION, lay))
    return ("这是 v%d 布局的老文件，当前软件按 v%d 布局解读会串行。"
            "请用当时保存它的那个版本的软件打开。" % (lay, VERSION))


NOT_MINE = "这不是 NeuroForge 工程文件（文件头不是 NFORGE3）。选错文件了，或者它来自更新的文件格式——那就需要升级软件。"
DEFAULT_CHUNK_NEURONS = 65536

ORDER_LINEAR = "linear"
ORDER_SPATIAL = "spatial"
MORTON_LEVELS = 10                      # 每轴 10 位 -> 30 位 Morton 码
MORTON_Q = (1 << MORTON_LEVELS) - 1    # 1023
MAX_CHUNKS = 4096                         # 块数安全阀：再多就并块
PARTS_CODEC = "parts"                     # 块区按块分段存时，header.blocks.codec 就是这个
MIN_PART_ZIP = 2048                       # 小于这个字节数不值得压

IO_NONE, IO_IN, IO_OUT, IO_BOTH = 0, 1, 2, 3
ACT_NAMES = ["linear", "relu", "leaky_relu", "sigmoid", "tanh", "gelu", "elu", "silu"]


def _inflate(body: bytes, what: str) -> bytes:
    """解压一块体。坏数据统一转成 ValueError —— 读取层只抛这一种错，调用方好认。"""
    try:
        return zlib.decompress(body)
    except zlib.error as exc:
        raise ValueError(f"{what}解压失败（压缩数据损坏或被截断）：{exc}") from exc


def _align4(o: int) -> int:
    return (o + 3) & ~3


def layout(n: int, e: int) -> dict:
    """块内各字段的偏移，只跟 (n, e) 有关。读写两边都调它，不可能对不上。"""
    o = 0
    L = {"n": n, "e": e}
    L["pos"] = o; o += n * 12
    L["io"] = o; o += n; o = _align4(o)
    L["thr"] = o; o += n * 4
    L["act"] = o; o += n; o = _align4(o)
    L["bias"] = o; o += n * 4
    L["lock"] = o; o += n
    L["colOn"] = o; o += n; o = _align4(o)
    L["col"] = o; o += n * 12
    L["src"] = o; o += e * 4
    L["dst"] = o; o += e * 4
    L["w"] = o; o += e * 4
    L["elock"] = o; o += e; o = _align4(o)
    L["total"] = o
    return L


@dataclass
class Neurons:
    """平铺的神经元属性。pos 是 (N,3) float32，其余是长度 N 的数组。"""
    pos: np.ndarray
    io: np.ndarray = None
    thr: np.ndarray = None
    act: np.ndarray = None
    bias: np.ndarray = None
    lock: np.ndarray = None
    col_on: np.ndarray = None
    col: np.ndarray = None

    def __post_init__(self):
        n = len(self.pos)
        f32 = lambda v, d=0.0: np.full(n, v, dtype=np.float32)
        u8 = lambda v: np.full(n, v, dtype=np.uint8)
        if self.io is None: self.io = u8(IO_NONE)
        if self.thr is None: self.thr = f32(0.5)
        if self.act is None: self.act = u8(0)
        if self.bias is None: self.bias = f32(0.0)
        if self.lock is None: self.lock = u8(0)
        if self.col_on is None: self.col_on = u8(0)
        if self.col is None: self.col = np.zeros((n, 3), dtype=np.float32)
        self.pos = np.ascontiguousarray(self.pos, dtype=np.float32)
        self.col = np.ascontiguousarray(self.col, dtype=np.float32)

    def __len__(self):
        return len(self.pos)


@dataclass
class Edges:
    src: np.ndarray
    dst: np.ndarray
    w: np.ndarray
    lock: np.ndarray = None

    def __post_init__(self):
        self.src = np.ascontiguousarray(self.src, dtype=np.uint32)
        self.dst = np.ascontiguousarray(self.dst, dtype=np.uint32)
        self.w = np.ascontiguousarray(self.w, dtype=np.float32)
        if self.lock is None:
            self.lock = np.zeros(len(self.src), dtype=np.uint8)
        else:
            self.lock = np.ascontiguousarray(self.lock, dtype=np.uint8)

    def __len__(self):
        return len(self.src)


@dataclass
class Blocks:
    """权重块：一段稠密权重矩阵 + 两端的神经元 id。

    ks / ns 是每块的形状，src / dst / w / lock 是各块首尾相接拼成的大数组。
    块在数组里的位置由 ks / ns 的前缀和就地算出来，不用另外存偏移。
    dropped 只在读取"部分块"时用得上：行列但凡有一个 id 没载入，整块丢掉。
    """
    ks: np.ndarray
    ns: np.ndarray
    src: np.ndarray
    dst: np.ndarray
    w: np.ndarray
    lock: np.ndarray = None
    sg: np.ndarray = None
    share_n: int = 0
    dropped: int = 0

    def __post_init__(self):
        self.ks = np.ascontiguousarray(self.ks, dtype=np.uint32)
        self.ns = np.ascontiguousarray(self.ns, dtype=np.uint32)
        self.src = np.ascontiguousarray(self.src, dtype=np.uint32)
        self.dst = np.ascontiguousarray(self.dst, dtype=np.uint32)
        self.w = np.ascontiguousarray(self.w, dtype=np.float32)
        if self.lock is not None:
            self.lock = np.ascontiguousarray(self.lock, dtype=np.uint8)
        if self.sg is None:
            self.sg = np.zeros(len(self.ks), dtype=np.uint32)
        else:
            self.sg = np.ascontiguousarray(self.sg, dtype=np.uint32)

    def __len__(self):
        return len(self.ks)

    @property
    def offsets(self):
        """(权重偏移, 行偏移, 列偏移) 三个前缀和数组。"""
        return _block_offsets(self.ks, self.ns)

    @property
    def total_weights(self) -> int:
        return int(np.sum(self.ks.astype(np.int64) * self.ns.astype(np.int64)))

    def refs(self) -> np.ndarray:
        """每块的权重从哪来：-1 = 自己存；否则 = 组内排在最前面的那块的下标。

        共享参数组（sg > 0）只写第一份权重，后面的块用引用表指过去——
        跟 js 侧 nf3BlkRegionEncode / nf3BlocksRead 必须逐位一致。
        同一组里各块的形状**可以不同**（元素总数一致即可）：同一段数值按各自的行主序读，
        3×2 与 2×3 就是互为转置。
        """
        first, ref = {}, []
        for i in range(len(self)):
            g = int(self.sg[i])
            r = -1
            if g:
                if g in first:
                    r = first[g]
                else:
                    first[g] = i
            ref.append(r)
        return np.asarray(ref, dtype=np.int64)

    @property
    def stored_weights(self) -> int:
        """真正要写进文件的权重数（共享组只算一份）。"""
        ref = self.refs()
        ks = self.ks.astype(np.int64)
        ns = self.ns.astype(np.int64)
        return int(sum(int(ks[i]) * int(ns[i]) for i in range(len(self)) if ref[i] < 0))


BLK_MAGIC = 0x314B4C42


def _block_offsets(ks, ns):
    nb = len(ks)
    ow = np.zeros(nb + 1, dtype=np.int64)
    os_ = np.zeros(nb + 1, dtype=np.int64)
    od = np.zeros(nb + 1, dtype=np.int64)
    for i in range(nb):
        k, n = int(ks[i]), int(ns[i])
        ow[i + 1] = ow[i] + k * n
        os_[i + 1] = os_[i] + k
        od[i + 1] = od[i] + n
    return ow, os_, od


def block_region_layout(nb, total_w, sum_k, sum_n, has_lock, has_ref=False):
    """块区各字段的偏移，只跟规模有关；读写两边都调它。

    has_ref = 有引用表（共享参数组）。没有共享组时**一个字节都不多**，
    所以老文件、老写法写出来的字节跟以前完全一样。
    """
    o = 24
    L = {"meta": o}; o += nb * 8
    L["ref"] = o
    if has_ref:
        o += nb * 4
    L["w"] = o; o += total_w * 4
    L["src"] = o; o += sum_k * 4
    L["dst"] = o; o += sum_n * 4
    L["lock"] = o; o += total_w if has_lock else 0
    L["total"] = o
    return L


def encode_blocks(blk: Blocks) -> bytes:
    nb = len(blk.ks)
    ref = blk.refs()
    has_ref = bool((ref >= 0).any())
    total_w = blk.stored_weights
    sum_k, sum_n = int(blk.ks.sum()), int(blk.ns.sum())
    has_lock = blk.lock is not None
    L = block_region_layout(nb, total_w, sum_k, sum_n, has_lock, has_ref)
    raw = bytearray(L["total"])
    flags = (1 if has_lock else 0) | (2 if has_ref else 0)
    struct.pack_into("<IIIIII", raw, 0, BLK_MAGIC, nb, sum_k, sum_n, total_w, flags)
    meta = np.empty(nb * 2, dtype="<u4")
    meta[0::2] = blk.ks
    meta[1::2] = blk.ns
    raw[L["meta"]:L["meta"] + nb * 8] = meta.tobytes()
    if has_ref:
        rt = np.where(ref < 0, np.uint32(0xFFFFFFFF), ref.astype(np.uint32))
        raw[L["ref"]:L["ref"] + nb * 4] = rt.astype("<u4").tobytes()
    ow, _, _ = _block_offsets(blk.ks, blk.ns)
    keep = [i for i in range(nb) if ref[i] < 0]
    ws = [blk.w[ow[i]:ow[i + 1]] for i in keep]
    wcat = np.concatenate(ws) if ws else np.zeros(0, dtype="<f4")
    raw[L["w"]:L["w"] + total_w * 4] = wcat.astype("<f4").tobytes()
    raw[L["src"]:L["src"] + sum_k * 4] = blk.src.astype("<u4").tobytes()
    raw[L["dst"]:L["dst"] + sum_n * 4] = blk.dst.astype("<u4").tobytes()
    if has_lock:
        # 浏览器端写锁掩码时只写 0/1，这里也归一化，两边字节才真的一样
        lk = np.concatenate([blk.lock[ow[i]:ow[i + 1]] for i in keep]) if keep else np.zeros(0, np.uint8)
        raw[L["lock"]:L["lock"] + total_w] = (lk.astype(np.uint8) != 0).astype(np.uint8).tobytes()
    return bytes(raw)


def decode_blocks(raw: bytes, remap=None, sg_base: int = 0):
    """解出块区，返回 (Blocks 或 None, 丢掉的块数)。

    remap 为空 = 按原编号；给了就把 id 重新编号，整块有任何一个 id 落空就丢掉整块。
    sg_base 是组号的起点：文件里的组号只在**段内**唯一，读多段时要靠它挪到全局唯一。
    """
    if len(raw) < 24:
        raise ValueError("权重块区太短，文件可能损坏")
    magic, nb, sum_k, sum_n, total_w, flags = struct.unpack_from("<IIIIII", raw, 0)
    if magic != BLK_MAGIC:
        raise ValueError("权重块区的文件头不对，文件可能损坏")
    has_lock = bool(flags & 1)
    has_ref = bool(flags & 2)
    L = block_region_layout(nb, total_w, sum_k, sum_n, has_lock, has_ref)
    if len(raw) < L["total"]:
        raise ValueError(f"权重块区被截断了（要 {L['total']} 字节，只有 {len(raw)}）")
    mv = memoryview(raw)
    meta = np.frombuffer(mv[L["meta"]:L["meta"] + nb * 8], dtype="<u4")
    w = np.frombuffer(mv[L["w"]:L["w"] + total_w * 4], dtype="<f4")
    src = np.frombuffer(mv[L["src"]:L["src"] + sum_k * 4], dtype="<u4")
    dst = np.frombuffer(mv[L["dst"]:L["dst"] + sum_n * 4], dtype="<u4")
    lock = np.frombuffer(mv[L["lock"]:L["lock"] + total_w], dtype=np.uint8) if has_lock else None
    ks, ns = meta[0::2].copy(), meta[1::2].copy()
    if nb <= 0 or ks.size != nb:
        raise ValueError("权重块区里没有块，文件可能损坏")
    sum_ks = int(ks.astype(np.int64).sum())
    sum_ns = int(ns.astype(np.int64).sum())
    if sum_ks != sum_k or sum_ns != sum_n:
        raise ValueError(
            f"权重块区的行列计数跟各块对不上：各块加起来 {sum_ks}/{sum_ns}，"
            f"文件头里写的是 {sum_k}/{sum_n}——文件损坏，或者被改过")
    if int(ks.min()) <= 0 or int(ns.min()) <= 0:
        raise ValueError("权重块区里有 0 行或 0 列的块，文件可能损坏")
    ow, os_, od = _block_offsets(ks, ns)
    # 引用表：只允许往前指，所以顺着下标走一遍就能拍平成"最终存在哪一块"（用不着递归）
    ref = np.full(nb, -1, dtype=np.int64)
    if has_ref:
        rt = np.frombuffer(mv[L["ref"]:L["ref"] + nb * 4], dtype="<u4").astype(np.int64)
        for i in range(nb):
            v = int(rt[i])
            if v == 0xFFFFFFFF:
                continue
            if v >= i:
                raise ValueError(f"权重块引用表不对：块 {i} 指向了 {v}（只能指向它前面那块）")
            ref[i] = int(ref[v]) if ref[v] >= 0 else v
    own = ref < 0
    stored = int((ks.astype(np.int64)[own] * ns.astype(np.int64)[own]).sum())
    if stored != total_w:
        raise ValueError(
            f"权重块区里真正存着的权重个数跟文件头对不上：算下来 {stored} 个，"
            f"文件头里写的是 {total_w} 个——文件损坏，或者被改过")
    # 被引用过的块才是组长；组号是段内编号（从 1 开始），加 sg_base 才全局唯一
    is_rep = np.zeros(nb, dtype=bool)
    for i in range(nb):
        if ref[i] >= 0:
            is_rep[ref[i]] = True
    local = np.zeros(nb, dtype=np.int64)
    share_n = 0
    for i in range(nb):
        if is_rep[i]:
            share_n += 1
            local[i] = share_n
    # 先把"自己存"的那些块的权重切出来，成员直接指过去（同一份数据 = 同一个参数）
    own_w, own_lk, wo, lo = {}, {}, 0, 0
    for i in range(nb):
        k, n = int(ks[i]), int(ns[i])
        if ref[i] < 0:
            own_w[i] = w[wo:wo + k * n]
            own_lk[i] = lock[lo:lo + k * n] if lock is not None else None
            wo += k * n
            lo += k * n
        else:
            r = int(ref[i])
            if r not in own_w:
                raise ValueError(f"权重块引用表不对：块 {i} 引用的块 {r} 不在这段里")
            # 形状可以不同（同一段数值各按自己的形状读：3×2 和 2×3 互为转置），
            # 但元素总数必须一样——不然切给成员的区间长度就跟它对不上了。
            if int(ks[r]) * int(ns[r]) != k * n:
                raise ValueError(
                    f"权重块引用表不对：块 {i}（{k}×{n}，{k * n} 个）跟它引用的块 {r}"
                    f"（{int(ks[r])}×{int(ns[r])}，{int(ks[r]) * int(ns[r])} 个）元素总数不一致")
            own_w[i] = own_w[r]
            own_lk[i] = own_lk[r]
    keep, ws, ss, ds, lk, sgs = [], [], [], [], [], []
    dropped = 0
    for i in range(nb):
        s = src[os_[i]:os_[i + 1]].copy()
        d = dst[od[i]:od[i + 1]].copy()
        if remap is not None:
            s2, d2 = remap[s], remap[d]
            if (s2 < 0).any() or (d2 < 0).any():
                dropped += 1
                continue
            s, d = s2.astype(np.uint32), d2.astype(np.uint32)
        rep_i = i if ref[i] < 0 else int(ref[i])
        keep.append(i)
        ss.append(s); ds.append(d)
        ws.append(np.asarray(own_w[i]))
        if own_lk[i] is not None:
            lk.append(own_lk[i])
        sgs.append(sg_base + int(local[rep_i]) if local[rep_i] else 0)
    if not keep:
        return None, dropped
    idx = np.asarray(keep, dtype=np.int64)
    cat = lambda xs, dt: np.concatenate(xs) if xs else np.zeros(0, dtype=dt)
    blk = Blocks(ks=ks[idx], ns=ns[idx], src=cat(ss, "<u4"), dst=cat(ds, "<u4"),
                 w=cat(ws, "<f4"), lock=cat(lk, np.uint8) if has_lock else None,
                 sg=np.asarray(sgs, dtype=np.uint32), share_n=share_n, dropped=dropped)
    return blk, dropped


def encode_block_one(k, n, src, dst, w, lock) -> bytes:
    """单个权重块编成一段独立字节：就是 nb=1 的经典块区布局。

    复用它而不是另发明一套布局，好处是解段的那一边一个字都不用改：
    decode_blocks(这一段) 直接返回一个只含一块的 Blocks。
    """
    has_lock = lock is not None and bool(np.asarray(lock).any())
    return encode_blocks(Blocks(
        ks=np.asarray([k], dtype=np.uint32), ns=np.asarray([n], dtype=np.uint32),
        src=np.asarray(src, dtype=np.uint32), dst=np.asarray(dst, dtype=np.uint32),
        w=np.asarray(w, dtype=np.float32),
        lock=np.asarray(lock, dtype=np.uint8) if has_lock else None))


def block_bbox(pos, src, dst) -> list:
    """一块的包围盒：它两端神经元的位置并集。

    为什么要把它写进文件头：按需载入的时候得先知道"这一块在空间的哪儿"，
    才能判断相机靠近没靠近——不解压任何一个字节就能判断。
    """
    p = np.asarray(pos, dtype=np.float32).reshape(-1, 3)
    idx = []
    for arr in (src, dst):
        a = np.asarray(arr, dtype=np.int64)
        idx.append(a[(a >= 0) & (a < len(p))])
    idx = np.concatenate(idx) if idx else np.zeros(0, dtype=np.int64)
    if not len(idx):
        return [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    return _bbox(p[idx])


def encode_block_parts(blk: Blocks, pos=None):
    """把块区切成「一段一组」。返回 (parts 元数据列表, 每段的原始字节)。

    哪一组：共享参数组整个进同一段（引用表只在段内有效），其余的一块一段。
    每段可以单独压缩、单独定位、单独解压——这才是"只载入相机附近的权重块"的前提。
    段里带 bbox 与形状，所以挑段的时候一块都不用解压。
    """
    ow, os_, od = blk.offsets
    parts, raws = [], []
    done = set()
    for i in range(len(blk)):
        if i in done:
            continue
        g = int(blk.sg[i])
        mem = [j for j in range(len(blk)) if g and int(blk.sg[j]) == g] or [i]
        done.update(mem)
        s_sub = np.concatenate([blk.src[os_[j]:os_[j + 1]] for j in mem])
        d_sub = np.concatenate([blk.dst[od[j]:od[j + 1]] for j in mem])
        lock = None
        if blk.lock is not None:
            lock = np.concatenate([blk.lock[ow[j]:ow[j + 1]] for j in mem])
            if not lock.any():
                lock = None      # 全 0 的锁掩码等于没有，跟 js 那边判据一致
        sub = Blocks(ks=blk.ks[mem], ns=blk.ns[mem], src=s_sub, dst=d_sub,
                     w=np.concatenate([blk.w[ow[j]:ow[j + 1]] for j in mem]),
                     lock=lock, sg=blk.sg[mem])
        raw = encode_blocks(sub)
        parts.append({
            "i": len(parts), "k": int(sub.ks.sum()), "n": int(sub.ns.sum()), "b": len(mem),
            "blocks": [int(x) for x in mem],
            "weights": int(sub.stored_weights), "all": int(sub.total_weights),
            "raw": len(raw), "bbox": block_bbox(pos, s_sub, d_sub) if pos is not None else [0] * 6,
        })
        raws.append(raw)
    return parts, raws


def block_region_base(data_start: int, header: dict) -> int:
    """块区起点（绝对字节位置）。块区接在神经元块区后面。"""
    return data_start + block_region_end(header) + (header.get("blocks", {}).get("off") or 0)


def read_block_parts(f, base: int, bm: dict, ids=None, remap=None, sg_base: int = 0):
    """按段读块区。ids 为空 = 全读。返回 (Blocks 或 None, 丢掉的块数, 读了多少字节)。"""
    parts = bm["parts"]
    want = None if not ids else set(int(x) for x in ids)
    pick = [p for p in parts if want is None or int(p["i"]) in want]
    if not pick:
        raise ValueError("没有选中任何权重块")
    per = []            # (文件里的块序号, k, n, src, dst, w, lock, sg)
    any_lock = False
    dropped = 0
    nbytes = 0
    sg_off = sg_base
    nseen = 0
    for p in pick:
        f.seek(base + int(p["off"]))
        body = f.read(int(p["len"]))
        nbytes += len(body)
        if len(body) != int(p["len"]):
            raise ValueError(
                f"权重块第 {p['i']} 段的字节不够：文件头说 {p['len']} 字节，只读到 {len(body)} 字节"
                f"——文件被截断了")
        if p["codec"] == "deflate":
            body = _inflate(body, f"权重块第 {p['i']} 段")
        elif p["codec"] != "raw":
            raise ValueError("不认识的权重块分段压缩方式：" + str(p["codec"]))
        b, dr = decode_blocks(body, remap, sg_off)
        if b is not None:
            sg_off += int(b.share_n)      # 组号只在段内唯一，跨段要接着编
        dropped += dr
        if b is None:
            continue
        ow, os_, od = b.offsets
        pb = p.get("blocks")
        for t in range(len(b)):
            k, n = int(b.ks[t]), int(b.ns[t])
            fi = int(pb[t]) if (pb and t < len(pb)) else nseen
            nseen += 1
            any_lock = any_lock or (b.lock is not None)
            per.append((fi, k, n, b.src[os_[t]:os_[t + 1]], b.dst[od[t]:od[t + 1]],
                        b.w[ow[t]:ow[t + 1]],
                        b.lock[ow[t]:ow[t + 1]] if b.lock is not None else None,
                        int(b.sg[t])))
    if not per:
        return None, dropped, nbytes
    # 按文件里的块序号排回去：共享组整组一段，段序跟块序会错开，
    # 不排的话"分段形式"和"整段形式"读出来的块顺序就不一样了。
    per.sort(key=lambda x: x[0])
    cat = lambda xs, dt: np.concatenate(xs) if xs else np.zeros(0, dtype=dt)
    return (Blocks(ks=np.asarray([x[1] for x in per], dtype="<u4"),
                   ns=np.asarray([x[2] for x in per], dtype="<u4"),
                   src=cat([x[3] for x in per], "<u4"), dst=cat([x[4] for x in per], "<u4"),
                   w=cat([x[5] for x in per], "<f4"),
                   lock=(cat([x[6] if x[6] is not None else np.zeros(len(x[5]), np.uint8)
                              for x in per], np.uint8) if any_lock else None),
                   sg=np.asarray([x[7] for x in per], dtype=np.uint32),
                   share_n=max(0, sg_off - sg_base), dropped=dropped), dropped, nbytes)


def read_block_region(f, base: int, bm: dict, ids=None, remap=None):
    """读块区，两种形式都支持：老的「整段一个 blob」与新的「一块一段」。

    返回 (Blocks 或 None, 丢掉的块数, 从盘上读了多少字节)。
    """
    if bm.get("parts"):
        return read_block_parts(f, base, bm, ids, remap)
    if bm.get("codec") not in ("raw", "deflate"):
        raise ValueError("不认识的块区压缩方式：" + str(bm.get("codec")))
    f.seek(base + (bm.get("off") or 0))
    body = f.read(bm["len"])
    nbytes = len(body)
    if len(body) != int(bm["len"]):
        raise ValueError(
            f"权重块区的字节不够：文件头说 {bm['len']} 字节，只读到 {len(body)} 字节——文件被截断了")
    if bm.get("codec") == "deflate":
        body = _inflate(body, "权重块区")
    blk, dropped = decode_blocks(body, remap)
    return blk, dropped, nbytes


def block_region_end(header: dict) -> int:
    """神经元块区一共占多少字节（块区从它后面接）。"""
    return max([c["off"] + c["len"] for c in header.get("chunks", [])] or [0])


# ==========================================================================
# 算子节点（算子级聚合块）
# --------------------------------------------------------------------------
# 一个节点 = 一个算子 + 一个带形状的张量。卷积这类算子折成标量神经元必然爆掉
# （3x3、64->64 在 256x256 上是 420 万神经元、几亿条边），所以算子级自成一等公民。
#
# 参数张量走**独立分区**（header["ops"]），不进文件头 JSON：一份 ResNet 量级的
# 卷积核是 21 MB float32，塞进 JSON（还得 base64）会让打开变慢、内存翻倍。
#
# 段布局（跟浏览器端 nf3OpBlobEncode / nf3OpBlobDecode 逐位一致，小端）：
#     u32 magic = "OPS1"(0x3153504F)
#     u32 ntensor
#     u32 totalBytes
#     u32 reserved = 0
#     然后 ntensor 条记录，顺序存放：
#       u32 rank
#       u32 dtype            OP_DTYPES 里的编号
#       u32 nbytes
#       char name[16]        NUL 填充的 ASCII
#       u32 dims[rank]
#       u8   data[nbytes]    补 0 到 4 字节边界
# ==========================================================================
OPS_MAGIC = 0x3153504F               # "OPS1"
OP_NAME_BYTES = 16
OP_SHAPE_MAX_DIM = 8

# code -> (名字, numpy 存储类型)。f16 按 float32 存、i64 按 float64 存：都是无损上转，
# 真正的类型由 code 记着，编译时再转回去。跟浏览器端 OP_DTYPES 必须一一对应。
OP_DTYPES = [(0, "f32", "<f4"), (1, "f64", "<f8"), (2, "i64", "<f8"), (3, "i32", "<i4"),
             (4, "u8", "u1"), (5, "i8", "i1"), (6, "f16", "<f4"), (7, "bool", "u1")]
OP_BY_CODE = {c: (nm, dt) for c, nm, dt in OP_DTYPES}
OP_BY_NAME = {nm: (c, dt) for c, nm, dt in OP_DTYPES}
OP_ITEMSIZE = {c: np.dtype(dt).itemsize for c, nm, dt in OP_DTYPES}


# 参数的角色：决定它编译成 PyTorch 时是 nn.Parameter（可训练）还是 buffer（不可训练）。
# 跟浏览器端 opParamRole / OP_ROLES 必须一致。
#   weight —— 可训练权重（卷积核、全连接矩阵、BN 的 scale / bias）
#   stat   —— 运行统计量（BN 的 running mean / var）：必须是 buffer，不然带梯度的前向直接报错
#   const  —— 字面常量（ONNX Constant 折进来的、固定缩放系数）：优化器不该动它
#   int    —— 整型 / 布尔的索引与常量
OP_ROLES = ("weight", "stat", "const", "int")


@dataclass
class OpParam:
    """一个参数张量。shape 是逻辑形状，data 是拍平之后的数值。

    role / same 不进参数体（header["ops"] 的字节分区），只记在文件头目录那一份里：
    改角色不用重写数值。same 非空 = 跟另一个算子参数共用同一份数值（权值共享）。
    """
    name: str
    dtype: str
    shape: list
    data: np.ndarray
    role: str = "weight"
    same: str = ""

    def __post_init__(self):
        if self.role not in OP_ROLES:
            raise ValueError(f"认不出的参数角色：{self.role}")
        self.same = str(self.same or "")
        if self.dtype not in OP_BY_NAME:
            raise ValueError(f"认不出的参数类型：{self.dtype}")
        code, dt = OP_BY_NAME[self.dtype]
        self.shape = [int(x) for x in self.shape]
        if len(self.shape) > OP_SHAPE_MAX_DIM:
            raise ValueError(f"参数 {self.name} 的形状维数超过 {OP_SHAPE_MAX_DIM}")
        self.data = np.ascontiguousarray(self.data, dtype=dt).reshape(-1)
        want = 1
        for d in self.shape:
            want *= d
        if want != self.data.size:
            raise ValueError(f"参数 {self.name} 的形状 {self.shape} 要 {want} 个数值，给了 {self.data.size} 个")

    @property
    def nbytes(self) -> int:
        return int(self.data.size) * OP_ITEMSIZE[OP_BY_NAME[self.dtype][0]]


@dataclass
class OpNode:
    """一个算子节点。

    ins 里每一项是 {"k":"n","ids":ndarray,"shape":[...]}（读一段神经元）或
    {"k":"o","id":int,"s":int,"shape":[...]}（读另一个算子节点的输出）。
    land = 输出落到哪些神经元上（None = 纯张量，只给下一个算子用）。
    """
    op: str
    name: str
    ins: list = field(default_factory=list)
    out: list = field(default_factory=list)
    land: "np.ndarray | None" = None
    attrs: dict = field(default_factory=dict)
    fold: list = field(default_factory=list)
    params: list = field(default_factory=list)
    note: str = ""
    color: int = 0
    col_on: int = 0
    pos: dict = None
    id: int = 0

    def __post_init__(self):
        self.out = [int(x) for x in self.out]
        if self.land is not None:
            self.land = np.ascontiguousarray(self.land, dtype=np.uint32).reshape(-1)
        want = 1
        for d in self.out:
            want *= d
        if self.land is not None and int(self.land.size) != want:
            raise ValueError(f"算子 {self.name} 的输出是 {self.out}（{want} 个），"
                             f"落点却是 {int(self.land.size)} 个神经元——元素个数必须一样")

    @property
    def nbytes(self) -> int:
        return sum(int(p.nbytes) for p in self.params)


@dataclass
class Ops:
    """一串算子节点。参数分区按"一个算子一段"存。"""
    list: list

    def __len__(self):
        return len(self.list)

    @property
    def tensors(self) -> int:
        return sum(len(n.params) for n in self.list)

    @property
    def bytes(self) -> int:
        return sum(int(n.nbytes) for n in self.list)


def encode_op_blob(node: OpNode) -> bytes:
    """一个算子的参数体。段头 + 每条定长记录，读的时候顺着走一遍就行。"""
    total, byte_sum = 16, 0
    sizes = []
    for p in node.params:
        nb = int(p.nbytes)
        byte_sum += nb
        sizes.append(nb)
        total += 28 + len(p.shape) * 4 + ((nb + 3) & ~3)
    raw = bytearray(total)
    struct.pack_into("<IIII", raw, 0, OPS_MAGIC, len(node.params), byte_sum, 0)
    o = 16
    for p, nb in zip(node.params, sizes):
        code, dt = OP_BY_NAME[p.dtype]
        struct.pack_into("<III", raw, o, len(p.shape), code, nb)
        nm = p.name.encode("ascii", "replace")[:OP_NAME_BYTES - 1]
        raw[o + 12:o + 12 + len(nm)] = nm
        o += 12 + OP_NAME_BYTES
        for d in p.shape:
            struct.pack_into("<I", raw, o, int(d))
            o += 4
        raw[o:o + nb] = p.data.astype(dt, copy=False).tobytes()
        o += (nb + 3) & ~3
    return bytes(raw)


def decode_op_blob(raw: bytes) -> list:
    """解一个算子的参数体，返回 [OpParam]。"""
    if len(raw) < 16:
        raise ValueError("算子参数段太短，文件可能损坏")
    magic, nt, _byte_sum, _ = struct.unpack_from("<IIII", raw, 0)
    if magic != OPS_MAGIC:
        raise ValueError("算子参数段的段头不对，文件可能损坏")
    o, out = 16, []
    for i in range(nt):
        if o + 28 > len(raw):
            raise ValueError(f"算子参数段被截断了（第 {i} 个张量）")
        rank, code, nb = struct.unpack_from("<III", raw, o)
        nm = raw[o + 12:o + 12 + OP_NAME_BYTES].split(b"\x00")[0].decode("latin-1")
        o += 12 + OP_NAME_BYTES
        if rank:
            shape = list(struct.unpack_from("<" + "I" * rank, raw, o))
            o += rank * 4
        else:
            shape = []
        if code not in OP_BY_CODE:
            raise ValueError(f"认不出的参数类型编号：{code}")
        dtype_name, dt = OP_BY_CODE[code]
        want = 1
        for d in shape:
            want *= int(d)
        if want * OP_ITEMSIZE[code] != nb:
            raise ValueError(f"参数 {nm} 的形状 {shape} 与字节数 {nb} 对不上")
        if o + nb > len(raw):
            raise ValueError(f"算子参数段被截断了（参数 {nm}）")
        arr = np.frombuffer(raw, dtype=dt, count=want, offset=o).copy()
        o += (nb + 3) & ~3
        out.append(OpParam(name=nm, dtype=dtype_name, shape=shape, data=arr))
    return out


def op_range_enc(ids, rank=None):
    """神经元 id 列表写进文件头：连续就写成区间，跳着的才写全表。"""
    if ids is None:
        return None
    a0 = np.asarray(ids, dtype=np.int64).reshape(-1)
    if a0.size == 0:
        return None
    if rank is not None:
        a0 = rank[a0]
    start = int(a0[0])
    if np.array_equal(a0, np.arange(start, start + a0.size, dtype=np.int64)):
        return {"a": start, "b": start + int(a0.size)}
    return {"ids": [int(x) for x in a0]}


def op_ids_dec(e):
    """上面那个编码的逆。"""
    if e is None:
        return None
    if e.get("ids") is not None:
        return np.asarray(e["ids"], dtype=np.uint32)
    a, b = int(e.get("a", 0)), int(e.get("b", 0))
    return np.arange(a, max(a, b), dtype=np.uint32)


def param_dir_entry(p: OpParam) -> dict:
    """文件头目录里的一条参数描述（不含数值）。角色 / 共享只在非默认时才写——
    老软件读到不认识的键会直接忽略，所以旧文件格式仍然读得动。"""
    d = {"name": p.name, "dtype": p.dtype, "shape": list(p.shape)}
    if p.role != "weight":
        d["role"] = p.role
    if p.same:
        d["same"] = str(p.same)
    return d


def op_dir_entry(node: OpNode, rank=None) -> dict:
    """一个算子节点在文件头 JSON 里的那一份（不含参数数值）。"""
    ins = []
    for r in node.ins:
        if r["k"] == "n":
            ins.append({"k": "n", "ids": op_range_enc(r["ids"], rank),
                        "shape": [int(x) for x in r["shape"]]})
        elif r["k"] == "c":
            # 常量输入：数值存在这个节点自己的参数里（广播也能这样表达）
            ins.append({"k": "c", "p": r["p"], "shape": [int(x) for x in r["shape"]]})
        else:
            ins.append({"k": "o", "id": int(r["id"]), "s": int(r.get("s", 0)),
                        "shape": [int(x) for x in r["shape"]]})
    d = {"id": int(node.id), "op": node.op, "name": node.name, "ins": ins,
         "out": [int(x) for x in node.out], "land": op_range_enc(node.land, rank),
         "attrs": dict(node.attrs), "fold": list(node.fold),
         "params": [param_dir_entry(p) for p in node.params],
         "note": node.note, "color": int(node.color), "colOn": 1 if node.col_on else 0}
    if node.pos:
        d["pos"] = {"x": float(node.pos["x"]), "y": float(node.pos["y"]), "z": float(node.pos["z"])}
    return d


def remap_ops(ops: "Ops | None", rank):
    """空间重排之后把算子节点里的神经元 id 换算成新编号。
    算子要读的那一段神经元被空间打散了，所以这里只改编号、不改语义。"""
    if ops is None or rank is None or not len(ops):
        return ops
    for node in ops.list:
        for r in node.ins:
            if r["k"] == "n":
                r["ids"] = rank[r["ids"]].astype(np.uint32)
        if node.land is not None:
            node.land = rank[node.land].astype(np.uint32)
    return ops


def encode_op_parts(ops: Ops):
    """每个算子一段。返回 (parts 元数据, 原始字节列表)——压缩 / 排偏移交给 write()。"""
    parts, raws = [], []
    for i, node in enumerate(ops.list):
        blob = encode_op_blob(node)
        raws.append(blob)
        parts.append({"i": i, "tensors": len(node.params), "bytes": int(node.nbytes),
                      "raw": len(blob), "off": 0, "len": 0, "codec": "raw"})
    return parts, raws


def op_region_base(data_start: int, header: dict) -> int:
    """算子参数区起点：接在权重块区后面。"""
    b = header.get("blocks")
    blk_len = (int(b.get("off") or 0) + int(b["len"])) if b else 0
    om = header.get("ops") or {}
    return data_start + block_region_end(header) + blk_len + int(om.get("off") or 0)


def read_ops_region(f, base: int, om: dict, remap=None):
    """读算子区。返回 (Ops 或 None, 读了多少字节)。

    跟浏览器端一样：输入或落点里但凡有一个神经元没载入，这个算子这次就不载入
    （不半载——缺一路输入照样"能编译"才是最坏的结果）。
    """
    parts = om.get("parts") or []
    if not parts:
        return None, 0
    nodes, nbytes = [], 0
    for p in parts:
        f.seek(base + int(p["off"]))
        body = f.read(int(p["len"]))
        nbytes += len(body)
        if len(body) != int(p["len"]):
            raise ValueError(
                f"算子区第 {p['i']} 段的字节不够：文件头说 {p['len']} 字节，只读到 {len(body)} 字节"
                f"——文件被截断了")
        if p.get("codec") == "deflate":
            body = _inflate(body, f"算子区第 {p['i']} 段")
        elif p.get("codec") != "raw":
            raise ValueError("不认识的算子参数压缩方式：" + str(p.get("codec")))
        params = decode_op_blob(body)
        d = (om.get("dir") or [])[int(p["i"])] if (om.get("dir") or []) else None
        if d is None:
            continue
        try:
            nodes.append(op_node_from_dir(d, params, remap))
        except _OpSkip:
            continue
    return Ops(list=nodes), nbytes


class _OpSkip(Exception):
    pass


def op_node_from_dir(d: dict, params: list, remap=None) -> OpNode:
    def map_ids(e):
        ids = op_ids_dec(e)
        if ids is None:
            return None
        if remap is None:
            return ids
        m = remap[ids]
        if np.any(m < 0):
            return None
        return m.astype(np.uint32)

    ins = []
    for r in (d.get("ins") or []):
        if r["k"] == "n":
            ids = map_ids(r.get("ids"))
            if ids is None:
                raise _OpSkip(f"算子 {d['name']} 的输入神经元这次没载入")
            ins.append({"k": "n", "ids": ids, "shape": [int(x) for x in r["shape"]]})
        elif r["k"] == "c":
            ins.append({"k": "c", "p": r["p"], "shape": [int(x) for x in r["shape"]]})
        else:
            ins.append({"k": "o", "id": int(r["id"]), "s": int(r.get("s", 0)),
                        "shape": [int(x) for x in r["shape"]]})
    land = map_ids(d.get("land"))
    if d.get("land") is not None and land is None:
        raise _OpSkip(f"算子 {d['name']} 的落点神经元这次没载入")
    # 角色（weight / stat / const / int）与「跟谁共享」记在文件头目录里，按名字对回参数体。
    # 老文件没有这两个键 -> OpParam 的默认 role = weight（跟加角色之前的行为一致）。
    role_of = {}
    for dp in (d.get("params") or []):
        if isinstance(dp, dict) and "name" in dp:
            role_of[str(dp["name"])] = dp
    fixed = []
    for p in params:
        dp = role_of.get(str(p.name))
        if dp is not None:
            try:
                p.role = str(dp.get("role") or "weight")
                p.same = str(dp.get("same") or "")
            except ValueError:
                p.role, p.same = "weight", ""
            if p.role not in OP_ROLES:
                p.role = "weight"
        fixed.append(p)
    return OpNode(op=d["op"], name=d["name"], ins=ins, out=d.get("out") or [], land=land,
                  attrs=dict(d.get("attrs") or {}), fold=list(d.get("fold") or []),
                  note=d.get("note") or "", color=int(d.get("color") or 0),
                  col_on=int(d.get("colOn") or 0), pos=d.get("pos"), id=int(d.get("id") or 0),
                  params=fixed)


def _edge_order(src: np.ndarray, n: int):
    """边按起点排序，并给出每一段起点的边区间。块就是按这个区间切的。"""
    order = np.argsort(src, kind="stable")
    src_sorted = src[order]
    start = np.searchsorted(src_sorted, np.arange(n + 1), side="left")
    return order.astype(np.int64), start.astype(np.int64)


# ==========================================================================
# 空间分块：把神经元按 Z 序（Morton）排一遍，再按八叉树切成块
# --------------------------------------------------------------------------
# 为什么必须"重排"而不是"另存一张映射表"：块界得是**连续的神经元下标区间**
# （边的分块也是按起点的下标区间切的），所以想让块对应空间区域，唯一的办法
# 就是在写文件时把神经元按空间顺序排好。读写两边的算法必须逐位一致，
# 否则 JS 写的文件和 Python 写的文件对不上（对拍脚本直接比字节）。
# ==========================================================================

def _morton3(x: int, y: int, z: int, levels: int = MORTON_LEVELS) -> int:
    """三个 10 位整数交织成 30 位码。x 占每个三元组的最高位。"""
    c = 0
    for b in range(levels - 1, -1, -1):
        c = (c << 1) | ((x >> b) & 1)
        c = (c << 1) | ((y >> b) & 1)
        c = (c << 1) | ((z >> b) & 1)
    return c


def morton_codes(pos) -> np.ndarray:
    """坐标量化到 0..MORTON_Q 再交织。全程 float64，两边算出来必须一模一样。"""
    p = np.asarray(pos, dtype=np.float64).reshape(-1, 3)
    n = len(p)
    lo = p.min(axis=0)
    span = p.max(axis=0) - lo
    cols = []
    for j in range(3):
        if span[j] > 0:
            t = np.floor((p[:, j] - lo[j]) / span[j] * MORTON_Q)
            cols.append(np.clip(t, 0, MORTON_Q).astype(np.int64))
        else:
            cols.append(np.zeros(n, dtype=np.int64))
    x, y, z = cols
    code = np.zeros(n, dtype=np.int64)
    for i in range(n):
        code[i] = _morton3(int(x[i]), int(y[i]), int(z[i]))
    return code


def merge_leaves(leaves, limit: int):
    """相邻叶子两两合并，直到块数不超过 limit。相邻块合并后仍连续，安全阀而已。"""
    out = list(leaves)
    while len(out) > limit:
        nxt = []
        for i in range(0, len(out), 2):
            if i + 1 < len(out):
                nxt.append((out[i][0], out[i + 1][1]))
            else:
                nxt.append(out[i])
        out = nxt
    return out


def spatial_plan(code_sorted: np.ndarray, target: int):
    """在**已按码排序**的数组上按八叉树递归切，返回 [(a,b), ...]（首尾相接、递增）。"""
    n = len(code_sorted)
    leaves = []
    stack = [(0, n, MORTON_LEVELS - 1)]
    while stack:
        a, b, lvl = stack.pop()
        if b - a <= target or lvl < 0:
            leaves.append((a, b))
            continue
        shift = 3 * lvl
        parts = []
        cur = a
        o0 = (int(code_sorted[a]) >> shift) & 7
        for i in range(a + 1, b + 1):
            oi = -1 if i == b else ((int(code_sorted[i]) >> shift) & 7)
            if oi != o0:
                parts.append((cur, i))
                cur = i
                o0 = oi
        for p in reversed(parts):
            stack.append((p[0], p[1], lvl - 1))
    leaves.sort()
    return merge_leaves(leaves, MAX_CHUNKS)


def spatial_order(pos, target: int):
    """返回 (perm, rank, plan)：perm[新] = 旧，rank[旧] = 新，plan 是块区间。"""
    n = len(pos)
    if n <= 1:
        idx = np.arange(n, dtype=np.int64)
        return idx, idx.copy(), [(0, n)]
    code = morton_codes(pos)
    # 同码必须保持原序：numpy 的 stable 与 JS 那边的稳定基数排序结果一致
    order = np.argsort(code, kind="stable").astype(np.int64)
    plan = spatial_plan(code[order], target)
    sel = np.concatenate([np.arange(a, b, dtype=np.int64) for a, b in plan])
    perm = order[sel]
    rank = np.empty(n, dtype=np.int64)
    rank[perm] = np.arange(n, dtype=np.int64)
    return perm, rank, plan


def reorder(neurons: Neurons, edges: Edges, names, blocks, perm, rank):
    """按 perm/rank 把整张图重编号一遍（神经元、边、名字、权重块一起搬）。"""
    neu = Neurons(pos=neurons.pos[perm], io=neurons.io[perm], thr=neurons.thr[perm],
                  act=neurons.act[perm], bias=neurons.bias[perm], lock=neurons.lock[perm],
                  col_on=neurons.col_on[perm], col=neurons.col[perm])
    edg = Edges(src=rank[edges.src], dst=rank[edges.dst], w=edges.w, lock=edges.lock)
    nm = None
    if names:
        nm = {int(rank[int(k)]): v for k, v in names.items() if int(k) < len(rank)}
    blk = None
    if blocks is not None and len(blocks):
        blk = Blocks(ks=blocks.ks, ns=blocks.ns, src=rank[blocks.src], dst=rank[blocks.dst], sg=blocks.sg,
                     w=blocks.w, lock=blocks.lock)
    return neu, edg, nm, blk

def _bbox(pos: np.ndarray) -> list:
    if len(pos) == 0:
        return [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    lo = pos.min(axis=0)
    hi = pos.max(axis=0)
    r = lambda v: round(float(v), 3)
    return [r(lo[0]), r(lo[1]), r(lo[2]), r(hi[0]), r(hi[1]), r(hi[2])]


def encode_chunk(neu: Neurons, edg: Edges, n0, n1, e0, e1, order) -> bytes:
    n, e = n1 - n0, e1 - e0
    L = layout(n, e)
    raw = bytearray(L["total"])
    put = lambda key, arr: raw.__setitem__(
        slice(L[key], L[key] + len(arr)), np.ascontiguousarray(arr).tobytes())

    put("pos", neu.pos[n0:n1].reshape(-1))
    put("io", neu.io[n0:n1])
    put("thr", neu.thr[n0:n1])
    put("act", neu.act[n0:n1])
    put("bias", neu.bias[n0:n1])
    put("lock", neu.lock[n0:n1])
    put("colOn", neu.col_on[n0:n1])
    put("col", neu.col[n0:n1].reshape(-1))

    sel = order[e0:e1]
    put("src", edg.src[sel])
    put("dst", edg.dst[sel])
    put("w", edg.w[sel])
    put("elock", edg.lock[sel])
    return bytes(raw)


def remap_source(source: dict, rank) -> dict:
    """空间重排（Z 序切块）之后，把来源表里的神经元区间换算成新编号。

    rank[i] 是"老编号 i 落在新编号的哪一位"。按空间重排会把同一层的神经元打散到
    不连续的编号上，所以换算出来的区间是**近似**的——这件事必须写进 source 里，
    不能装作还是精确的（浏览器那边会显示成范围）。
    """
    if not source or rank is None:
        return source
    out = dict(source)
    spans = []
    for sp in source.get("spans") or []:
        a, b, k = int(sp[0]), int(sp[1]), int(sp[2])
        idx = [int(rank[i]) for i in range(a, min(b, len(rank)))]
        if not idx:
            continue
        spans.append([min(idx), max(idx) + 1, k])
    spans.sort(key=lambda x: (x[0], x[1]))
    out["spans"] = spans
    out["spansCoarse"] = True
    notes = list(out.get("notes") or [])
    notes.append("这份工程是按空间 Z 序切块保存的：神经元编号按位置重排过，"
                 "所以来源表里的神经元区间是近似范围（同一层的神经元被打散了），"
                 "算子名和结构关系仍然是准确的。")
    out["notes"] = notes
    return out


def write(path, neurons: Neurons, edges: Edges, name="未命名工程",
          chunk_neurons: int = DEFAULT_CHUNK_NEURONS, names: dict | None = None,
          compress: bool = True, blocks: "Blocks | None" = None, order: str = ORDER_LINEAR,
          block_parts: bool = True, source: dict | None = None,
          ops: "Ops | None" = None) -> dict:
    n_total, e_total = len(neurons), len(edges)
    if order not in (ORDER_LINEAR, ORDER_SPATIAL):
        raise ValueError("order 只能是 linear 或 spatial")
    plan = None
    rank = None
    if order == ORDER_SPATIAL and n_total > 1:
        perm, rank, plan = spatial_order(neurons.pos, chunk_neurons)
        neurons, edges, names, blocks = reorder(neurons, edges, names, blocks, perm, rank)
        ops = remap_ops(ops, rank)
    if plan is None:
        plan = [(n0, min(n_total, n0 + chunk_neurons))
                for n0 in range(0, max(n_total, 1), chunk_neurons)]
    if source is not None and rank is not None:
        source = remap_source(source, rank)
    eorder, start = _edge_order(edges.src, n_total)

    chunks, blobs = [], []
    off = 0
    for ci, (n0, n1) in enumerate(plan):
        e0, e1 = int(start[n0]), int(start[n1])
        raw = encode_chunk(neurons, edges, n0, n1, e0, e1, eorder)
        codec = "raw"
        body = raw
        if compress and len(raw) >= 2048:
            z = zlib.compress(raw, 6)
            if len(z) < len(raw):
                body, codec = z, "deflate"
        chunks.append({
            "i": ci, "n0": n0, "n1": n1, "e0": e0, "e1": e1,
            "bbox": _bbox(neurons.pos[n0:n1]) if n1 > n0 else [0, 0, 0, 0, 0, 0],
            "off": off, "len": len(body), "raw": len(raw), "codec": codec,
        })
        blobs.append(body)
        off += len(body)
        if n1 >= n_total and n_total > 0:
            break

    # 权重块单独一段，接在神经元块区后面。块的 off 相对神经元块区的末尾（恒为 0，
    # 留字段是为了将来能把它挪到别处）。
    blocks_meta = None
    if blocks is not None and len(blocks):
        if block_parts:
            # 一块一段：每段能单独定位、单独压缩、单独解压，
            # 于是"只读相机附近的权重块"才有可能（不然整段是个整体，一读就得全读）。
            parts, raws = encode_block_parts(blocks, neurons.pos)
            off = 0
            for i, raw_i in enumerate(raws):
                body, codec_i = raw_i, "raw"
                if compress and len(raw_i) >= MIN_PART_ZIP:
                    z = zlib.compress(raw_i, 6)
                    if len(z) < len(raw_i):
                        body, codec_i = z, "deflate"
                parts[i]["off"] = off
                parts[i]["len"] = len(body)
                parts[i]["codec"] = codec_i
                blobs.append(body)
                off += len(body)
            blocks_meta = {
                "count": len(blocks), "weights": blocks.stored_weights,
                "rows": int(blocks.ks.sum()), "cols": int(blocks.ns.sum()),
                "hasLock": blocks.lock is not None, "all": blocks.total_weights,
                "off": 0, "len": off, "raw": sum(int(p["raw"]) for p in parts),
                "codec": PARTS_CODEC, "parts": parts,
            }
        else:
            raw_blk = encode_blocks(blocks)
            codec_b, body_b = "raw", raw_blk
            if compress and len(raw_blk) >= 2048:
                z = zlib.compress(raw_blk, 6)
                if len(z) < len(raw_blk):
                    body_b, codec_b = z, "deflate"
            blocks_meta = {
                "count": len(blocks), "weights": blocks.stored_weights,
                "rows": int(blocks.ks.sum()), "cols": int(blocks.ns.sum()),
                "hasLock": blocks.lock is not None, "all": blocks.total_weights,
                "off": 0, "len": len(body_b), "raw": len(raw_blk), "codec": codec_b,
            }
            blobs.append(body_b)

    # 算子参数单独一段（或者"一个算子一段"）：参数是几十 MB 级的张量，
    # 塞进文件头 JSON 会让打开变慢、内存翻倍，所以一定走二进制分区。
    ops_meta = None
    if ops is not None and len(ops):
        parts, raws = encode_op_parts(ops)
        off = 0
        for i, raw_i in enumerate(raws):
            body, codec_i = raw_i, "raw"
            if compress and len(raw_i) >= MIN_PART_ZIP:
                z = zlib.compress(raw_i, 6)
                if len(z) < len(raw_i):
                    body, codec_i = z, "deflate"
            parts[i]["off"] = off
            parts[i]["len"] = len(body)
            parts[i]["codec"] = codec_i
            blobs.append(body)
            off += len(body)
        ops_meta = {
            "count": len(ops), "tensors": ops.tensors, "bytes": ops.bytes,
            "off": 0, "len": off, "raw": sum(int(p["raw"]) for p in parts),
            "codec": PARTS_CODEC, "dir": [op_dir_entry(n, None) for n in ops.list],
            "parts": parts,
        }

    header = {
        "format": FORMAT, "version": VERSION, "name": name,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "counts": {"neurons": n_total, "edges": e_total,
                   "blockWeights": blocks_meta["weights"] if blocks_meta else 0,
                   "opNodes": ops_meta["count"] if ops_meta else 0,
                   "opParams": ops_meta["bytes"] if ops_meta else 0},
        "chunkNeurons": chunk_neurons,
        "order": order,
        "names": names or {},
        "chunks": chunks,
        "codec": "deflate" if compress else "raw",
    }
    if blocks_meta is not None:
        header["blocks"] = blocks_meta
    if ops_meta is not None:
        header["ops"] = ops_meta
    if source is not None:
        header["source"] = source
    head_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    out = io.BytesIO()
    out.write(MAGIC)
    out.write(struct.pack("<II", len(head_bytes), 0))
    out.write(head_bytes)
    for b in blobs:
        out.write(b)
    data = out.getvalue()
    if path is not None:
        with open(path, "wb") as f:
            f.write(data)
    return {"bytes": len(data), "header": header}


def read_header(path) -> dict:
    with open(path, "rb") as f:
        head = f.read(HEAD_OFF)
        if len(head) < HEAD_OFF or head[:8] != MAGIC:
            raise ValueError(NOT_MINE)
        head_len = struct.unpack("<I", head[8:12])[0]
        blob = f.read(head_len)
    header = json.loads(blob.decode("utf-8"))
    why = header_error(header)
    if why:
        raise ValueError(why)
    return header


def decode_chunk(raw, n, e):
    """把一块解压后的字节拆成字段。返回的都是新拷贝，调用方随便改。

    只做解码，不做 id 重映射——重映射是「只载入一部分块」那一层的事。
    """
    L = layout(n, e)
    if len(raw) < L["total"]:
        raise ValueError(
            f"神经元块被截断了（{n} 个神经元 / {e} 条连接要 {L['total']} 字节，只有 {len(raw)} 字节）")
    m = memoryview(raw)
    return {
        "pos": np.frombuffer(m[L["pos"]:L["pos"] + n * 12], dtype="<f4").reshape(-1, 3).copy(),
        "io": np.frombuffer(m[L["io"]:L["io"] + n], dtype=np.uint8).copy(),
        "thr": np.frombuffer(m[L["thr"]:L["thr"] + n * 4], dtype="<f4").copy(),
        "act": np.frombuffer(m[L["act"]:L["act"] + n], dtype=np.uint8).copy(),
        "bias": np.frombuffer(m[L["bias"]:L["bias"] + n * 4], dtype="<f4").copy(),
        "lock": np.frombuffer(m[L["lock"]:L["lock"] + n], dtype=np.uint8).copy(),
        "col_on": np.frombuffer(m[L["colOn"]:L["colOn"] + n], dtype=np.uint8).copy(),
        "col": np.frombuffer(m[L["col"]:L["col"] + n * 12], dtype="<f4").reshape(-1, 3).copy(),
        "src": np.frombuffer(m[L["src"]:L["src"] + e * 4], dtype="<u4").copy(),
        "dst": np.frombuffer(m[L["dst"]:L["dst"] + e * 4], dtype="<u4").copy(),
        "w": np.frombuffer(m[L["w"]:L["w"] + e * 4], dtype="<f4").copy(),
        "elock": np.frombuffer(m[L["elock"]:L["elock"] + e], dtype=np.uint8).copy(),
    }


class StreamReader:
    """按块流式读：构造时只读文件头，之后要哪一块才读哪一块。

    跟浏览器端的 STREAM 是同一套做法——整份文件从头到尾不会出现在内存里。
    read_bytes 记的是真正从盘上读了多少字节，用来证明「打开 = 只读文件头」。
    """

    def __init__(self, path):
        self.path = path
        with open(path, "rb") as f:
            head = f.read(HEAD_OFF)
            if len(head) < HEAD_OFF or head[:8] != MAGIC:
                raise ValueError(NOT_MINE)
            self.head_len = struct.unpack("<I", head[8:12])[0]
            blob = f.read(self.head_len)
        self.header = json.loads(blob.decode("utf-8"))
        why = header_error(self.header)
        if why:
            raise ValueError(why)
        self.data_start = HEAD_OFF + self.head_len
        self.read_bytes = HEAD_OFF + self.head_len

    @property
    def chunks(self):
        return self.header["chunks"]

    def byte_len(self):
        return os.path.getsize(self.path)

    def chunk_bytes(self, k):
        """只把第 k 块那一段字节读出来（不解压）。"""
        c = self.chunks[k]
        with open(self.path, "rb") as f:
            f.seek(self.data_start + c["off"])
            b = f.read(c["len"])
        self.read_bytes += len(b)
        if len(b) != int(c["len"]):
            raise ValueError(
                f"第 {k} 块的字节不够：文件头说 {c['len']} 字节，只读到 {len(b)} 字节——文件被截断了")
        return b

    def chunk(self, k):
        """读 + 解压第 k 块，返回 decode_chunk 的字段字典。"""
        c = self.chunks[k]
        body = self.chunk_bytes(k)
        raw = _inflate(body, f"第 {k} 块") if c["codec"] == "deflate" else body
        return decode_chunk(raw, c["n1"] - c["n0"], c["e1"] - c["e0"])

    def read_all(self):
        """把每一块依次读进来，拼成跟 read() 一样的东西（块顺序 = 文件顺序）。"""
        return [self.chunk(k) for k in range(len(self.chunks))]

    # ---- 权重块区：跟神经元块一样按需读 ----
    @property
    def blocks(self):
        return self.header.get("blocks") or {}

    def block_parts(self):
        """权重块的分段索引（旧文件没有，返回空列表）。"""
        return self.blocks.get("parts") or []

    def blocks_base(self):
        return block_region_base(self.data_start, self.header)

    def block_part_bytes(self, i):
        """只把第 i 段权重块那一段字节读出来（不解压），跟 chunk_bytes 一样记账。"""
        p = self.block_parts()[i]
        with open(self.path, "rb") as f:
            f.seek(self.blocks_base() + int(p["off"]))
            b = f.read(int(p["len"]))
        self.read_bytes += len(b)
        if len(b) != int(p["len"]):
            raise ValueError(
                f"权重块第 {i} 段的字节不够：文件头说 {p['len']} 字节，只读到 {len(b)} 字节——文件被截断了")
        return b

    def read_blocks(self, ids=None, remap=None):
        """只读选中的那几段权重块。返回 (Blocks 或 None, 丢掉的块数)。"""
        with open(self.path, "rb") as f:
            blk, dropped, nbytes = read_block_region(
                f, self.blocks_base(), self.blocks, ids, remap)
        self.read_bytes += nbytes
        return blk, dropped


def _read_header(f):
    head = f.read(HEAD_OFF)
    if len(head) < HEAD_OFF or head[:8] != MAGIC:
        raise ValueError(NOT_MINE)
    head_len = struct.unpack("<I", head[8:12])[0]
    header = json.loads(f.read(head_len).decode("utf-8"))
    why = header_error(header)
    if why:
        raise ValueError(why)
    return header, HEAD_OFF + head_len


def read_blocks(path, ids=None, remap=None):
    """只读权重块区（或其中几段）。返回 (header, Blocks 或 None, 丢掉的块数, 读了多少字节)。

    ids 空 = 全读。这是"只加载相机附近的权重块"在 Python 侧的入口，
    跟浏览器端 streamLoadBlocks() 一个意思。
    """
    with open(path, "rb") as f:
        header, data_start = _read_header(f)
        bm = header.get("blocks")
        if not (bm and bm.get("count")):
            return header, None, 0, 0
        base = block_region_base(data_start, header)
        f.seek(0, 2)
        end = base + (bm.get("off") or 0) + bm["len"]
        if end > f.tell():
            raise ValueError("权重块区超出文件末尾，文件可能被截断")
        blk, dropped, nbytes = read_block_region(f, base, bm, ids, remap)
        return header, blk, dropped, nbytes


def read(path, ids=None, block_ids=None):
    """读回神经元与边。ids 空 = 全部块；block_ids 可以只读其中几段权重块。

    只读部分块时，神经元会按块顺序拼成连续下标（中间那些块没读），
    跨块的边会被丢弃——和浏览器端 nforge3Apply 的行为一致。
    """
    with open(path, "rb") as f:
        header, data_start = _read_header(f)
        chunks = header["chunks"]
        pick = chunks if not ids else [c for c in chunks if c["i"] in set(ids)]
        if not pick:
            raise ValueError("没有选中任何块")

        N = header["counts"]["neurons"]
        all_at_once = not ids
        remap = None
        if not all_at_once:
            remap = np.full(N, -1, dtype=np.int64)
            k = 0
            for c in pick:
                remap[c["n0"]:c["n1"]] = np.arange(k, k + c["n1"] - c["n0"])
                k += c["n1"] - c["n0"]

        pos, io, thr, act, bias = [], [], [], [], []
        lock, col_on, col = [], [], []
        src, dst, w, elock = [], [], [], []
        base = 0
        for c in pick:
            f.seek(data_start + c["off"])
            body = f.read(c["len"])
            if len(body) != int(c["len"]):
                raise ValueError(
                    f"第 {c['i']} 块的字节不够：文件头说 {c['len']} 字节，只读到 {len(body)} 字节"
                    f"——文件被截断了")
            raw = _inflate(body, f"第 {c['i']} 块") if c["codec"] == "deflate" else body
            n, e = c["n1"] - c["n0"], c["e1"] - c["e0"]
            cd = decode_chunk(raw, n, e)   # 别叫 f：外面那个 f 是文件句柄
            pos.append(cd["pos"]); io.append(cd["io"]); thr.append(cd["thr"])
            act.append(cd["act"]); bias.append(cd["bias"]); lock.append(cd["lock"])
            col_on.append(cd["col_on"]); col.append(cd["col"])
            s, d, ww, el = cd["src"], cd["dst"], cd["w"], cd["elock"]
            if all_at_once:
                src.append(s); dst.append(d); w.append(ww); elock.append(el)
            else:
                s2, d2 = remap[s], remap[d]
                keep = (s2 >= 0) & (d2 >= 0)
                src.append(s2[keep].astype(np.uint32))
                dst.append(d2[keep].astype(np.uint32))
                w.append(ww[keep]); elock.append(el[keep])
            base += n

        cat = lambda xs, dt: np.concatenate(xs) if xs else np.zeros(0, dtype=dt)
        neurons = Neurons(
            pos=cat(pos, "<f4").astype(np.float32),
            io=cat(io, np.uint8), thr=cat(thr, "<f4").astype(np.float32),
            act=cat(act, np.uint8), bias=cat(bias, "<f4").astype(np.float32),
            lock=cat(lock, np.uint8), col_on=cat(col_on, np.uint8),
            col=cat(col, "<f4").astype(np.float32),
        )
        edges = Edges(src=cat(src, "<u4").astype(np.uint32),
                      dst=cat(dst, "<u4").astype(np.uint32),
                      w=cat(w, "<f4").astype(np.float32),
                      lock=cat(elock, np.uint8))

        # ---- 权重块：跟着神经元块区后面那一段。只载入部分块时，块的行列但凡有一个
        # 没载入就整块丢掉（跟浏览器端 nf3BlocksRead 一致）。 ----
        blk = None
        bmeta = header.get("blocks")
        if bmeta and bmeta.get("count"):
            f.seek(0, 2)   # 2 = SEEK_END（这里的 io 是上面那个神经元数组，不能拿来用）
            if block_region_base(data_start, header) + bmeta["len"] > f.tell():
                raise ValueError("权重块区超出文件末尾，文件可能被截断")
            blk, _bdrop, _nb = read_block_region(
                f, block_region_base(data_start, header), bmeta,
                block_ids, None if all_at_once else remap)
        return header, neurons, edges, blk


def read_ops(path, ids=None):
    """单独读算子节点（参数分区）。返回 Ops 或 None。

    ids 非空时按"只载入这几块神经元"重编号；输入或落点没载入的算子这次就不载入
    （不半载——缺一路输入照样"能编译"才是最坏的结果）。
    """
    with open(path, "rb") as f:
        header, data_start = _read_header(f)
        om = header.get("ops")
        if not om or not om.get("count"):
            return None
        remap = None
        if ids:
            N = header["counts"]["neurons"]
            remap = np.full(N, -1, dtype=np.int64)
            k = 0
            for c in header["chunks"]:
                if c["i"] in set(ids):
                    remap[c["n0"]:c["n1"]] = np.arange(k, k + c["n1"] - c["n0"])
                    k += c["n1"] - c["n0"]
        f.seek(0, 2)
        base = op_region_base(data_start, header)
        if base + int(om["len"]) > f.tell():
            raise ValueError("算子参数区超出文件末尾，文件可能被截断")
        ops, _nb = read_ops_region(f, base, om, remap)
        return ops


def check_index(header: dict) -> list:
    """校验索引表自身是否自洽，返回问题列表（空 = 没问题）。"""
    bad = []
    chunks = header["chunks"]
    pn = pe = 0
    for c in chunks:
        if c["n0"] != pn or c["e0"] != pe:
            bad.append(f"第 {c['i']} 块的区间不是首尾相接")
        if c["n1"] < c["n0"] or c["e1"] < c["e0"]:
            bad.append(f"第 {c['i']} 块的区间反了")
        pn, pe = c["n1"], c["e1"]
    if pn != header["counts"]["neurons"]:
        bad.append(f"神经元区间没覆盖全图：{pn} != {header['counts']['neurons']}")
    if pe != header["counts"]["edges"]:
        bad.append(f"连接区间没覆盖全图：{pe} != {header['counts']['edges']}")
    bm = header.get("blocks")
    if bm:
        if not bm.get("count"):
            bad.append("块区计数是 0，不该写进文件头")
        if bm.get("codec") not in ("raw", "deflate", PARTS_CODEC):
            bad.append(f"块区压缩方式认不出：{bm.get('codec')}")
        if bm.get("codec") == PARTS_CODEC:
            parts = bm.get("parts") or []
            count = int(bm.get("count") or 0)
            if len(parts) > count:
                bad.append(f"块区分段数比块数还多：{len(parts)} > {count}")
            off = sk = sn = sw = sb = 0
            seen = [0] * count
            dup = oob = 0
            for j, p in enumerate(parts):
                if int(p.get("i", -1)) != j:
                    bad.append(f"第 {j} 段的编号不是 {j}")
                if int(p.get("off", -1)) != off:
                    bad.append(f"第 {j} 段不是首尾相接：偏移 {p.get('off')} != {off}")
                if p.get("codec") not in ("raw", "deflate"):
                    bad.append(f"第 {j} 段的压缩方式认不出：{p.get('codec')}")
                if int(p.get("len", 0)) <= 0:
                    bad.append(f"第 {j} 段的长度不是正数")
                if len(p.get("bbox") or []) != 6:
                    bad.append(f"第 {j} 段没有包围盒")
                # blocks = 这一段里装着哪些块。共享参数组整组一段，所以段数可以少于块数，
                # 但每一块必须恰好出现一次（漏了 = 读不回来，重了 = 同一个参数有两份）
                for bi in (p.get("blocks") or [j]):
                    bi = int(bi)
                    if not (0 <= bi < count):
                        oob += 1
                        continue
                    if seen[bi]:
                        dup += 1
                    else:
                        seen[bi] = 1
                    sb += 1
                off += int(p.get("len", 0))
                sk += int(p.get("k", 0)); sn += int(p.get("n", 0))
                wsum = p.get("weights")
                sw += int(wsum) if wsum is not None else int(p.get("k", 0)) * int(p.get("n", 0))
            if off != bm.get("len"):
                bad.append(f"各段长度之和跟区长对不上：{off} != {bm.get('len')}")
            if sk != bm.get("rows") or sn != bm.get("cols"):
                bad.append(f"各段行列之和跟区对不上：{sk}/{sn} != {bm.get('rows')}/{bm.get('cols')}")
            if sw != bm.get("weights"):
                bad.append(f"各段权重之和跟区对不上：{sw} != {bm.get('weights')}")
            if sb != count:
                bad.append(f"各段装着的块数之和跟块数对不上：{sb} != {count}")
            if dup or oob:
                bad.append(f"分段里的块编号不合法（重复 {dup} 个 / 越界 {oob} 个）")
            miss = sum(1 for x in seen if not x)
            if miss:
                bad.append(f"有 {miss} 个权重块没被任何一段装着")
        if (bm.get("off") or 0) < 0:
            bad.append("块区偏移是负数")
        if bm.get("len", 0) <= 0:
            bad.append("块区长度不是正数")
        if bm.get("rows", 0) <= 0 or bm.get("cols", 0) <= 0:
            bad.append("块区的行数 / 列数不是正数")
        if header["counts"].get("blockWeights", 0) != bm.get("weights"):
            bad.append(f"块权重数对不上：{header['counts'].get('blockWeights')} != {bm.get('weights')}")
    elif header["counts"].get("blockWeights", 0):
        bad.append("文件头说有块权重，却没有块区索引")
    # 算子区索引：跟浏览器端 nf3CheckIndex 是同一套判据
    om = header.get("ops")
    if om:
        if not om.get("count"):
            bad.append("算子区计数是 0，不该写进文件头")
        if om.get("codec") != PARTS_CODEC:
            bad.append(f"算子区的存放方式认不出：{om.get('codec')}")
        parts = om.get("parts") or []
        if not parts:
            bad.append("算子区没有分段表")
        if len(om.get("dir") or []) != int(om.get("count") or 0):
            bad.append(f"算子目录条数跟计数对不上：{len(om.get('dir') or [])} != {om.get('count')}")
        off = tb = tn = 0
        for j, p in enumerate(parts):
            if int(p.get("i", -1)) != j:
                bad.append(f"算子区第 {j} 段的编号不是 {j}")
            if int(p.get("off", -1)) != off:
                bad.append(f"算子区第 {j} 段不是首尾相接：{p.get('off')} != {off}")
            if p.get("codec") not in ("raw", "deflate"):
                bad.append(f"算子区第 {j} 段的压缩方式认不出：{p.get('codec')}")
            if int(p.get("len", 0)) <= 0:
                bad.append(f"算子区第 {j} 段的长度不是正数")
            off += int(p.get("len", 0))
            tb += int(p.get("bytes", 0))
            tn += int(p.get("tensors", 0))
        if off != om.get("len"):
            bad.append(f"算子区各段长度之和跟区长对不上：{off} != {om.get('len')}")
        if tb != om.get("bytes"):
            bad.append(f"算子区各段参数字节之和跟区对不上：{tb} != {om.get('bytes')}")
        if tn != om.get("tensors"):
            bad.append(f"算子区各段张量个数之和跟区对不上：{tn} != {om.get('tensors')}")
        if int(header["counts"].get("opNodes", 0)) != int(om.get("count") or 0):
            bad.append(f"算子节点数对不上：{header['counts'].get('opNodes')} != {om.get('count')}")
        if int(header["counts"].get("opParams", 0)) != int(om.get("bytes") or 0):
            bad.append(f"算子参数字节数对不上：{header['counts'].get('opParams')} != {om.get('bytes')}")
    elif header["counts"].get("opNodes", 0):
        bad.append("文件头说有算子节点，却没有算子区索引")
    return bad
