# -*- coding: utf-8 -*-
'''工程文件格式的兼容性验算（浏览器端有一份同源的 make_compatcheck.mjs）。

验三件事：
  1. 历史上各种形态的 .nforge（文件头键集合互相不同）现在都还能读；
  2. 将来加功能的样子——文件头多一个没见过的键、文件末尾多一段没见过的分区、
     version 涨了但声明了 layout 没变——现在也能读。这是「升级软件不会丢旧工程」
     这句话的根据，不是口头保证；
  3. 真读不了的（字节布局真的变了）要给一句能看懂的话，而不是笼统的「认不出的版本」。

用法：py -3 tools/verify_compat.py
'''
import glob, json, os, struct, sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import nforge as N

sys.stdout.reconfigure(encoding='utf-8')

ok_all = True


def fail(msg):
    global ok_all
    ok_all = False
    print('  FAIL ' + msg)


def check(cond, msg):
    if cond:
        print('  ok   ' + msg)
    else:
        fail(msg)


def head_of(path):
    with open(path, 'rb') as f:
        head = f.read(N.HEAD_OFF)
        hlen = struct.unpack('<I', head[8:12])[0]
        return json.loads(f.read(hlen).decode('utf-8'))


def rewrite_head(raw, fn, tail=b''):
    '''换掉文件头 JSON（长度随便变），后面接着原样字节。offset 全是相对的，所以这样是安全的。'''
    hlen = struct.unpack('<I', raw[8:12])[0]
    head = json.loads(raw[16:16 + hlen].decode('utf-8'))
    fn(head)
    blob = json.dumps(head, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return raw[:8] + struct.pack('<I', len(blob)) + raw[12:16] + blob + raw[16 + hlen:] + tail


def snapshot(path):
    '''读回来一个能直接比的东西：神经元位置 + 边。'''
    header, neurons, edges, blk = N.read(path)
    return {
        'n': len(neurons), 'e': len(edges),
        'pos': np.asarray(neurons.pos, dtype=np.float32).copy(),
        'src': np.asarray(edges.src).copy(), 'dst': np.asarray(edges.dst).copy(),
        'w': np.asarray(edges.w, dtype=np.float32).copy(),
        'chunkKeys': sorted(header.keys()),
    }


def same(a, b):
    if a['n'] != b['n'] or a['e'] != b['e']:
        return '神经元/边数不同 %d/%d vs %d/%d' % (a['n'], a['e'], b['n'], b['e'])
    if not np.array_equal(a['pos'], b['pos']):
        return '位置不同'
    if not np.array_equal(a['src'], b['src']) or not np.array_equal(a['dst'], b['dst']):
        return '连边不同'
    if not np.array_equal(a['w'], b['w']):
        return '权重不同'
    return None


# ---------------------------------------------------------------- 1) 历史样本
print('== 1) 历史样本：文件头长得就不一样，但都得能读 ==')
samples = sorted(glob.glob(os.path.join(ROOT, 'prototype', '*.nforge'))) + \
          sorted(glob.glob(os.path.join(ROOT, '_dump', '*.nforge')))
shapes = {}
bad = []
for p in samples:
    try:
        r = N.StreamReader(p)
    except Exception as e:
        bad.append(os.path.basename(p) + ' -> ' + str(e))
        continue
    shapes.setdefault(','.join(sorted(r.header.keys())), []).append(os.path.basename(p))
check(len(samples) >= 9, '找到 %d 个历史样本' % len(samples))
check(not bad, '全部能读（%d 个）' % (len(samples) - len(bad)))
for b in bad:
    print('      ' + b)
check(len(shapes) >= 4, '历史样本的文件头有 %d 种互不相同的键集合（就是靠「多一个可选键」长出来的）' % len(shapes))
fewest = min(shapes.items(), key=lambda kv: len(kv[0].split(',')))
most = max(shapes.items(), key=lambda kv: len(kv[0].split(',')))
check(len(fewest[1]) > 0 and len(most[1]) > 0,
      '字段最少的是 %s（%d 个键）· 最多的是 %s（%d 个键），两个都能读'
      % (fewest[1][0], len(fewest[0].split(',')), most[1][0], len(most[0].split(','))))

# ---------------------------------------------------- 2) 版本判据（纯函数）
print()
print('== 2) 版本判据（Python 和浏览器两边必须是同一套） ==')


def hdr(ver=3, fmt='neuroforge-project', layout=None, drop=()):
    d = {'format': fmt, 'version': ver, 'counts': {'neurons': 0, 'edges': 0}}
    if layout is not None:
        d['layout'] = layout
    for k in drop:
        d.pop(k, None)
    return d


cases = [
    ('v3 原样', hdr(), True, None),
    ('v3 + 没见过的键', dict(hdr(), xFutureThing={'note': '将来加的'}), True, None),
    ('v4 但声明 layout=3', hdr(ver=4, layout=3), True, None),
    ('v4 没说布局', hdr(ver=4), False, 'v4'),
    ('v2 老布局', hdr(ver=2), False, 'v2'),
    ('format 不对', hdr(fmt='other-thing'), False, 'format'),
    ('没写 version', hdr(drop=('version',)), False, '版本号'),
]
for name, h, want_ok, want_in in cases:
    e = N.header_error(h)
    got_ok = e is None
    if got_ok != want_ok:
        fail('%s：期望%s，实际给的是 %s' % (name, '能读' if want_ok else '拒绝', e))
    elif want_in and want_in not in e:
        fail('%s：拒绝的文案里没说清是 %s：%s' % (name, want_in, e))
    else:
        check(True, '%s -> %s' % (name, '能读' if got_ok else e[:52] + '...'))

# ------------------------------------------------- 3) 真文件：改头 / 加尾巴
print()
print('== 3) 真文件：将来的扩展长什么样都试一遍 ==')
out_dir = os.path.join(ROOT, '_dump')
os.makedirs(out_dir, exist_ok=True)
made = []


def made_path(tag):
    p = os.path.join(out_dir, '_compat_' + tag + '.nforge')
    made.append(p)
    return p


try:
    # 造一份小工程：24 神经元 / 若干边 / 8 个一块地分块存
    n = 24
    pos = np.zeros((n, 3), dtype=np.float32)
    io = np.zeros(n, dtype=np.uint8)
    thr = np.full(n, 0.5, dtype=np.float32)
    act = np.zeros(n, dtype=np.uint8)
    for i in range(n):
        pos[i] = (i % 8) * 3.0, (i // 8) * 5.0, 0.0
    io[0:8] = 1
    io[16:24] = 2
    act[8:16] = 1
    src, dst, w = [], [], []
    for a in range(n):
        for b in range(n):
            if b // 8 == a // 8 + 1 and (a + b) % 3 != 0:
                src.append(a); dst.append(b); w.append((a - b) / 8.0)
    neu = N.Neurons(pos=pos, io=io, thr=thr, act=act)
    edg = N.Edges(src=np.array(src, dtype=np.uint32), dst=np.array(dst, dtype=np.uint32),
                  w=np.array(w, dtype=np.float32))
    base = made_path('v3')
    N.write(base, neu, edg, name='兼容性自检', chunk_neurons=8)
    ref = snapshot(base)
    check(ref['n'] == n and ref['e'] == len(src), '造出一份 v3 工程：%d 神经元 / %d 连接' % (ref['n'], ref['e']))

    raw = open(base, 'rb').read()

    # 3a. 文件头多一个没见过的键
    p = made_path('extrakey')
    open(p, 'wb').write(rewrite_head(raw, lambda h: h.update(xFutureThing={'note': '将来加的键'})))
    d = same(ref, snapshot(p))
    check(d is None, '文件头多一个没见过的键，读回来一模一样' + ('' if d is None else '（' + d + '）'))

    # 3b. 末尾多一段没见过的分区
    junk = bytes(((i * 37) & 255) for i in range(8192))
    p = made_path('tail')
    open(p, 'wb').write(rewrite_head(raw, lambda h: h.update(fz={'count': 0, 'len': 8192}), tail=junk))
    d = same(ref, snapshot(p))
    check(d is None, '文件末尾多一段没见过的分区（8 KB），照样读得一模一样' + ('' if d is None else '（' + d + '）'))

    # 3c. version 涨了但布局没变
    p = made_path('v4layout3')
    open(p, 'wb').write(rewrite_head(raw, lambda h: h.update(version=4, layout=3)))
    d = same(ref, snapshot(p))
    check(d is None, '声明 layout=3 的 v4 文件：敢读，而且读出来跟 v3 一致' + ('' if d is None else '（' + d + '）'))

    # 3d. 真读不了的要说人话
    p = made_path('v4nolayout')
    open(p, 'wb').write(rewrite_head(raw, lambda h: h.update(version=4) or h.pop('layout', None)))
    try:
        N.read(p)
        fail('v4 没说布局竟然读下去了')
    except ValueError as e:
        check('v4' in str(e), 'v4 没说布局 -> 拒绝，并且点明是 v4：' + str(e)[:60] + '...')

    # 3e. 整个文件一个字节都没动过时，读 header 不该多读盘
    r = N.StreamReader(base)
    check(r.read_bytes == N.HEAD_OFF + r.head_len, '打开工程只读了文件头 %d 字节（不是整个文件）' % r.read_bytes)
finally:
    for p in made:
        try:
            os.unlink(p)
        except OSError:
            pass

print()
print('结论:', 'PASS' if ok_all else 'FAIL')
sys.exit(0 if ok_all else 1)
