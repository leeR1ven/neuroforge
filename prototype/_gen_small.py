# -*- coding: utf-8 -*-
# 由 NeuroForge 神经元搭建器 v0.1 生成
# 工程: 未命名工程
# 生成时间: 2026/9/11 16:49:12
#
# 图规模: 神经元 22 / 连接 94 / 参数 116 / 拓扑波次 5
# 结构说明: 任意有向无环图 (DAG)。forward() 按拓扑波次逐层求值，
#           同一波次内的神经元并行计算，因此深层结构也能一次前向完成。
# 训练说明: weight / bias 均为 nn.Parameter，可直接继续训练或微调。

import os
import torch
import torch.nn as nn
import torch.nn.functional as F

# 激活函数表，索引与编辑器中的枚举一一对应
ACTS = [
    lambda t: t,                       # 0 linear
    torch.relu,                        # 1 relu
    lambda t: F.leaky_relu(t, 0.01),   # 2 leaky_relu
    torch.sigmoid,                     # 3 sigmoid
    torch.tanh,                        # 4 tanh
    F.gelu,                            # 5 gelu
    F.elu,                             # 6 elu
    F.silu,                            # 7 silu
]


class HandBuiltNet(nn.Module):
    """完全由可视化编辑器手工搭建的网络。"""

    def __init__(self):
        super().__init__()
        self.num_neurons = 22
        self.num_edges = 94
        self.num_waves = 5
        self.num_inputs = 3
        self.num_outputs = 2
        self.num_inner = 19

        # ---- 结构元数据（不参与训练）----
        self.register_buffer("input_nodes", torch.tensor([
            0, 1, 2
        ], dtype=torch.long))
        self.register_buffer("output_nodes", torch.tensor([
            20, 21
        ], dtype=torch.long))
        self.register_buffer("src", torch.tensor([
            0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3,
            4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7,
            8, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11, 12, 12, 12,
            12, 12, 13, 13, 13, 13, 13, 14, 14, 14, 14, 14, 15, 15, 16, 16, 17, 17, 18, 18, 19, 19
        ], dtype=torch.long))
        self.register_buffer("dst", torch.tensor([
            3, 4, 5, 6, 7, 8, 3, 4, 5, 6, 7, 8, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
            9, 10, 11, 12, 13, 14, 9, 10, 11, 12, 13, 14, 9, 10, 11, 12, 13, 14, 9, 10, 11, 12, 13, 14,
            9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 15, 16, 17, 18, 19, 15, 16, 17, 18, 19, 15, 16, 17,
            18, 19, 15, 16, 17, 18, 19, 15, 16, 17, 18, 19, 20, 21, 20, 21, 20, 21, 20, 21, 20, 21
        ], dtype=torch.long))
        self.register_buffer("node_order", torch.tensor([
            3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21
        ], dtype=torch.long))
        self.register_buffer("act_code", torch.tensor([
            1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
        ], dtype=torch.long))

        # 每一波次使用的区间: 节点 [nptr[k], nptr[k+1]) / 连接 [ptr[k], ptr[k+1])
        self.nptr = [0,0,6,12,17,19]
        self.ptr = [0,0,18,54,84,94]

        # ---- 可训练参数 ----
        self.weight = nn.Parameter(torch.tensor([
            0.32964539527893066, -0.8411529064178467, -1.0510532855987549, 0.2979218065738678, 0.20196779072284698, 0.518286943435669, 0.11358904093503952, -0.6539852619171143, -0.553758978843689, -0.16055388748645782, -0.5192978978157043, 0.9155076146125793, 1.0686780214309692, 0.3800462484359741, -1.087697982788086, -0.07363858819007874,
            -0.026705415919423103, -0.07690028101205826, 0.5599438548088074, -0.1018223986029625, 0.2649977505207062, 0.6881933808326721, 0.26230353116989136, -0.5036742687225342, 0.5243326425552368, -0.5382642149925232, -0.22022570669651031, -0.7591871023178101, 0.13563606142997742, -0.14356856048107147, 0.514525830745697, 0.6145395636558533,
            -0.25560638308525085, -0.7081097960472107, -0.25105178356170654, 0.6984368562698364, 0.033853016793727875, 0.11147304624319077, 0.05038761347532272, -0.027028951793909073, 0.513510525226593, -0.010491614229977131, 0.2854929566383362, -0.13224828243255615, 0.7755059003829956, -0.3164404332637787, 0.36183133721351624, -0.414537250995636,
            -0.7017413377761841, -0.1560366153717041, -0.5434120893478394, 0.5628270506858826, -0.7733950614929199, -0.6843721270561218, 0.4582144021987915, -0.6050310134887695, -0.08133897930383682, -0.0018048164201900363, -0.39482957124710083, 0.08036644756793976, -0.022220782935619354, 0.44835951924324036, -0.3552105724811554, -0.7357552647590637,
            0.6435555815696716, -0.4204476773738861, -0.10075485706329346, -0.616570770740509, 0.35502585768699646, -0.37616950273513794, -0.7653638124465942, -0.4878503382205963, -0.3887924253940582, -0.5400179624557495, 0.2253924161195755, -0.5799805521965027, -0.03892113268375397, -0.7247738242149353, 0.09135758131742477, -0.0044319224543869495,
            -0.04095485061407089, 0.6834768652915955, -0.6383021473884583, 0.6413212418556213, 0.6768092513084412, 0.8468509316444397, 0.7192372679710388, -0.7796418070793152, 0.7672783732414246, 0.7267897129058838, -0.17433950304985046, -0.5321609377861023, -0.20533454418182373, -0.11458442360162735
        ], dtype=torch.float32))
        self.bias = nn.Parameter(torch.tensor([
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0
        ], dtype=torch.float32))


    def apply_freeze(self):
        """把编辑器里标记为冻结的权重屏蔽掉梯度。"""
        if hasattr(self, "w_frozen"):
            self.weight.register_hook(lambda g: g * (~self.w_frozen).to(g.dtype))
        if hasattr(self, "b_frozen"):
            self.bias.register_hook(lambda g: g * (~self.b_frozen).to(g.dtype))

    def forward(self, x):
        """x: (B, 3) -> (B, 2)"""
        b = x.size(0)
        # 所有神经元先取自己的偏置
        h = self.bias.unsqueeze(0).expand(b, -1).clone()
        # 把外部输入写入输入神经元
        h = torch.scatter(h, 1, self.input_nodes.unsqueeze(0).expand(b, -1), x)

        # 按拓扑波次逐层求值
        for k in range(self.num_waves):
            na, nb = self.nptr[k], self.nptr[k + 1]
            if nb <= na:
                continue
            idx = self.node_order[na:nb]
            pre = h.index_select(1, idx)

            ea, eb = self.ptr[k], self.ptr[k + 1]
            if eb > ea:
                contrib = h.index_select(1, self.src[ea:eb]) * self.weight[ea:eb]
                delta = torch.index_add(torch.zeros_like(h), 1, self.dst[ea:eb], contrib)
                pre = pre + delta.index_select(1, idx)

            code = self.act_code.index_select(0, idx)
            out = pre
            for aid in range(len(ACTS)):
                m = (code == aid)
                if bool(m.any()):
                    out = torch.where(m.unsqueeze(0), ACTS[aid](pre), out)

            h = torch.scatter(h, 1, idx.unsqueeze(0).expand(b, -1), out)

        return h.index_select(1, self.output_nodes)


if __name__ == "__main__":
    torch.manual_seed(0)
    net = HandBuiltNet()
    print("神经元:", net.num_neurons, " 连接:", net.num_edges, " 波次:", net.num_waves)
    print("参数量:", sum(p.numel() for p in net.parameters()))
    y = net(torch.randn(4, net.num_inputs))
    print("输出张量:", tuple(y.shape))
    print("输出样本:", y[0].tolist())
