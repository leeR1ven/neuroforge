# -*- coding: utf-8 -*-
"""独立交叉验证：把生成代码里的 IR 抽出来，用两种算法算同一个图，
   比较输出是否一致。用于证明"按拓扑波次求值"的下标运算是正确的。"""
import ast, math, random, re, sys

path = sys.argv[1] if len(sys.argv) > 1 else 'prototype/_gen_small.py'
src = open(path, encoding='utf-8').read()

def grab_list(pattern, text):
    m = re.search(pattern, text, re.S)
    if not m:
        raise SystemExit('无法从生成代码中提取: ' + pattern)
    return ast.literal_eval('[' + m.group(1) + ']')

num_waves = int(re.search(r'self\.num_waves = (\d+)', src).group(1))
nptr = ast.literal_eval(re.search(r'self\.nptr = (\[[^\]]*\])', src).group(1))
ptr = ast.literal_eval(re.search(r'self\.ptr = (\[[^\]]*\])', src).group(1))
buf = lambda name: grab_list(r'register_buffer\("%s", torch\.tensor\(\[([\s\S]*?)\], dtype=torch\.long\)\)' % name, src)
input_nodes, output_nodes = buf('input_nodes'), buf('output_nodes')
src_idx, dst_idx, node_order = buf('src'), buf('dst'), buf('node_order')
act_code = buf('act_code')
weight = grab_list(r'self\.weight = nn\.Parameter\(torch\.tensor\(\[([\s\S]*?)\], dtype=torch\.float32\)\)', src)
bias = grab_list(r'self\.bias = nn\.Parameter\(torch\.tensor\(\[([\s\S]*?)\], dtype=torch\.float32\)\)', src)

N, E = len(bias), len(weight)
print('图规模: N=%d E=%d waves=%d in=%d out=%d' % (N, E, num_waves, len(input_nodes), len(output_nodes)))
assert len(src_idx) == E and len(dst_idx) == E, 'src/dst 长度与权重不一致'
assert nptr[0] == 0 and nptr[-1] == len(node_order), 'nptr 区间不闭合'
assert ptr[0] == 0 and ptr[-1] == E, 'ptr 区间不闭合'

ACTS = [lambda t: t, lambda t: t if t > 0 else 0.0, lambda t: t if t > 0 else 0.01 * t,
        lambda t: 1 / (1 + math.exp(-t)), math.tanh, lambda t: t, lambda t: t if t > 0 else math.exp(t) - 1,
        lambda t: t / (1 + math.exp(-t))]

def forward_waves(x):
    """完全照搬生成代码 forward() 的算法"""
    h = list(bias)
    for i, v in zip(input_nodes, x):
        h[i] = v
    for k in range(num_waves):
        na, nb = nptr[k], nptr[k + 1]
        if nb <= na:
            continue
        idx = node_order[na:nb]
        pre = [h[i] for i in idx]
        ea, eb = ptr[k], ptr[k + 1]
        if eb > ea:
            delta = [0.0] * N
            for j in range(ea, eb):
                delta[dst_idx[j]] += h[src_idx[j]] * weight[j]
            pre = [pre[t] + delta[idx[t]] for t in range(len(idx))]
        code = [act_code[i] for i in idx]
        out = [ACTS[code[t]](pre[t]) for t in range(len(idx))]
        for t, i in enumerate(idx):
            h[i] = out[t]
    return [h[i] for i in output_nodes]

incoming = {}
for j in range(E):
    incoming.setdefault(dst_idx[j], []).append(j)

def forward_reference(x):
    """参考实现：按定义递归求值（DAG 记忆化），与波次划分无关"""
    memo = {}
    def val(i):
        if i in memo:
            return memo[i]
        if i in input_nodes:
            r = x[input_nodes.index(i)]
        else:
            s = bias[i]
            for j in incoming.get(i, ()):
                s += weight[j] * val(src_idx[j])
            r = ACTS[act_code[i]](s)
        memo[i] = r
        return r
    return [val(i) for i in output_nodes]

random.seed(12345)
worst = 0.0
for trial in range(30):
    x = [random.uniform(-2, 2) for _ in input_nodes]
    a, b = forward_waves(x), forward_reference(x)
    for u, v in zip(a, b):
        worst = max(worst, abs(u - v))
print('30 组随机输入，两种实现的最大输出偏差: %.3e' % worst)
print('结论:', 'PASS — 波次求值与逐节点求值完全等价' if worst < 1e-9 else 'FAIL — 存在不一致')
sys.exit(0 if worst < 1e-9 else 1)
