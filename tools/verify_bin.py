# -*- coding: utf-8 -*-
"""model.bin 编译路径的端到端验算。

验证链条：
  JS 编译产物（hand_built_net.py + model.bin）
    → 按文件末尾写明的布局把 model.bin 拆开（每一种字段都校验长度）
    → 把权重块展开成显式连接，得到一张普通的边列表
    → 用「按节点递归求值」这个跟生成代码完全不同的算法算参考输出
    → 真正 import 生成的模块跑 forward，逐点比对

用法：py -3 tools/verify_bin.py <生成的 .py> <model.bin>
"""
import ast, importlib.util, json, math, os, re, shutil, sys, tempfile
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

ACTS = [
    lambda t: t,                                     # 0 linear
    lambda t: t if t > 0 else 0.0,                   # 1 relu
    lambda t: t if t > 0 else 0.01 * t,              # 2 leaky_relu
    lambda t: 1 / (1 + math.exp(-t)),                # 3 sigmoid
    math.tanh,                                       # 4 tanh
    lambda t: 0.5 * t * (1 + math.erf(t / math.sqrt(2))),  # 5 gelu（与 torch 默认的 erf 版一致）
    lambda t: t if t > 0 else math.exp(t) - 1,       # 6 elu
    lambda t: t / (1 + math.exp(-t)),                # 7 silu
]

ok_all = True

def fail(msg):
    global ok_all
    ok_all = False
    print("  FAIL " + msg)

def check(cond, msg):
    if cond:
        print("  ok   " + msg)
    else:
        fail(msg)
    return cond

def tensor_list(src, name):
    m = re.search(r'register_buffer\("%s", torch\.tensor\(\[([\s\S]*?)\], dtype=torch\.long\)\)' % name, src)
    if not m:
        return None
    return [int(v) for v in ast.literal_eval('[' + m.group(1) + ']')]

def json_list(src, name):
    m = re.search(r'self\.%s = (\[[^\]]*\])' % name, src)
    if not m:
        return None
    return json.loads(m.group(1))

def scalar(src, name):
    m = re.search(r'self\.%s = (\d+)' % name, src)
    return int(m.group(1)) if m else None

def run_case(label, py_path, bin_path):
    print("=" * 68)
    print(label)
    print("=" * 68)
    src = open(py_path, encoding="utf-8").read()
    N = scalar(src, "num_neurons"); E = scalar(src, "num_edges")
    waves = scalar(src, "num_waves"); inner = scalar(src, "num_inner")
    BW = scalar(src, "num_block_weights") or 0
    input_nodes = tensor_list(src, "input_nodes")
    output_nodes = tensor_list(src, "output_nodes")
    nptr = json_list(src, "nptr"); ptr = json_list(src, "ptr"); bptr = json_list(src, "bptr")
    bk = json_list(src, "bk") or []
    bn = json_list(src, "bn") or []
    bwoff = json_list(src, "bwoff") or []
    bsptr = json_list(src, "bsptr") or []
    bdptr = json_list(src, "bdptr") or []
    nb = len(bk)
    print("规模: N=%d E=%d 波次=%d 块=%d 块权重=%d" % (N, E, waves, nb, BW))

    raw = np.fromfile(bin_path, dtype="<f4")
    idx = np.fromfile(bin_path, dtype="<i4")
    if not check(raw.size >= E + N + BW + 2 * E + inner + N,
                 "model.bin 至少能装下声明的结构（实际 %d 个 float32）" % raw.size):
        return
    w = raw[:E]
    bias = raw[E:E + N]
    bw = raw[E + N:E + N + BW]
    o = E + N + BW
    src_e = idx[o:o + E]
    dst_e = idx[o + E:o + 2 * E]
    p = o + 2 * E
    node_order = idx[p:p + inner]; p += inner
    act_code = idx[p:p + N]; p += N
    R = sum(bk); C = sum(bn)
    bsrc = idx[p:p + R]; p += R
    bdst = idx[p:p + C]; p += C
    has_op = 'self.op_ptr' in src
    has_frozen = re.search(r'register_buffer\("blk_frozen"', src) is not None
    has_w_frozen = re.search(r'register_buffer\("w_frozen"', src) is not None
    has_b_frozen = re.search(r'register_buffer\("b_frozen"', src) is not None
    frozen = idx[p:p + BW] if has_frozen else None
    p += BW if has_frozen else 0
    base_want = E + N + BW + 2 * E + inner + N + R + C + (BW if has_frozen else 0)
    check(raw.size >= base_want, "model.bin 至少装得下声明的结构（%d / %d 个 32 位字）" % (raw.size, base_want))

    # 顺序与区间闭合
    check(nptr is None or (nptr[0] == 0 and nptr[-1] == inner), "nptr 区间闭合")
    check(ptr[0] == 0 and ptr[-1] == E, "ptr 区间闭合")
    check(bptr[0] == 0, "bptr 从 0 开始")
    if nb:
        check(len(bwoff) == nb + 1 and bwoff[-1] == BW, "bwoff 与块权重总数一致")
        check(len(bsptr) == nb + 1 and bsptr[-1] == R, "bsptr 与块行总数一致")
        check(len(bdptr) == nb + 1 and bdptr[-1] == C, "bdptr 与块列总数一致")
    else:
        check(not bwoff and not bsptr and not bdptr and not bk, "没有块时不写块的元数据")

    # 把块展开成显式连接：参考实现只看这张表，跟生成代码的 matmul 路径完全无关
    edges = [(int(s), int(d), float(v)) for s, d, v in zip(src_e, dst_e, w)]
    for bi in range(nb):
        k, n = bk[bi], bn[bi]
        rows = bsrc[bsptr[bi]:bsptr[bi + 1]]
        cols = bdst[bdptr[bi]:bdptr[bi + 1]]
        W = bw[bwoff[bi]:bwoff[bi + 1]].reshape(k, n)
        for r in range(k):
            for c in range(n):
                val = float(W[r, c])
                if val != 0.0:
                    edges.append((int(rows[r]), int(cols[c]), val))
    print("展开后的连接数: %d（含块的贡献）" % len(edges))

    incoming = {}
    for (s, d, v) in edges:
        incoming.setdefault(d, []).append((s, v))

    def forward_ref(x):
        memo = {}

        def val(i):
            if i in memo:
                return memo[i]
            if i in input_nodes:
                r = float(x[input_nodes.index(i)])
            else:
                s = float(bias[i])
                for (a, ww) in incoming.get(i, ()):
                    s += ww * val(a)
                r = ACTS[int(act_code[i])](s)
            memo[i] = r
            return r

        return [val(i) for i in output_nodes]

    # 真正跑生成的模块
    import torch
    tmp = tempfile.mkdtemp(prefix="nforge_bin_")
    shutil.copy(py_path, os.path.join(tmp, "hand_built_net.py"))
    shutil.copy(bin_path, os.path.join(tmp, "model.bin"))
    spec = importlib.util.spec_from_file_location("hbn_" + str(abs(hash(tmp)) % 99999),
                                                 os.path.join(tmp, "hand_built_net.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    net = mod.HandBuiltNet()
    net.eval()
    check(int(net.weight.shape[0]) == E, "模块读到的连接数与源码声明一致")
    check(int(net.bias.shape[0]) == N, "模块读到的神经元数与源码声明一致")
    if BW:
        check(int(net.bw.numel()) == BW, "模块读到的块权重数与源码声明一致")
    else:
        check(not hasattr(net, "bw"), "没有块时不生成 bw 参数")
    check(hasattr(net, "blk_frozen") == has_frozen, "块冻结掩码的有无与源码一致")
    check(hasattr(net, "w_frozen") == has_w_frozen, "w_frozen 的有无与源码一致")
    check(hasattr(net, "b_frozen") == has_b_frozen, "b_frozen 的有无与源码一致")
    # ---- 段末那几段：算子整型参数 / 回边 / 可塑性表 / 冻结清单 ----
    # 冻结清单排在最末，长度由「挑少数那一方存下标」这条规则唯一决定，可以从文件末尾倒着算；
    # 可塑性表长 1 + 3P（P 是模块自己声明的条数）。算子那一段的长短没写在模块里，
    # 所以只有「没有算子」时才做严格的长度闭合。
    def _fz_len(mask):
        if mask is None:
            return 0
        n = int(mask.numel()); nf = int(mask.sum())
        if nf == 0:
            return 2                      # 一个都没冻结：[kind=0, count=0]
        return 2 + (nf if nf <= n - nf else n - nf)
    tail = 0
    if hasattr(net, "num_plastic"):
        P = int(net.num_plastic)
        tail += 1 + 3 * P
        check(int(net.plast_ix.numel()) == P and int(net.plast_prof.numel()) == P and
              int(net.plast_dt.numel()) == P, "可塑性表：三个字段都等于声明的 %d 条" % P)
        if P:
            pix = net.plast_ix.numpy()
            check(int(pix.min()) >= 0 and int(pix.max()) < E, "可塑性表里的下标都落在 [0, E) 内")
            check(np.array_equal(net.plast_src.numpy(), src_e[pix]) and
                  np.array_equal(net.plast_dst.numpy(), dst_e[pix]),
                  "plast_src / plast_dst 与 plast_ix 指向的连接对得上")
    if hasattr(net, "rsrc"):
        RQ = int(net.num_rec_edges)
        tail += 2 * RQ
        check(int(net.rsrc.numel()) == RQ and int(net.rdst.numel()) == RQ, "回边表长短与声明的条数一致")
    # 冻结清单两段**总是**写着（一个都没冻结时各是一个 [0, 0] 的头），有掩码的再补下标
    tail += 2 + (max(0, _fz_len(net.w_frozen) - 2) if has_w_frozen else 0)
    tail += 2 + (max(0, _fz_len(net.b_frozen) - 2) if has_b_frozen else 0)
    if has_op:
        check(raw.size >= base_want + tail, "model.bin 装得下段末那几段（有算子，不做严格闭合）")
    else:
        check(raw.size == base_want + tail, "model.bin 逐段闭合（%d / %d 个 32 位字）" % (raw.size, base_want + tail))

    import random
    random.seed(20240911)
    worst = 0.0
    with torch.no_grad():
        for _ in range(12):
            x = [random.uniform(-1.5, 1.5) for _ in input_nodes]
            y = net(torch.tensor([x], dtype=torch.float32))[0].tolist()
            ref = forward_ref(x)
            for u, v in zip(y, ref):
                worst = max(worst, abs(u - v))
    check(worst < 1e-5, "12 组随机输入，最大偏差 %.3e" % worst)

    # 冻结掩码的语义：blk_frozen 为 1 的位置梯度必须是 0
    if has_frozen and BW:
        net.zero_grad()
        with torch.no_grad():
            net.bw.grad = None
        x = torch.zeros(1, len(input_nodes), dtype=torch.float32)
        net(x).sum().backward()
        g = net.bw.grad
        fz = frozen.astype(bool)
        leak = float(np.abs(g.numpy()[fz]).max()) if fz.any() else 0.0
        check(leak == 0.0, "冻结的块权重梯度被完全屏蔽（最大泄漏 %.3e）" % leak)
    return True

def main():
    if len(sys.argv) >= 3:
        run_case("model.bin 编译路径", sys.argv[1], sys.argv[2])
    else:
        d = sys.argv[1] if len(sys.argv) == 2 else "_dump"
        for tag in ("b1", "b2"):
            py = os.path.join(d, tag + "_net.py")
            bi = os.path.join(d, tag + "_model.bin")
            if os.path.exists(py) and os.path.exists(bi):
                run_case("model.bin 编译路径 — " + tag, py, bi)
            else:
                print("跳过 " + tag + "：找不到 " + py)
    print()
    print("结论:", "PASS" if ok_all else "FAIL")
    sys.exit(0 if ok_all else 1)

main()
