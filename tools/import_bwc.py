# -*- coding: utf-8 -*-
"""import_bwc.py —— 把 born-wired-cortex（天生皮层连接）那套 Python 模型导成 .nforge

为什么需要它：那个仓库里**没有**任何"整网快照"文件（没有 .pt / .npz / .onnx），
它的皮层网是运行时用固定种子现生成的（皮层连接_cortex_links.py + 本能工具_instincts.py）。
所以想把它搬进编辑器，唯一忠实的办法就是**跑它自己的代码建一次网，再把结果导出来**。

用法：

    py -3 -X utf8 tools/import_bwc.py <仓库的 model 目录> -o born_wired_cortex.nforge

常用开关：

    --keep-born 1.0      出生随机兴奋连接的保留比例（0~1），默认全要（1.0）。
                         注意：**本能连接（本能表展开出来的那 30 万条）永远不抽样**，
                         这个开关只管"出生随机撒的那一片模糊底噪"。
    --no-inhibit         不要抑制连接（默认要，写成负权重）
    --min-w 0.0          丢掉绝对值低于这个权重的边（默认 0，不丢）
    --regions 视觉,听觉   只要这几个区（默认全要）。没要的区**不导出**，神经元会重新编号
    --spacing 1.0        区内神经元间距
    --gap 12.0           区与区之间的空隙
    --chunk 65536        每块多少个神经元（空间分块的粒度，影响流式载入）

出来的文件直接用软件的「打开工程」打开，就能看到整片皮层。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

_这里 = os.path.dirname(os.path.abspath(__file__))
if _这里 not in sys.path:
    sys.path.insert(0, _这里)
import nforge  # noqa: E402

# 12 个区各给一个颜色（0~1 的 RGB），一眼分得清哪片是哪片
区色 = {
    "视觉":     (0.20, 0.62, 1.00),
    "视觉细节": (0.05, 0.95, 0.85),
    "听觉":     (1.00, 0.62, 0.16),
    "前额叶":   (0.72, 0.42, 1.00),
    "运动":     (1.00, 0.25, 0.35),
    "运动记忆": (1.00, 0.42, 0.72),
    "本体感觉": (0.55, 1.00, 0.35),
    "平衡感觉": (0.85, 0.95, 0.25),
    "机身状态": (0.45, 0.85, 0.55),
    "视觉运动": (0.25, 0.45, 0.95),
    "多巴胺":   (1.00, 0.88, 0.20),
    "抑制":     (0.55, 0.55, 0.62),
}
默认色 = (0.75, 0.78, 0.82)


def 装网(仓库模型目录: str, 说: bool = True):
    """把仓库那份代码跑起来，建出一整张出生状态的皮层网。

    返回 (网, 目录, 本能掩码)。本能掩码是布尔数组，True 表示这条兴奋边是
    「本能表」展开出来的（不是出生随机撒的）——导出时这些边一条都不许丢。
    """
    目录 = os.path.abspath(仓库模型目录)
    if not os.path.isdir(目录):
        raise SystemExit(f"没有这个目录：{目录}")
    if not os.path.isfile(os.path.join(目录, "本能工具_instincts.py")):
        raise SystemExit(f"{目录} 里没有 本能工具_instincts.py —— 这个路径要指到仓库的 model 目录")
    os.chdir(目录)
    sys.path.insert(0, 目录)
    if 说:
        print("建网中（跑的是仓库自己的代码，种子是它自己写死的）…")
    起 = time.time()
    import 本能工具_instincts as 本能
    # 先只建"出生随机"那一片，把它的键记下来；再装本能表，多出来的就是本能连接
    网0 = 本能.建网()
    出生键 = 网0._兴奋键
    网, 条数 = 本能.装(网=网0, 说=False)
    新生键 = np.setdiff1d(网._兴奋键, 出生键, assume_unique=True)
    本能掩码 = np.isin(网._兴奋键, 新生键, assume_unique=False)
    if 说:
        print(f"  建好了：{网.总数:,} 个神经元，用时 {time.time() - 起:.1f}s")
        print(f"  本能规则展开出 {条数:,} 条连接，落到网上 {int(本能掩码.sum()):,} 条")
    return 网, 目录, 本能掩码


def 读名字表(目录: str) -> dict:
    """皮层名字.json：区 -> 概念 -> [神经元号]。翻成 号 -> '区:概念'。"""
    路径 = os.path.join(目录, "皮层名字.json")
    if not os.path.isfile(路径):
        return {}
    with open(路径, "r", encoding="utf-8") as f:
        表 = json.load(f)
    反 = {}
    for 区, 概念们 in 表.items():
        for 概念, 号们 in 概念们.items():
            for 号 in 号们:
                反[int(号)] = f"{区}:{概念}"
    return 反


def 铺位置(网, 保留: np.ndarray, 间距: float, 空隙: float, 摆法: str = "block"):
    """给每个神经元编一个 3D 坐标。

    摆法 = "block"（默认）：每个区排成**一个立方体块**（边长 = n 的三次方根），
        块再按 4x3 铺在 X-Z 平面上。这样整张网是一个紧凑的方块阵，一共也就
        一两百个单位大小，转一圈能看全，一个区就是一块。
        块里按号码顺序排（层 -> 行 -> 列），所以同一个概念的细胞挤在一起。
    摆法 = "wall"：每个区一面竖墙，区沿着 X 一条线排开。这张网转起来像一条长棍，
        但区与区之间分得最清楚。

    注意：原模型里**没有**神经元的三维坐标，这里的摆放纯粹是为了看得清，
    不是原模型里的空间关系。
    """
    pos = np.zeros((网.总数, 3), dtype=np.float32)
    要 = []
    for 区 in 网.区名:
        if 保留[网.区起点[区]]:
            要.append(区)
    if 摆法 == "wall":
        # 一面墙：区沿着 X 排，墙在 Y-Z 平面上铺开
        墙宽 = 0.0
        for 区 in 要:
            墙宽 = max(墙宽, float(np.ceil(np.sqrt(max(网.区宽[区], 1)))) * 间距)
        for k, 区 in enumerate(要):
            起, 宽 = 网.区起点[区], 网.区宽[区]
            列 = int(np.ceil(np.sqrt(max(宽, 1))))
            行 = int(np.ceil(宽 / 列))
            号 = np.arange(宽)
            pos[起:起 + 宽, 0] = k * (墙宽 + 空隙)
            pos[起:起 + 宽, 1] = ((号 // 列) - (行 - 1) / 2.0) * 间距
            pos[起:起 + 宽, 2] = ((号 % 列) - (列 - 1) / 2.0) * 间距
        return pos

    # 一块一方：先算每个区立方体的边长，再决定 4x3 的格子多大
    边 = {}
    最大边 = 1
    for 区 in 要:
        边[区] = int(np.ceil(max(网.区宽[区], 1) ** (1.0 / 3.0)))
        最大边 = max(最大边, 边[区])
    列数 = max(1, int(np.ceil(np.sqrt(len(要) * 4.0 / 3.0))))
    格 = 最大边 * 间距 + 空隙
    for k, 区 in enumerate(要):
        起, 宽 = 网.区起点[区], 网.区宽[区]
        b = 边[区]
        格列 = k % 列数
        格行 = k // 列数
        号 = np.arange(宽)
        层 = 号 // (b * b)
        余 = 号 % (b * b)
        pos[起:起 + 宽, 0] = (格列 - (列数 - 1) / 2.0) * 格 + (余 % b) * 间距
        pos[起:起 + 宽, 1] = (层 - (b - 1) / 2.0) * 间距
        pos[起:起 + 宽, 2] = (格行 - (len(要) - 1) // 列数 / 2.0) * 格 + (余 // b) * 间距
    return pos


def 主():
    ap = argparse.ArgumentParser(description="把 born-wired-cortex 导成 .nforge")
    ap.add_argument("仓库模型目录", help="仓库里 model/ 那个目录")
    ap.add_argument("-o", "--out", default="born_wired_cortex.nforge")
    ap.add_argument("--name", default="born-wired-cortex 天生皮层")
    ap.add_argument("--keep-born", type=float, default=1.0,
                    help="出生随机兴奋连接的保留比例 0~1（本能连接不受影响）")
    ap.add_argument("--no-inhibit", action="store_true", help="不要抑制连接")
    ap.add_argument("--min-w", type=float, default=0.0, help="丢掉绝对值低于这个权重的边")
    ap.add_argument("--regions", default="", help="只要这几个区，逗号分开（默认全要）")
    ap.add_argument("--spacing", type=float, default=1.0)
    ap.add_argument("--gap", type=float, default=12.0)
    ap.add_argument("--layout", default="block", choices=["block", "wall"],
                    help="block=每区一个立方体块拼成方块阵（默认）；wall=每区一面竖墙排成一条线")
    ap.add_argument("--chunk", type=int, default=16384,
                    help="每块多少个神经元。块越小、靠近时载入得越细，但块数变多")
    ap.add_argument("--seed", type=int, default=20260914, help="抽样用的种子")
    a = ap.parse_args()
    # 建网时脚本会 chdir 到仓库目录，所以先把输出路径钉成绝对路径
    a.out = os.path.abspath(a.out)

    网, 目录, 本能掩码 = 装网(a.仓库模型目录)

    # 只要哪几个区
    全区 = list(网.区名)
    if a.regions.strip():
        要 = [s.strip() for s in a.regions.replace("，", ",").split(",") if s.strip()]
        不认 = [s for s in 要 if s not in 全区]
        if 不认:
            raise SystemExit(f"没有这些区：{'、'.join(不认)}。可用的：{'、'.join(全区)}")
    else:
        要 = 全区
    保留 = np.zeros(网.总数, dtype=bool)
    for 区 in 要:
        保留[网.区起点[区]: 网.区起点[区] + 网.区宽[区]] = True

    名字 = 读名字表(目录)
    pos = 铺位置(网, 保留, a.spacing, a.gap, a.layout)

    # 没要的区**不导出**：留下来的神经元重新编号成 0..n-1，边跟着换号
    新号 = np.full(网.总数, -1, dtype=np.int64)
    新号[保留] = np.arange(int(保留.sum()), dtype=np.int64)

    print(f"  导出范围：{'、'.join(要)}")
    print(f"  神经元   {int(保留.sum()):,} / {网.总数:,}")

    # ---- 边：兴奋（正权重）+ 抑制（负权重）----
    源段, 目段, 权段, 固段 = [], [], [], []
    rng = np.random.default_rng(a.seed)

    def 收(源, 目, 权, 固, 必留=None):
        好 = 保留[源] & 保留[目]
        if a.min_w > 0:
            好 &= np.abs(权) >= a.min_w
        必 = 必留[好] if 必留 is not None else None
        源, 目, 权 = 新号[源[好]], 新号[目[好]], 权[好]
        固 = 固[好] if 固 is not None else None
        if a.keep_born < 1.0:
            抽 = rng.random(源.size) < a.keep_born
            if 必 is not None:
                抽 |= 必          # 本能连接一条都不许丢
            源, 目, 权 = 源[抽], 目[抽], 权[抽]
            固 = 固[抽] if 固 is not None else None
        if 源.size:
            源段.append(源.astype(np.uint32))
            目段.append(目.astype(np.uint32))
            权段.append(权.astype(np.float32))
            固段.append((固.astype(np.uint8) if 固 is not None
                         else np.zeros(源.size, dtype=np.uint8)))
        return int(源.size)

    出生 = 收(网._兴奋源, 网._兴奋目, 网._兴奋权, 网._兴奋固化, 必留=本能掩码)
    print(f"  兴奋连接 {出生:,}")
    抑制 = 0
    if not a.no_inhibit:
        抑制 = 收(网._抑制源, 网._抑制目, -np.abs(网._抑制权), None)
        print(f"  抑制连接 {抑制:,}")

    if 出生 + 抑制 == 0:
        raise SystemExit("一条边都没有：检查 --regions / --min-w 是不是卡太死了")

    # ---- 神经元属性 ----
    n = int(保留.sum())
    thr = float(getattr(网, "兴奋阈值", 0.0) or 0.0)
    io = np.zeros(网.总数, dtype=np.uint8)
    # ---- 顺手把「接口」标好，省得每次载进来还要手工圈一遍 ----
    #   运动区     -> 对外输出。**整个区**都要标，不能只标尾巴：
    #                运动区是「每块肌肉 10 个细胞」排下来的（前面是 12 条腿的肌肉、
    #                后面 4 条是眼球肌肉），只标最后 20 个等于只把眼球接出去了，
    #                身体一根发力通道都没接。接仿真时软件会按 fold=10 把每 10 个
    #                压成一路执行器，正好一块肌肉一路。
    #   本体感觉区 -> 接收外界信号。它的值本来就该由身体／仿真每拍灌进来。
    #
    #   ★ 注意「接收外界信号」的神经元，它的**入边不会进模型**（值由外部整份写入，
    #     留着入边会在同一拍里把写进去的信号当场改掉）。所以标完以后，编进去的连接
    #     会比 16,817,110 少一截（实测少 66,935 条），编译报告里会如实写出来。
    _接口表 = {"运动": nforge.IO_OUT, "本体感觉": nforge.IO_IN}
    for _名, _io in _接口表.items():
        if _名 in 要:
            _起, _宽 = 网.区起点[_名], 网.区宽[_名]
            io[_起: _起 + _宽] = _io
            print(f"  接口：{_名} {_宽} 个细胞标成 {'输出到外界' if _io == nforge.IO_OUT else '接收外界信号'}")
    act = np.full(网.总数, nforge.ACT_NAMES.index("relu"), dtype=np.uint8)

    col = np.zeros((网.总数, 3), dtype=np.float32)
    col_on = np.zeros(网.总数, dtype=np.uint8)
    for 区 in 网.区名:
        起, 宽 = 网.区起点[区], 网.区宽[区]
        c = 区色.get(区, 默认色)
        col[起:起 + 宽, 0], col[起:起 + 宽, 1], col[起:起 + 宽, 2] = c
        col_on[起:起 + 宽] = 1
    # 有名字的细胞（标定过的）亮一点，一眼看得出
    有名字 = np.zeros(网.总数, dtype=bool)
    for 号 in 名字:
        if 0 <= 号 < 网.总数:
            有名字[号] = True
    col[有名字] = np.minimum(col[有名字] + 0.25, 1.0)

    neu = nforge.Neurons(pos=pos[保留], io=io[保留],
                         thr=np.full(网.总数, thr, dtype=np.float32)[保留],
                         act=act[保留], col_on=col_on[保留], col=col[保留])
    edg = nforge.Edges(src=np.concatenate(源段), dst=np.concatenate(目段),
                       w=np.concatenate(权段), lock=np.concatenate(固段))

    名表 = {}
    for 号, 名 in 名字.items():
        if 0 <= 号 < 网.总数 and 保留[号]:
            名表[int(新号[号])] = 名

    src = {
        "format": 1,
        "kind": "born-wired-cortex",
        "generator": "NeuroForge import_bwc.py",
        "model": "born-wired-cortex",
        "exact": True,
        "auto": {"names": bool(名表), "positions": False, "layout": a.layout,
                 "spacing": float(a.spacing)},
        "layerCount": len(要),
        "nodes": [{"id": i, "name": 区, "op": "region", "n": int(网.区宽[区]),
                   "from": int(新号[网.区起点[区]]),
                   "to": int(新号[网.区起点[区] + 网.区宽[区] - 1]) + 1}
                  for i, 区 in enumerate(要)],
        "spans": [],
        "notes": [
            "这是 born-wired-cortex 的**出生状态**：跑它自己的 本能工具_instincts.装() 建出来的那张网，"
            "没有经过任何学习（赫布学习一步都没走）。",
            f"整网 {网.总数:,} 个皮层神经元；导进来 {n:,} 个（{"、".join(要)}）。",
            f"兴奋连接 {出生:,} 条（本能表展开的那部分一条没丢，全都标成固化），"
            f"抑制连接写成负权重。",
            "原模型里**没有**神经元的三维坐标 —— 位置是导出时按区生成的（摆法：" + a.layout + "）："
            "每个区一块，区里按号码顺序排，块与块再拼成一片。所以「同一个概念的细胞挤在一起」，"
            "但空间位置不是原模型里的东西。",
            f"阈值取原模型的兴奋阈值 {thr}，激活函数统一按 relu 记（原模型是脉冲式的点亮 / 不亮）。",
        ],
        "skipped": [],
        "casts": [],
        "shared": [],
        "precision": {"weights": "float32", "examples": []},
        "counts": {"ops": len(要), "spans": 0, "skipped": 0, "shared": 0, "blocks": 0,
                   "blockWeights": 0, "opNodes": 0, "opParams": 0, "opLanded": 0},
    }

    print(f"  写文件 {a.out} …")
    起 = time.time()
    info = nforge.write(a.out, neu, edg, name=a.name, chunk_neurons=a.chunk,
                        names=名表, compress=True, order=nforge.ORDER_SPATIAL, source=src)
    坏 = nforge.check_index(info["header"])
    if 坏:
        raise SystemExit("索引表自检没过：" + "；".join(坏))
    print(f"  好了：{a.out}")
    print(f"    神经元 {len(neu):,}   边 {len(edg):,}   文件 {os.path.getsize(a.out) / 1048576:.1f} MB"
          f"   用时 {time.time() - 起:.1f}s")


if __name__ == "__main__":
    主()
