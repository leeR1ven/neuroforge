# -*- coding: utf-8 -*-
"""B11 / B12 回归：生成的训练骨架必须能真的把分类任务跑通。

B11 —— 整数类别标签：
    load_dataset 以前把任何 Y 都 astype(float32)。分类标签 [0, 1, 2] 被转成
    [0.0, 1.0, 2.0] 之后就不再是"第几类"，而是一串软标签，CrossEntropyLoss
    直接对这种目标报错；就算蒙混过去，损失和梯度也是错的。
    现在只有浮点目标转 float32，整数目标原样留给 CE（在 prepare_batch 里转 long）。

B12 —— 序列的类别轴：
    循环网的输出是 (样本数, 时间步, 类别数)，类别在最后一维；而
    CrossEntropyLoss 把第 1 维当类别维。整数标签不转轴会因形状不符直接报错；
    软标签不转轴**不报错**——它会沿着"时间"做 softmax，损失和梯度都是错的。

Run: py -3 -B -X utf8 tools/verify_train_ce.py
夹具由 tools/gen_train_ce_fixture.mjs 用生产代码生成器现造，落在临时目录，跑完即删。
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parent.parent
OUT: list[str] = []


def log(ok, name, detail=""):
    OUT.append(("PASS" if ok else "FAIL") + " | " + name + (" | " + detail if detail else ""))
    if not ok:
        print(OUT[-1])


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def quiet(fn, *a, **kw):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        out = fn(*a, **kw)
    return out, buf.getvalue()


def make_npz(dirpath, name, X, Y):
    p = Path(dirpath) / name
    np.savez(p, X=X, Y=Y)
    return str(p)


def raises(fn, needle):
    """跑 fn：必须抛 ValueError，且消息里带 needle。返回 (是否命中, 消息)。"""
    try:
        fn()
    except ValueError as e:
        return (needle in str(e)), str(e)
    except Exception as e:                      # noqa: BLE001
        return False, "抛的是 %s: %s" % (type(e).__name__, e)
    return False, "没报错"


def losses_of(text):
    return [float(x) for x in re.findall(r"loss=([0-9.eE+-]+)", text)]


def main():
    tmp = Path(tempfile.mkdtemp(prefix="nf_train_ce_"))
    try:
        gen = subprocess.run(["node", str(ROOT / "tools" / "gen_train_ce_fixture.mjs"), str(tmp)],
                             capture_output=True, text=True, cwd=str(ROOT))
        if gen.returncode != 0:
            print("夹具生成失败：\n" + gen.stdout + gen.stderr)
            return 1
        feed = load_module(tmp / "feed_ce" / "hand_built_net.py", "nf_feed_ce")
        rec = load_module(tmp / "rec_ce" / "hand_built_net.py", "nf_rec_ce")

        rng = np.random.default_rng(20260922)
        cfg_ce = {"loss": "ce"}

        # ================= B11：前馈 + 整数类别标签 =================
        N = 24
        X = rng.standard_normal((N, 4)).astype(np.float32)
        Yi = rng.integers(0, 3, size=N).astype(np.int64)
        p_int = make_npz(tmp, "feed_int.npz", X, Yi)

        x_t, y_t = feed.load_dataset({"data": p_int})
        log(x_t.dtype == torch.float32 and tuple(x_t.shape) == (N, 4),
            "前馈 X 读成 float32 (24, 4)", "%s %s" % (x_t.dtype, tuple(x_t.shape)))
        log((not y_t.is_floating_point()) and tuple(y_t.shape) == (N,),
            "整数类别标签保持整数、形状 (24,)——不会被转成 float32 软标签",
            "%s %s" % (y_t.dtype, tuple(y_t.shape)))

        net0 = feed.HandBuiltNet().eval()
        with torch.no_grad():
            out0 = net0(x_t)
        err = None
        try:
            torch.nn.CrossEntropyLoss()(out0, y_t.float())
        except Exception as e:                  # noqa: BLE001
            err = "%s: %s" % (type(e).__name__, e)
        log(err is not None,
            "旧行为（Y 转 float32 再喂 CE）确实会报错——这个坑是真的",
            (err or "没报错")[:110])

        lo, lt = feed.prepare_batch(out0, y_t, cfg_ce)
        log(lt.dtype == torch.long and tuple(lt.shape) == (N,),
            "prepare_batch：整数标签转 long、按 (样本数,) 展平",
            "%s %s" % (lt.dtype, tuple(lt.shape)))
        ref = float(F.cross_entropy(out0, y_t))
        got = float(torch.nn.CrossEntropyLoss()(lo, lt))
        log(abs(ref - got) < 1e-6, "分类损失和手工 F.cross_entropy 同值",
            "%.6f vs %.6f" % (got, ref))

        p_col = make_npz(tmp, "feed_col.npz", X, Yi.reshape(-1, 1))
        _, yc = feed.load_dataset({"data": p_col})
        log(tuple(yc.shape) == (N,) and not yc.is_floating_point(),
            "(N,1) 的整数标签自动展平成 (N,)", "%s %s" % (tuple(yc.shape), yc.dtype))

        p_bad = make_npz(tmp, "feed_badshape.npz", X, np.tile(Yi.reshape(-1, 1), (1, 3)))
        ok, msg = raises(lambda: feed.load_dataset({"data": p_bad}), "输出已经是")
        log(ok, "整数标签铺成 (N,3) 被明确拒绝，并说明标签不用再铺成 3 列", msg[:110])

        bad = Yi.copy()
        bad[0] = 3
        ok, msg = raises(lambda: feed.prepare_batch(out0, torch.from_numpy(bad), cfg_ce), "超出")
        log(ok, "越界类别号（3，而只有 3 类）在算损失前就被拦下", msg[:110])

        ok, msg = raises(lambda: feed.prepare_batch(out0, y_t, {"loss": "mse"}), "浮点目标")
        log(ok, "loss=mse 配整数标签：报错并提示分类该用 ce", msg[:110])

        soft = rng.random((N, 3)).astype(np.float32)
        soft /= soft.sum(axis=1, keepdims=True)
        p_soft = make_npz(tmp, "feed_soft.npz", X, soft)
        _, ys = feed.load_dataset({"data": p_soft})
        log(ys.dtype == torch.float32 and tuple(ys.shape) == (N, 3),
            "浮点软标签 (N,3) 仍是 float32、形状不变", "%s %s" % (ys.dtype, tuple(ys.shape)))
        lo2, lt2 = feed.prepare_batch(out0, ys, cfg_ce)
        log(tuple(lt2.shape) == (N, 3) and lt2.dtype == torch.float32,
            "软标签原样进 CE（同形，不展平）", str(tuple(lt2.shape)))
        log(abs(float(torch.nn.CrossEntropyLoss()(lo2, lt2)) -
                float(F.cross_entropy(out0, ys))) < 1e-6,
            "软标签损失和手工一致")

        cfg = dict(feed.TRAIN_CFG, data=p_int, epochs=30, batch_size=6, device="cpu")
        net, msg = quiet(feed.train, cfg)
        ls = losses_of(msg)
        log(len(ls) >= 2 and ls[-1] < ls[0],
            "前馈 + 整数标签：train() 端到端跑通且损失下降",
            "%.6f -> %.6f" % (ls[0], ls[-1]) if ls else "没有 loss 输出")
        log(not torch.allclose(net.weight.detach(), feed.HandBuiltNet().weight.detach()),
            "训练确实更新了权重")

        # ================= B12：循环 + 序列类别轴 =================
        B, T = 8, 4                 # T=4 而 NUM_STEPS=8：T 由数据给，不必回编辑器重编译
        Xr = rng.standard_normal((B, T, 2)).astype(np.float32)
        Yr = rng.integers(0, 3, size=(B, T)).astype(np.int64)
        netr = rec.HandBuiltNet().eval()
        with torch.no_grad():
            outr = netr(torch.from_numpy(Xr))
        log(tuple(outr.shape) == (B, T, 3),
            "循环网输出 (样本数, 时间步, 类别数) = (8, 4, 3)", str(tuple(outr.shape)))

        _, ytr = rec.load_dataset({"data": make_npz(tmp, "rec_int.npz", Xr, Yr)})
        log((not ytr.is_floating_point()) and tuple(ytr.shape) == (B, T),
            "序列整数标签保持整数、形状 (样本数, 时间步)", "%s %s" % (ytr.dtype, tuple(ytr.shape)))

        lor, ltr = rec.prepare_batch(outr, torch.from_numpy(Yr), cfg_ce)
        log(tuple(lor.shape) == (B * T, 3) and tuple(ltr.shape) == (B * T,) and ltr.dtype == torch.long,
            "整数序列标签：logits 展平成 (样本数×时间步, 类别数)，标签展平成 (样本数×时间步,)",
            "%s %s" % (tuple(lor.shape), tuple(ltr.shape)))
        yrb = torch.from_numpy(Yr)
        ref_r = float(F.cross_entropy(outr.reshape(-1, 3), yrb.reshape(-1)))
        got_r = float(torch.nn.CrossEntropyLoss()(lor, ltr))
        log(abs(ref_r - got_r) < 1e-6, "每个时间步的 logits 配它自己的标签（与手工逐位置 CE 同值）",
            "%.6f vs %.6f" % (got_r, ref_r))

        err = None
        try:
            torch.nn.CrossEntropyLoss()(outr, yrb)
        except Exception as e:                  # noqa: BLE001
            err = "%s: %s" % (type(e).__name__, e)
        log(err is not None, "整数标签不转轴：CE 直接拒绝（把时间步当成了类别维）",
            (err or "没报错")[:110])

        softr = rng.random((B, T, 3)).astype(np.float32)
        softr /= softr.sum(axis=2, keepdims=True)
        lo3, lt3 = rec.prepare_batch(outr, torch.from_numpy(softr), cfg_ce)
        log(tuple(lo3.shape) == (B, 3, T) and tuple(lt3.shape) == (B, 3, T),
            "软标签：logits 和标签一起转成 (样本数, 类别数, 时间步)",
            "%s %s" % (tuple(lo3.shape), tuple(lt3.shape)))
        good = float(torch.nn.CrossEntropyLoss()(lo3, lt3))
        pt = torch.from_numpy(softr)
        good_manual = float(-(pt * torch.log_softmax(outr, dim=2)).sum(dim=2).mean())
        bad_manual = float(-(pt * torch.log_softmax(outr, dim=1)).sum(dim=1).mean())
        bad = float(torch.nn.CrossEntropyLoss()(outr, pt))
        log(abs(good - good_manual) < 1e-6, "正确值 = 沿类别轴 softmax 的交叉熵",
            "%.6f vs %.6f" % (good, good_manual))
        log(abs(bad - bad_manual) < 1e-6 and abs(bad - good) > 1e-3,
            "软标签不转轴不报错、但算的是「沿时间轴 softmax」的另一个数——这就是 B12 修的静默错误",
            "正确 %.6f / 不转轴 %.6f" % (good, bad))

        bady = Yr.copy()
        bady[0, 0] = 3
        ok, msg = raises(lambda: rec.prepare_batch(outr, torch.from_numpy(bady), cfg_ce), "超出")
        log(ok, "序列越界类别号在算损失前就被拦下", msg[:110])

        ok, msg = raises(lambda: rec.prepare_batch(outr, torch.from_numpy(softr[:, :, :2].copy()), cfg_ce),
                         "类别数是")
        log(ok, "软标签最后一维不是类别数：明确报错", msg[:110])

        ok, msg = raises(lambda: rec.prepare_batch(outr, torch.from_numpy(Yr.reshape(-1)), cfg_ce),
                         "整数类别")
        log(ok, "序列标签写成一维 (样本数×时间步,) 被拒绝，并说明要写 (样本数, 时间步)", msg[:110])

        ok, msg = raises(lambda: rec.load_dataset({"data": make_npz(tmp, "rec_badx.npz", X, Yr)}),
                         "循环网")
        log(ok, "循环网收到 2 维 X：报错并说明要 (样本数, 时间步, 输入数)", msg[:110])

        netr2, msg2 = quiet(rec.train, dict(rec.TRAIN_CFG, data=make_npz(tmp, "rec2.npz", Xr, Yr),
                                            epochs=30, batch_size=4, device="cpu"))
        ls2 = losses_of(msg2)
        log(len(ls2) >= 2 and ls2[-1] < ls2[0],
            "循环 + 整数标签：train() 端到端跑通且损失下降",
            "%.6f -> %.6f" % (ls2[0], ls2[-1]) if ls2 else "没有 loss 输出")
        log("nan" not in msg2.lower(), "训练过程没有出现 nan")

        # ================= B09：状态型神经元的复位策略 =================
        stx = load_module(tmp / "state_ce" / "hand_built_net.py", "nf_state_ce")
        log(stx.RECURRENT is False and getattr(stx, "STATE_RESET", None) is True
            and str(stx.TRAIN_CFG.get("state", "")) == "reset",
            "B09：有状态图的生成物带 STATE_RESET，训练配置默认 state='reset'",
            "STATE_RESET=%r state=%r" % (getattr(stx, "STATE_RESET", None), stx.TRAIN_CFG.get("state")))
        log("def reset_state(self)" in (tmp / "state_ce" / "hand_built_net.py").read_text(encoding="utf-8")
            and "def detach_state(self)" in (tmp / "state_ce" / "hand_built_net.py").read_text(encoding="utf-8"),
            "B09：生成的类上有 reset_state() / detach_state() 两个公开接口")

        xA = torch.tensor([[1.0, 0.0]])
        xB = torch.tensor([[0.0, 0.0]])
        m0 = stx.HandBuiltNet().eval()
        with torch.no_grad():
            s1 = m0(xA).tolist()
            s2 = m0(xA).tolist()
        log(s1 == [[1.0]] and s2 == [[2.0]],
            "B09：不复位时同一份输入连着喂两次，记忆神经元把值攒了起来（1 → 2）——这就是跨样本串状态",
            "%r → %r" % (s1, s2))

        m1 = stx.HandBuiltNet().eval()
        m2 = stx.HandBuiltNet().eval()
        with torch.no_grad():
            m1(xA)
            m1.reset_state()
            got = m1(xB).tolist()
            ref = m2(xB).tolist()
        log(got == ref == [[0.0]],
            "B09：reset_state() 之后，一个没喂过的新样本和全新模型给出同一个结果（独立样本互相隔离）",
            "复位后 %r / 新模型 %r" % (got, ref))
        log(m1.reset_state() is m1 and m1.detach_state() is m1,
            "B09：reset_state() / detach_state() 都返回 self，可以链式调用")

        Xs = np.array([[1.0, 0.0], [0.0, 1.0], [1.0, 1.0], [0.0, 0.0]], np.float32)
        Ys = np.zeros((4, 1), np.float32)
        p_st = make_npz(tmp, "state_train.npz", Xs, Ys)
        base = dict(stx.TRAIN_CFG, data=p_st, epochs=2, batch_size=4, lr=0.0,
                    weight_decay=0.0, loss="mse", device="cpu", seed=11)
        _, msg_r = quiet(stx.train, dict(base, state="reset"))
        _, msg_k = quiet(stx.train, dict(base, state="keep"))
        lrs = losses_of(msg_r)
        lks = losses_of(msg_k)
        log(len(lrs) == 2 and lrs[0] == lrs[1],
            "B09：state=reset 时两个 epoch 的损失逐位相同（学习率 0 + 每批都从零开始 → 状态带不过来）",
            "%r" % lrs)
        log(len(lks) == 2 and abs(lks[0] - lrs[0]) < 1e-9 and abs(lks[1] - lks[0]) > 1e-6,
            "B09：state=keep 时第二个 epoch 的损失和第一个不一样（上一轮的状态真的被带过来了）",
            "%r" % lks)

        log(getattr(feed, "RECURRENT", None) is False and getattr(rec, "RECURRENT", None) is True,
            "生成物顶层带 RECURRENT 常量（前馈 False / 循环 True）")
        log(getattr(rec, "NUM_STEPS", None) == 8 and netr2.num_steps == 8,
            "NUM_STEPS 常量与模型一致（改它不用回编辑器重编译）")

    finally:
        fails = [l for l in OUT if l.startswith("FAIL")]
        for l in OUT:
            print(l)
        print("\n== %d PASS / %d FAIL ==" % (len(OUT) - len(fails), len(fails)))
        shutil.rmtree(tmp, ignore_errors=True)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
