# -*- coding: utf-8 -*-
"""bridge_mujoco.py —— 把 MuJoCo（以及任何能读写 UDP 的仿真器）接到 NeuroForge 上。

为什么要这个文件
----------------
NeuroForge 里的接口层只管"收一串数 / 发一串数"：
  · 软件里建一条 **入** 通道（UDP 监听 127.0.0.1:9101，编码 float32），
    它收到的第 i 个数就写进"信号位"里第 i 个神经元；
  · 软件里建一条 **出** 通道（UDP 发送到 127.0.0.1:9102，编码 float32），
    它把"信号位"里那些神经元当前的激活值按周期发出来。

这个脚本就是另一半：把物理仿真器的状态编码成 float32 数组发过去，
再把收到的 float32 数组当控制量施加回去。**两边都不需要知道对方是什么**，
所以换 MuJoCo 版本、换机器人 XML、甚至换成别的仿真器（PyBullet / Isaac / 自写刚体）
都只是换这个脚本，软件本身一个字都不用改。

默认行为（可直接跑）
--------------------
  观测量 obs = [躯干高度(1), 躯干四元数(4), 关节角度(nq-7), 关节速度(nv-6)]
  控制量 act = 模型里所有执行器（m.nu 个），值域 [-1, 1]
  每拍 20 ms（50 Hz），每拍做 4 次 mj_step（跟 model/仿真_桥_mujoco.py 一致）

用法
----
  py tools/bridge_mujoco.py --xml "C:/.../仿真_小人.xml"            # 只跑仿真
  py tools/bridge_mujoco.py --xml ... --viewer                      # 开可视化窗口
  py tools/bridge_mujoco.py --xml ... --obs qpos,qvel,cam --cam 8   # 带上"眼"相机的灰度图
  py tools/bridge_mujoco.py --xml ... --seconds 10                  # 跑 10 秒就退出（自检用）

端口（要和软件里那两条通道填的一致）：
  --obs-port 9101   观测发到这里（软件的入通道在监听）
  --act-port 9102   控制从这里收（软件的出通道发到这里）
"""
from __future__ import annotations

import argparse
import pathlib
import socket
import sys
import time

import numpy as np

默认XML候选 = [
    pathlib.Path(__file__).resolve().parent / "mujoco" / "humanoid.xml",
    pathlib.Path.home() / "AppData/Local/Temp/bwc/model/仿真_小人.xml",
    pathlib.Path("/tmp/bwc/model/仿真_小人.xml"),
]


def 找XML(给的全路径):
    if 给的全路径:
        p = pathlib.Path(给的全路径)
        if not p.exists():
            raise SystemExit("找不到模型文件：" + str(p))
        return p
    for p in 默认XML候选:
        if p.exists():
            return p
    raise SystemExit("没给 --xml，也没找到默认模型。请用 --xml 指定一个 MuJoCo XML。")


def 状态坏了(体):
    """物理状态发散（NaN/Inf）时返回 True。

    摔得太狠、接触求解炸掉的时候 MuJoCo 会给出 NaN 的 qpos/qvel，之后所有读数都是垃圾
    （躯干坐标会给出一个根本不存在的高度，看起来像「机器人站到了 0.08」）。这里统一判一下，
    让主循环能立刻复位，而不是继续拿垃圾数据喂皮层。
    """
    try:
        d = 体.d
        return (not np.isfinite(np.asarray(d.qpos)).all()) or (not np.isfinite(np.asarray(d.qvel)).all())
    except AttributeError:
        return False


def 折成执行器数(v, n, 折叠=0):
    """把软件发来的一串数压成 n 路执行器，并说清是怎么压的。

    软件那边的出通道是「一个信号位一个值」，所以收到的是**输出细胞的原值**
    （born-wired-cortex 全模型 = 运动区 160 个）。怎么压由身体定：
      · 折叠 > 0 且够长 ：每 折叠 个取平均（运动皮层一块肌肉正好 10 个细胞）
      · 正好整除        ：按 n 等分取平均
      · 比 n 多但不整除 ：按位置尽量均分
      · 比 n 少         ：返回 None，由调用方按身体补默认值
    返回 (数组 或 None, 说明字符串)。说明会打印出来，方便核对分组对不对。
    以前这里遇到 10 < 长度 < n*折叠 会直接 v[:n]，等于把 0/1 的「激活」当「发力」用，
    是一条安静的错误路径；现在这条路径不存在了。尾巴被丢掉时会明说丢了几路。
    """
    v = np.asarray(v, dtype=np.float64).ravel()
    if n <= 0 or v.size == 0:
        return None, "一个数都没收到"
    if v.size == n:
        return v, ""
    if 折叠 and v.size >= n * 折叠:
        用 = n * 折叠
        压 = v[:用].reshape(n, 折叠).mean(axis=1)
        余 = int(v.size - 用)
        if 余:
            路 = 余 // 折叠 if 余 >= 折叠 else 1
            return 压, ("每 %d 个取平均（用了前 %d 个，丢掉尾巴 %d 个 = 多出来那 %d 路：这块身体没有对应的执行器）"
                       % (折叠, 用, 余, 路))
        return 压, "每 %d 个取平均" % 折叠
    if v.size > n and v.size % n == 0:
        return v.reshape(n, -1).mean(axis=1), "按 %d 等分取平均" % n
    if v.size > n:
        边 = np.rint(np.linspace(0, v.size, n + 1)).astype(int)
        return (np.array([v[边[i]:边[i + 1]].mean() for i in range(n)]),
                "按位置分 %d 组取平均（收到的个数不是执行器数的整数倍）" % n)
    return None, ("只收到 %d 个，比执行器数 %d 还少" % (v.size, n))


class 仿真:
    """MuJoCo 侧的一层薄封装。只做三件事：读状态、写控制、推进一步。"""

    def __init__(self, 路径, 宽=320, 高=240, 开渲染=False, 感光格=8):
        import mujoco
        self.mj = mujoco
        # 中文路径的坑：MuJoCo 的 C++ 侧打不开带非 ASCII 的路径，
        # 所以一律"读成字符串再载入"，不走 from_xml_path。
        xml = pathlib.Path(路径).read_text(encoding="utf-8")
        base = str(pathlib.Path(路径).resolve().parent)
        self.m = mujoco.MjModel.from_xml_string(xml)
        self.d = mujoco.MjData(self.m)
        self.宽, self.高 = 宽, 高
        self.感光格 = max(1, int(感光格) * int(感光格))
        self.渲染器 = None
        if 开渲染 and self.m.ncam > 0:
            self.渲染器 = mujoco.Renderer(self.m, 高, 宽)
        self.相机 = "眼"
        if self.m.ncam == 0:
            self.相机 = None
        elif mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_CAMERA, self.相机) < 0:
            self.相机 = mujoco.mj_id2name(self.m, mujoco.mjtObj.mjOBJ_CAMERA, 0)
        self.站姿 = None          # 站姿基线：复位那一刻的关节角（关节偏差相对它算）
        self.执行器名 = []
        for i in range(self.m.nu):
            nm = mujoco.mj_id2name(self.m, mujoco.mjtObj.mjOBJ_ACTUATOR, i)
            self.执行器名.append(nm if nm else ("act" + str(i)))
        # 从 base 目录载入，网格之类的资源按 xml 所在目录解析
        try:
            self.mj.mj_forward(self.m, self.d)
        except Exception:
            pass

    def 复位(self):
        self.mj.mj_resetData(self.m, self.d)
        self.mj.mj_forward(self.m, self.d)
        if self.站姿 is None:
            self.站姿 = np.asarray(self.d.qpos[7:], dtype=np.float64).copy()   # 站姿基线

    def 角度(self):
        return np.asarray(self.d.qpos[7:], dtype=np.float64).copy()

    def 角速度(self):
        return np.asarray(self.d.qvel[6:], dtype=np.float64).copy()

    def 躯干(self):
        return np.asarray(self.d.qpos[0:7], dtype=np.float64).copy()

    def 关节偏差(self):
        """相对站姿的关节角偏差（-1~1）。站姿 = 复位那一刻的姿态。"""
        q = np.asarray(self.d.qpos[7:], dtype=np.float64)
        base = self.站姿 if (self.站姿 is not None and self.站姿.size == q.size) else np.zeros_like(q)
        return np.clip(q - base, -1.0, 1.0)

    def 关节速度(self):
        """关节角速度，除 8 再截到 -1~1（跟仓库里 本体感觉区 的口径一致）。"""
        v = np.asarray(self.d.qvel[6:], dtype=np.float64)
        return np.clip(v / 8.0, -1.0, 1.0)

    def 本体感觉编码(self, 每特征=20, 半档=10):
        """把身体状态编成"调谐感觉区"那套 0/1 码（跟仓库 感觉区_共同.py 同一套规则）。

        一个特征占 20 个细胞：前 10 个是正半（0~1），后 10 个是负半（-1~0）。
        值是 v 时，点亮 |v| 所在那一半、档位附近的 3 个细胞——相近状态点亮的
        细胞重叠（模糊），差得远的状态几乎不重叠（分得开）。
        特征 = 12 个关节角偏差 + 12 个关节角速度（不够就补 0，多了截掉）。
        """
        特征 = np.concatenate([self.关节偏差()[:12], self.关节速度()[:12]])
        if 特征.size < 24:
            特征 = np.concatenate([特征, np.zeros(24 - 特征.size)])
        出 = np.zeros(24 * 每特征, dtype=np.float32)
        for i in range(24):
            v = float(特征[i])
            if v == 0.0:
                continue
            档 = int(np.clip(round(abs(v) * 半档), 1, 半档))
            偏 = 0 if v > 0 else 半档
            for d in (-1, 0, 1):
                j = 档 - 1 + d
                if 0 <= j < 半档:
                    出[i * 每特征 + 偏 + j] = 1.0
        return 出

    def 观察(self, 模式):
        """按模式拼出观测向量：qpos / qvel / pro / cam / act 任意组合。

        pro = 本体感觉那套 0/1 码（480 个数，24 个特征 × 20 个细胞），
        接软件里"本体感觉"那 480 个信号位时要放在最前面。
        """
        out = []
        if "pro" in 模式:
            out.append(self.本体感觉编码())
        if "qpos" in 模式:
            out.append(self.躯干())
            out.append(self.角度())
        if "qvel" in 模式:
            out.append(np.asarray(self.d.qvel[0:6], dtype=np.float64).copy())
            out.append(self.角速度())
        if "cam" in 模式 and self.渲染器 is not None:
            self.渲染器.update_scene(self.d, camera=self.相机)
            img = self.渲染器.render()                      # H x W x 3, uint8
            g = img.mean(axis=2)                            # 灰度
            h, w = g.shape
            k = max(1, min(16, int(np.sqrt(self.感光格))))      # 下采样到 k x k
            ys = np.linspace(0, h - 1, k).astype(int)
            xs = np.linspace(0, w - 1, k).astype(int)
            out.append(g[np.ix_(ys, xs)].ravel() / 255.0)
        if "act" in 模式:
            out.append(np.asarray(self.d.act, dtype=np.float64).copy())
        if not out:
            return np.zeros(1, dtype=np.float32)
        return np.concatenate(out).astype(np.float32)

    def 写控制(self, 值, 折叠=0, 增益=1.0, 偏置=0.0):
        """收到的数 -> m.ctrl。

        软件发过来的常常不是"每个执行器一个数"：比如皮层 20 个输出细胞要压成
        10 个执行器（--fold 2），而且那些细胞是 0/1、执行器要 -1~1
        （--act-gain 2 --act-bias -1）。这两件事都在这里做。
        """
        v = np.asarray(值, dtype=np.float64).ravel()
        n = self.m.nu
        压, 说明 = 折成执行器数(v, n, 折叠)
        if 压 is None:
            压 = np.concatenate([v, np.zeros(n - v.size)])
        self.写控制说明 = 说明
        self.d.ctrl[:] = np.clip(压[:n] * 增益 + 偏置, -1.0, 1.0)

    def 步进(self, 次数):
        for _ in range(int(次数)):
            self.mj.mj_step(self.m, self.d)


# -*- coding: utf-8 -*-
"""Go2（宇树四足）这一路：跟仓库 model/身体_go2.py 的接口口径对齐。

为什么要有它
------------
born-wired-cortex 这套大脑的"身体"是宇树 Go2：12 个关节正好当 12 块肌肉，
运动皮层每块肌肉占 10 个神经元、亮几个就出多大力（0~1）。
而 model/仿真_小人.xml 是个 10 关节的双足，关节点位、顺序、量纲都不一样，
拿小人的本体感觉码喂给 Go2 那套本能，等于给一个人穿别人的鞋。

所以这里把 Go2 那一路整套抄齐：
  · 观测 pro：12 个关节角偏差（弧度，截到 ±1）+ 12 个角速度（除 8，截到 ±1）
              = 24 个特征 → 调谐成 480 个 0/1 细胞（和 感觉区_共同.py 同一套规则）
  · 控制   ：收到的一串数按 fold 折成 12 块肌肉的发力 [0,1]，
              发力 → 目标角（每块肌肉一段角度范围，站姿正好落在 0.5）
              → PD 力矩（刚度 80 / 阻尼 4 / 上限 25 牛米）→ d.ctrl
参数都照抄 model/身体_go2.py，改这里就是改"肌肉"。
"""
import urllib.request

# ---------------- 12 块肌肉（顺序 = 运动皮层里腿那 120 个神经元的排法） ----------------
GO2肌肉名 = [
    "左前髋", "左前大腿", "左前小腿",
    "右前髋", "右前大腿", "右前小腿",
    "左后髋", "左后大腿", "左后小腿",
    "右后髋", "右后大腿", "右后小腿",
]
GO2执行器名 = ["FL_hip", "FL_thigh", "FL_calf", "FR_hip", "FR_thigh", "FR_calf",
               "RL_hip", "RL_thigh", "RL_calf", "RR_hip", "RR_thigh", "RR_calf"]
GO2肌肉数 = len(GO2肌肉名)

# 每块肌肉对应的角度范围（度）。范围都落在 MuJoCo 给的关节限位以内，
# 并且让 home 站姿正好是 0.5 —— 所以 0.5 就是"天生就会站"。
GO2角度范围 = np.array([
    [-60.0, 60.0], [-38.0, 142.0], [-156.0, -50.2],
    [-60.0, 60.0], [-38.0, 142.0], [-156.0, -50.2],
    [-60.0, 60.0], [-30.0, 133.2], [-156.0, -50.2],
    [-60.0, 60.0], [-30.0, 133.2], [-156.0, -50.2],
], dtype=float)

GO2刚度 = 80.0        # PD 的 P：偏离目标角 1 弧度出 80 牛米
GO2阻尼 = 4.0         # PD 的 D
GO2最大力矩 = 25.0    # 关节力矩上限（牛米）
GO2站姿角 = np.array([0.0, 51.6, -103.1] * 4)
GO2趴姿角 = np.array([0.0, 95.0, -156.0] * 4)

GO2模型目录默认 = pathlib.Path(r"C:\mujoco_models\unitree_go2")
GO2网址基 = "https://raw.githubusercontent.com/google-deepmind/mujoco_menagerie/main/unitree_go2/"
GO2下载清单 = ["scene.xml", "go2.xml"] + [
    "assets/" + n for n in (
        "base_0.obj", "base_1.obj", "base_2.obj", "base_3.obj", "base_4.obj",
        "hip_0.obj", "hip_1.obj", "thigh_0.obj", "thigh_1.obj", "thigh_mirror_0.obj",
        "thigh_mirror_1.obj", "calf_0.obj", "calf_1.obj", "calf_mirror_0.obj",
        "calf_mirror_1.obj", "foot.obj")
]


def 找Go2模型(目录="", 允许下载=True):
    """返回 Go2 的 scene.xml。本机没有就在允许时自己下（跟仓库 身体_go2.py 一样）。"""
    根 = pathlib.Path(目录) if 目录 else GO2模型目录默认
    目标 = 根 / "scene.xml"
    if 目标.exists():
        return 目标
    缺 = [f for f in GO2下载清单 if not (根 / f).exists()]
    if not 允许下载:
        raise SystemExit("没找到 Go2 模型（" + str(目标) + "）。要么加 --allow-download 让它自己下，\n"
                         "要么先跑一遍仓库的 model/身体_go2.py（它会从 MuJoCo Menagerie 下全套）。")
    print("第一次用 Go2：从 MuJoCo Menagerie 下载 %d 个文件到 %s" % (len(缺), 根))
    根.mkdir(parents=True, exist_ok=True)
    for f in 缺:
        目标F = 根 / f
        目标F.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(GO2网址基 + f, timeout=120) as r:
            目标F.write_bytes(r.read())
        print("  下载", f)
    return 目标


class Go2身体:
    """宇树 Go2。接口名跟 仿真 那一版一模一样，主循环不用改。"""

    默认每拍步数 = 10          # 0.02 秒一帧 / 0.002 秒一步

    def __init__(self, 路径, 宽=320, 高=240, 开渲染=False, 感光格=8):
        import mujoco
        self.mujoco = mujoco
        self.m = mujoco.MjModel.from_xml_path(str(路径))
        self.d = mujoco.MjData(self.m)
        self.宽, self.高 = 宽, 高
        self.感光格 = max(1, int(感光格) * int(感光格))
        self.渲染器 = None
        if 开渲染 and self.m.ncam > 0:
            self.渲染器 = mujoco.Renderer(self.m, 高, 宽)
        self.相机 = None
        if self.m.ncam:
            self.相机 = mujoco.mj_id2name(self.m, mujoco.mjtObj.mjOBJ_CAMERA, 0)
        self.执行器名 = list(GO2执行器名)
        self.发力 = np.full(GO2肌肉数, 0.5)
        self.站姿 = np.radians(GO2站姿角).copy()
        self._家高 = float(self.m.key_qpos[0][2]) if self.m.nkey else 0.3
        self.复位()

    # ---------- 姿势 ----------
    def _摆(self, 角):
        self.d.qpos[:] = 0.0
        self.d.qpos[2] = self._家高
        self.d.qpos[3] = 1.0
        self.d.qpos[7:] = np.radians(角)
        self.d.qvel[:] = 0.0
        self.mujoco.mj_forward(self.m, self.d)

    def 复位(self):
        self._摆(GO2站姿角)
        self.发力 = np.full(GO2肌肉数, 0.5)

    def 摆成趴姿(self):
        self._摆(GO2趴姿角)

    def 摆姿势(self, 名):
        名 = str(名 or "").strip().lower()
        if 名 in ("prone", "趴", "趴姿", "趴着"):
            self.摆成趴姿()
        else:
            self.复位()

    # ---------- 读数 ----------
    def 躯干(self):
        return np.asarray(self.d.qpos[0:7], dtype=np.float64).copy()

    def 关节偏差(self):
        return np.asarray(self.d.qpos[7:], dtype=np.float64) - self.站姿

    def 关节角速度(self):
        return np.asarray(self.d.qvel[6:], dtype=np.float64).copy()

    def 机身高度(self):
        return float(self.d.qpos[2])

    def 本体感觉编码(self, 每特征=20, 半档=10):
        """和 感觉区_共同.py 一套规则：一个特征 20 个细胞，正半/负半各 10 档，
        值是 v 时点亮 |v| 那一档附近的 3 个细胞。"""
        特征 = np.concatenate([np.clip(self.关节偏差() / 1.0, -1, 1),
                               np.clip(self.关节角速度() / 8.0, -1, 1)])
        if 特征.size < 24:
            特征 = np.concatenate([特征, np.zeros(24 - 特征.size)])
        特征 = 特征[:24]
        出 = np.zeros(24 * 每特征, dtype=np.float32)
        for i in range(24):
            v = float(特征[i])
            if v == 0.0:
                continue
            档 = int(np.clip(round(abs(v) * 半档), 1, 半档))
            偏 = 0 if v > 0 else 半档
            for dd in (-1, 0, 1):
                j = 档 - 1 + dd
                if 0 <= j < 半档:
                    出[i * 每特征 + 偏 + j] = 1.0
        return 出

    def 观察(self, 模式):
        out = []
        if "pro" in 模式:
            out.append(self.本体感觉编码())
        if "qpos" in 模式:
            out.append(self.躯干())
            out.append(np.asarray(self.d.qpos[7:], dtype=np.float64).copy())
        if "qvel" in 模式:
            out.append(np.asarray(self.d.qvel[0:6], dtype=np.float64).copy())
            out.append(self.关节角速度())
        if "cam" in 模式 and self.渲染器 is not None:
            self.渲染器.update_scene(self.d, camera=self.相机)
            img = self.渲染器.render()
            g = img.mean(axis=2)
            h, w = g.shape
            k = max(1, min(16, int(np.sqrt(self.感光格))))
            ys = np.linspace(0, h - 1, k).astype(int)
            xs = np.linspace(0, w - 1, k).astype(int)
            out.append(g[np.ix_(ys, xs)].ravel() / 255.0)
        if "act" in 模式:
            out.append(np.asarray(self.发力, dtype=np.float64).copy())
        if not out:
            return np.zeros(1, dtype=np.float32)
        return np.concatenate(out).astype(np.float32)

    # ---------- 控制 ----------
    def 写控制(self, 值, 折叠=0, 增益=1.0, 偏置=0.0):
        """收到的一串数 -> 12 块肌肉的发力 [0,1]。"""
        v = np.asarray(值, dtype=np.float64).ravel()
        n = GO2肌肉数
        压, 说明 = 折成执行器数(v, n, 折叠)
        if 压 is None:
            压 = np.full(n, 0.5)              # 比执行器还少：缺的补站姿（0.5 = 站着）
            压[:min(n, v.size)] = v[:n]
        self.写控制说明 = 说明
        self.发力 = np.clip(压 * 增益 + 偏置, 0.0, 1.0)

    def 步进(self, 次数):
        if not 次数:
            次数 = self.默认每拍步数
        目标弧 = np.radians(GO2角度范围[:, 0] + self.发力 * (GO2角度范围[:, 1] - GO2角度范围[:, 0]))
        for _ in range(int(次数)):
            角 = np.asarray(self.d.qpos[7:], dtype=np.float64)
            力矩 = GO2刚度 * (目标弧 - 角) - GO2阻尼 * np.asarray(self.d.qvel[6:], dtype=np.float64)
            self.d.ctrl[:] = np.clip(力矩, -GO2最大力矩, GO2最大力矩)
            self.mujoco.mj_step(self.m, self.d)


def 挑身体(指定, xml):
    """按 --body 挑；auto 时看模型自己是谁。"""
    名 = str(指定 or "auto").strip().lower()
    if 名 in ("go2", "四足", "unitree"):
        return "go2"
    if 名 in ("humanoid", "小人", "双足"):
        return "humanoid"
    # auto：Go2 是 12 个腿关节 + 名字带 _hip_joint；小人只有 10 个关节
    try:
        import mujoco
        xml文本 = pathlib.Path(xml).read_text(encoding="utf-8")
        m = mujoco.MjModel.from_xml_string(xml文本)
        nq = int(m.nq) - 7
        有腿关节 = any(("_hip_joint" in (mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_JOINT, i) or ""))
                     for i in range(m.njnt))
        if nq >= 12 and 有腿关节:
            return "go2"
    except Exception:
        pass
    if pathlib.Path(str(xml)).name.lower() in ("go2.xml", "scene.xml"):
        return "go2"
    return "humanoid"


def main(argv=None):
    ap = argparse.ArgumentParser(description="MuJoCo <-> NeuroForge 通用桥")
    ap.add_argument("--xml", default="", help="MuJoCo 模型 XML（不填就试默认路径）")
    ap.add_argument("--body", default="auto", choices=["auto", "humanoid", "go2"],
                    help="身体：auto（默认，按模型自己认）| humanoid（小人，10 个电机）| go2（宇树 Go2 四足，12 块肌肉）")
    ap.add_argument("--reset", default="", help="开场姿势：go2 认 stand（站姿，默认）/ prone（趴姿）")
    ap.add_argument("--go2-dir", default="", help="Go2 模型目录（默认 C:/mujoco_models/unitree_go2）")
    ap.add_argument("--allow-download", action="store_true", help="本机没有 Go2 模型时允许自动下载")
    ap.add_argument("--obs-port", type=int, default=9101, help="观测发往的端口（软件的入通道）")
    ap.add_argument("--act-port", type=int, default=9102, help="控制收自的端口（软件的出通道）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--obs", default="qpos,qvel", help="观测构成：qpos,qvel,pro,cam,act 任意组合（pro = 本体感觉 0/1 码 480 个；Go2 按 12 关节角偏差 + 12 角速度调谐）")
    ap.add_argument("--proprio-cells", type=int, default=0, help="本体感觉那边的信号位数（默认 480 = 24 特征 × 20 细胞）")
    ap.add_argument("--fold", type=int, default=0, help="收到的一串数按每 N 个取平均压成执行器数（0 = 自动）")
    ap.add_argument("--act-gain", type=float, default=None, help="控制量线性映射：乘这个数（不填按身体自动：小人 2 / Go2 1）")
    ap.add_argument("--act-bias", type=float, default=None, help="控制量线性映射：再加这个数（不填按身体自动：小人 -1 / Go2 0）")
    ap.add_argument("--cam", type=int, default=8, help="相机下采样成几乘几（8 = 8x8=64 个数）")
    ap.add_argument("--hz", type=float, default=50.0, help="控制频率")
    ap.add_argument("--steps", type=int, default=0, help="每拍做几次 mj_step（0 = 按身体自动：小人 4 / Go2 10）")
    ap.add_argument("--seconds", type=float, default=0, help="跑多少秒后退出，0 = 一直跑")
    ap.add_argument("--viewer", action="store_true", help="打开 MuJoCo 可视化窗口")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)

    用相机 = "cam" in [s for s in a.obs.split(",") if s]
    if a.body == "go2":
        身体 = "go2"
    elif a.body == "humanoid":
        身体 = "humanoid"
    else:
        身体 = 挑身体("auto", 找XML(a.xml))
    if 身体 == "go2":
        xml = 找Go2模型(a.go2_dir, 允许下载=a.allow_download)
        仿真体 = Go2身体(xml, 开渲染=用相机, 感光格=max(1, a.cam))
    else:
        xml = 找XML(a.xml)
        仿真体 = 仿真(xml, 开渲染=用相机, 感光格=max(1, a.cam))
    仿真体.复位()
    if a.reset:
        try:
            仿真体.摆姿势(a.reset)
        except AttributeError:
            pass
    if not a.steps:
        a.steps = int(getattr(仿真体, "默认每拍步数", 4))
    if a.act_gain is None:
        a.act_gain = 2.0 if 身体 == "humanoid" else 1.0
    if a.act_bias is None:
        a.act_bias = -1.0 if 身体 == "humanoid" else 0.0
    观测量 = 仿真体.观察([s for s in a.obs.split(",") if s])
    print("模型：" + str(xml))
    print("执行器 %d 个：%s" % (仿真体.m.nu, "、".join(仿真体.执行器名)))
    print("观测 %d 维（%s）　控制 %d 维" % (观测量.size, a.obs, 仿真体.m.nu))
    print("观测 -> %s:%d　控制 <- %s:%d" % (a.host, a.obs_port, a.host, a.act_port))
    print("身体：%s　每拍 %d 步　控制量口径：x %.2f %+.2f" % (
        "宇树 Go2（12 块肌肉，发力 0~1 → PD 力矩）" if 身体 == "go2" else "小人（10 个电机，-1~1）",
        a.steps, a.act_gain, a.act_bias))
    if a.proprio_cells and a.proprio_cells != 观测量.size and "pro" in a.obs:
        print("提醒：--proprio-cells %d 跟实际发出的 %d 个数对不上，软件那边的信号位要跟"
              "实际发出去的对齐（pro 固定 24 特征 × 20 细胞 = 480）" % (a.proprio_cells, 观测量.size))

    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    rx.bind((a.host, a.act_port))
    rx.setblocking(False)

    查看器 = None
    if a.viewer:
        import mujoco.viewer
        查看器 = mujoco.viewer.launch_passive(仿真体.m, 仿真体.d)

    周期 = 1.0 / max(1.0, a.hz)
    开跑 = time.time()
    上一拍 = 开跑
    拍数 = 0
    收到 = 0
    已说口径 = False
    坏值 = 0
    发散 = 0
    控制 = np.zeros(仿真体.m.nu, dtype=np.float64)
    try:
        while True:
            now = time.time()
            if a.seconds > 0 and now - 开跑 >= a.seconds:
                break
            # --- 1. 收控制（有多少收多少，用最后一帧） ---
            got = None
            for _ in range(64):
                try:
                    data, _addr = rx.recvfrom(65536)
                except BlockingIOError:
                    break
                if len(data) >= 4:
                    got = np.frombuffer(data, dtype="<f4").astype(np.float64)
            if got is not None:
                if not np.isfinite(got).all():
                    非有限 = int((~np.isfinite(got)).sum())
                    坏值 += 非有限
                    if 坏值 <= 5 or 坏值 % 500 == 0:
                        print("! 收到的控制里有非有限值（NaN/Inf）：这一次 %d 个，累计 %d 个。"
                              "发送端（软件或别的程序）在往外发 NaN —— 已经按 0 处理，不会传进物理。"
                              % (非有限, 坏值))
                    got = np.nan_to_num(got, nan=0.0, posinf=1.0, neginf=0.0)
                控制 = got
                收到 += 1
            # --- 2. 施加控制 + 推进物理 ---
            仿真体.写控制(控制, a.fold, a.act_gain, a.act_bias)
            if 收到 == 1 and not 已说口径:
                已说口径 = True
                说明 = getattr(仿真体, "写控制说明", "")
                print("第一帧控制 %d 个 -> %d 路执行器%s" % (
                    控制.size, 仿真体.m.nu, ("：" + 说明) if 说明 else "（不用折叠）"))
            仿真体.步进(a.steps)
            if 状态坏了(仿真体):
                发散 += 1
                仿真体.复位()
                if a.reset:
                    try:
                        仿真体.摆姿势(a.reset)
                    except AttributeError:
                        pass
                上一拍 = time.time()
                if 发散 <= 5 or 发散 % 100 == 0:
                    print("! 第 %d 拍物理状态发散（NaN/Inf），已经复位（第 %d 次）"
                          "—— 多半是摔得太狠、接触求解炸了。" % (拍数, 发散))
                continue
            # --- 3. 发观测 ---
            obs = 仿真体.观察([s for s in a.obs.split(",") if s])
            tx.sendto(obs.astype("<f4").tobytes(), (a.host, a.obs_port))
            拍数 += 1
            if 查看器 is not None:
                查看器.sync()
                if not 查看器.is_running():
                    break
            if 收到 == 0 and 拍数 == int(a.hz * 2):
                 print("提醒：已经跑了 2 秒还没收到一帧控制——软件那边检查：接口总开关开了吗？"
                       "出通道的地址/端口（%s:%d）对吗？通道打开了吗？" % (a.host, a.act_port))
            if not a.quiet and 拍数 % max(1, int(a.hz * 2)) == 0:
                p = 仿真体.躯干()
                print("第 %d 拍　躯干 (%.2f, %.2f, %.2f)　收到控制 %d 帧" % (拍数, p[0], p[1], p[2], 收到))
            # --- 4. 睡到下一拍 ---
            上一拍 += 周期
            睡 = 上一拍 - time.time()
            if 睡 > 0:
                time.sleep(睡)
            else:
                上一拍 = time.time()
    except KeyboardInterrupt:
        pass
    finally:
        tx.close()
        rx.close()
        if 查看器 is not None:
            try:
                查看器.close()
            except Exception:
                pass
    末 = 仿真体.躯干()
    print("结束：跑了 %d 拍，收到控制 %d 帧，躯干停在 (%.2f, %.2f, %.2f)"
          % (拍数, 收到, 末[0], 末[1], 末[2]))
    if 发散:
        print("这一轮物理发散过 %d 次（NaN/Inf），都已经自动复位。" % 发散)
    if 坏值:
        print("这一轮收到过 %d 个非有限控制值（发送端在发 NaN），都按 0 处理了。" % 坏值)
    if 身体 == "go2":
        发力 = np.asarray(getattr(仿真体, "发力", np.zeros(12)), dtype=float)
        print("最后的发力（12 块肌肉 0~1）：%s" % np.round(发力, 3).tolist())
        每块 = np.abs(np.asarray(仿真体.关节偏差(), dtype=float))
        print("关节偏差（弧度，绝对值均值 %.3f）：%s" % (float(每块.mean()), np.round(每块, 3).tolist()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
