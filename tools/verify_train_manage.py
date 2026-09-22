# -*- coding: utf-8 -*-
"""F07 / F08 回归：生成的训练骨架要能"管理训练"，而不是只能跑一遍。

F07 —— 验证集与训练管理：
    split_dataset 按 val_split 划验证集（默认 0 = 不划，行为与旧骨架一致）；
    连续轨迹按尾部连续切；evaluate 给损失 + 指标（分类准确率 / 回归 MAE）；
    train() 记录每轮指标，能写成 JSON（配置 + 曲线）。
F08 —— 完整断点续训：
    save_checkpoint 存的是权重 + 优化器 / 调度器状态 + 轮次 + 随机数流 + 内部状态 +
    实际生效的配置；load_checkpoint 先恢复完再返回（对不上就抛，不半加载）。
    验收方式是**中断续训 vs 一次跑完逐位相同**：少了任何一样（动量、随机流、轮次）
    都对不上。

Run: py -3 -B -X utf8 tools/verify_train_manage.py
夹具由 tools/gen_train_ce_fixture.mjs 用生产代码生成器现造，落在临时目录，跑完即删。
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch

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
    try:
        fn()
    except ValueError as e:
        return (needle in str(e)), str(e)
    except Exception as e:                      # noqa: BLE001
        return False, "抛的是 %s: %s" % (type(e).__name__, e)
    return False, "没报错"


def losses_of(text):
    import re
    return [float(x) for x in re.findall(r"loss=([0-9.eE+-]+)", text)]


def main():
    tmp = Path(tempfile.mkdtemp(prefix="nf_train_manage_"))
    try:
        gen = subprocess.run(["node", str(ROOT / "tools" / "gen_train_ce_fixture.mjs"), str(tmp)],
                             capture_output=True, text=True, cwd=str(ROOT))
        if gen.returncode != 0:
            print("夹具生成失败：\n" + gen.stdout + gen.stderr)
            return 1
        feed = load_module(tmp / "feed_ce" / "hand_built_net.py", "nf_mng_feed")
        rec = load_module(tmp / "rec_ce" / "hand_built_net.py", "nf_mng_rec")
        stx = load_module(tmp / "state_ce" / "hand_built_net.py", "nf_mng_state")

        rng = np.random.default_rng(20260922)
        N = 24
        X = rng.standard_normal((N, 4)).astype(np.float32)
        Y = rng.integers(0, 3, size=N).astype(np.int64)
        p_data = make_npz(tmp, "mng.npz", X, Y)
        Xt_all, Yt_all = torch.from_numpy(X), torch.from_numpy(Y)
        base = dict(feed.TRAIN_CFG, data=p_data, epochs=4, batch_size=6, device="cpu",
                    seed=5, lr=0.02, weight_decay=0.0)
        dev = torch.device("cpu")

        # ================= F07：验证集划分 =================
        (Xa, Ya), (Xv, Yv) = feed.split_dataset(Xt_all, Yt_all, dict(base, val_split=0))
        log(Xv is None and Yv is None and Xa.shape[0] == N and torch.equal(Xa, Xt_all),
            "val_split=0：不划验证集，训练集就是全部数据（旧行为逐位不变）",
            "%s / val=%s" % (tuple(Xa.shape), Xv))

        cfg_v = dict(base, val_split=0.25)
        (Xa, Ya), (Xv, Yv) = feed.split_dataset(Xt_all, Yt_all, cfg_v)
        (Xa2, _), (Xv2, _) = feed.split_dataset(Xt_all, Yt_all, cfg_v)
        log(Xa.shape[0] == 18 and Xv.shape[0] == 6,
            "val_split=0.25：24 个样本划成 18 训练 + 6 验证", "%d / %d" % (Xa.shape[0], Xv.shape[0]))
        log(torch.equal(Xa, Xa2) and torch.equal(Xv, Xv2),
            "同一个种子切两次得到同一份划分（可复现）")
        seen = {tuple(r) for r in Xa.tolist()} & {tuple(r) for r in Xv.tolist()}
        log(not seen and (Xa.shape[0] + Xv.shape[0]) == N,
            "训练集和验证集不重叠、合起来正好是全部样本", "重叠 %d 行" % len(seen))

        cfg_keep = dict(cfg_v, state="keep")
        (Xk, _), (Xkv, _) = rec.split_dataset(Xt_all, Yt_all, cfg_keep)
        log(torch.equal(Xkv, Xt_all[-6:]) and torch.equal(Xk, Xt_all[:-6]),
            "连续轨迹（state=keep）：验证集取尾部连续一段，不打乱时间顺序",
            "验证集是最后 %d 个" % Xkv.shape[0])

        ok, msg = raises(lambda: feed.split_dataset(Xt_all, Yt_all, dict(base, val_split=1.0)), "小于 1")
        log(ok, "val_split >= 1 明确报错", msg[:110])
        small = torch.from_numpy(X[:3]), torch.from_numpy(Y[:3])
        ok, msg = raises(lambda: feed.split_dataset(small[0], small[1], dict(base, val_split=0.1)), "分不出")
        log(ok, "样本太少划不出验证集：明确报错", msg[:110])
        ok, msg = raises(lambda: feed.split_dataset(small[0], small[1], dict(base, val_split=0.9)), "训练集")
        log(ok, "验证集划得太大把训练集吃光：明确报错", msg[:110])

        # ================= F07：指标与报表 =================
        net_e = feed.HandBuiltNet()
        m = feed.evaluate(net_e, Xv, Yv, dict(cfg_v), dev)
        log("val" in m and "val_acc" in m and 0.0 <= m["val_acc"] <= 1.0,
            "evaluate：分类给损失 + 准确率", "val=%.6f acc=%.4f" % (m["val"], m["val_acc"]))
        net_e.eval()
        with torch.no_grad():
            lo = net_e(Xv)
            ref = float(torch.nn.functional.cross_entropy(lo, Yv))
        log(abs(ref - m["val"]) < 1e-6, "evaluate 的损失 = 手工在验证集上算的交叉熵",
            "%.6f vs %.6f" % (m["val"], ref))
        log(feed._metric_kind(dict(cfg_v)) == "acc" and feed._metric_kind(dict(base, loss="mse")) == "mae"
            and feed._metric_kind(dict(base, loss="mse", metrics="acc")) == "acc",
            "指标跟着损失走：ce -> 准确率，mse -> MAE；显式写 metrics 就听它的")

        hist_path = str(Path(tmp) / "hist.json")
        net_h, msg_h = quiet(feed.train, dict(cfg_v, history=hist_path))
        ls = losses_of(msg_h)
        log(len(ls) == 4 and "val=" in msg_h and "acc=" in msg_h,
            "train(val_split>0)：每轮都打了 loss= 和 val= / acc=", "%d 行 / %d 个损失" % (msg_h.count("epoch "), len(ls)))
        hj = json.loads(Path(hist_path).read_text(encoding="utf-8"))
        log(len(hj["history"]) == 4 and hj["history"][0]["epoch"] == 1
            and all("loss" in r and "val" in r and "val_acc" in r for r in hj["history"]),
            "训练记录 JSON：每轮都有 loss / val / val_acc",
            "epochs=%d 字段=%s" % (len(hj["history"]), sorted(hj["history"][0].keys())))
        log(abs(float(hj["cfg"]["val_split"]) - 0.25) < 1e-9 and hj["cfg"]["loss"] == "ce",
            "训练记录里带着当时生效的配置（val_split / loss）")
        log("lr" in hj["history"][0], "每轮记录里带学习率")

        net_s, msg_s = quiet(feed.train, dict(base, val_split=0.25, val_every=10, epochs=4))
        log(msg_s.count("val=") == 1, "val_every=10：4 轮里只在最后一轮算了一次验证",
            "%d 次" % msg_s.count("val="))

        net_le, msg_le = quiet(feed.train, dict(base, val_split=0.25, log_every=10, epochs=4))
        log(msg_le.count("epoch ") == 2 and msg_le.count("val=") == 2,
            "log_every=10：4 轮里只在第 1 轮和最后一轮各打一行",
            "%d 行" % msg_le.count("epoch "))
        log(len(net_le.nf_last["history"]) == 4 and int(net_le.nf_last["cfg"]["log_every"]) == 10,
            "log_every 只管终端打印：训练记录还是 4 轮，值也写进了 cfg")

        opt = torch.optim.Adam(feed.HandBuiltNet().parameters(), lr=0.1)
        log(feed.make_scheduler(opt, dict(base, scheduler="none")) is None,
            "scheduler=none：不建调度器（默认，跟旧骨架一样）")
        sch = feed.make_scheduler(opt, dict(base, scheduler="cosine"))
        lr0 = float(opt.param_groups[0]["lr"])
        for _ in range(3):
            sch.step()
        log(float(opt.param_groups[0]["lr"]) < lr0, "cosine 调度：跑几轮之后学习率降下来了",
            "%.4f -> %.4f" % (lr0, float(opt.param_groups[0]["lr"])))
        opt2 = torch.optim.Adam(feed.HandBuiltNet().parameters(), lr=0.1)
        sch2 = feed.make_scheduler(opt2, dict(base, scheduler="step", scheduler_step=1, scheduler_gamma=0.5))
        sch2.step()
        log(abs(float(opt2.param_groups[0]["lr"]) - 0.05) < 1e-9,
            "step 调度：一个 step 之后学习率乘 gamma", "%.4f" % float(opt2.param_groups[0]["lr"]))
        ok, msg = raises(lambda: feed.make_scheduler(opt, dict(base, scheduler="bogus")), "scheduler")
        log(ok, "认不出的调度器明确报错", msg[:110])

        net_c, msg_c = quiet(feed.train, dict(base, val_split=0.25, grad_clip=0.001))
        log("nan" not in msg_c.lower() and losses_of(msg_c),
            "grad_clip>0：裁剪之后训练照样跑得下去（没有 nan）")

        # ================= F08：完整检查点 =================
        ck_path = str(Path(tmp) / "ck.pt")
        net_full, _ = quiet(feed.train, dict(base, epochs=4))
        net_a, _ = quiet(feed.train, dict(base, epochs=2))
        last = net_a.nf_last
        feed.save_checkpoint(net_a, ck_path, cfg=last["cfg"], opt=last["opt"], sched=last["sched"],
                             epoch=last["epoch"], history=last["history"], best=last["best"])
        ck = torch.load(ck_path, map_location="cpu", weights_only=True)
        log(all(k in ck for k in ("state_dict", "cfg", "epoch", "history", "optimizer", "scheduler", "rng")),
            "检查点里有权重 / 配置 / 轮次 / 记录 / 优化器状态 / 调度器状态 / 随机数流",
            "字段 " + ",".join(sorted(ck.keys())))
        log(int(ck["epoch"]) == 2 and len(ck["history"]) == 2 and int(ck["cfg"]["epochs"]) == 2
            and ck["cfg"]["data"] == p_data and ck["cfg"]["optimizer"] == "adam",
            "检查点记的是实际生效的配置与进度"
            "（epochs / data / optimizer 都是当时真跑的那份）",
            "epoch=%s history=%s epochs=%s" % (ck["epoch"], len(ck["history"]), ck["cfg"].get("epochs")))

        net_b, msg_b = quiet(feed.train, dict(base, epochs=4, resume=ck_path))
        same = all(torch.equal(p.detach(), q.detach())
                   for p, q in zip(net_full.parameters(), net_b.parameters()))
        log(same, "F08：中断续训 == 一次跑完（所有权重逐位相同）—— 少存任何一样都对不上")
        log(msg_b.count("接着跑") == 1 and "已经完成 2 轮" in msg_b,
            "续训时明确打印从第几轮接着跑", msg_b.strip().splitlines()[1][:80] if len(msg_b.strip().splitlines()) > 1 else msg_b[:80])
        hb = net_b.nf_last["history"]
        log([r["epoch"] for r in hb] == [1, 2, 3, 4], "续训后的训练记录是 1..4 连贯的四轮")
        log(net_b.nf_last["resumed_from"] == ck_path, "net.nf_last 里记着这次是从哪个检查点续的")
        log(net_b.nf_last["cfg"]["data"] == p_data,
            "续训用的是检查点里那份配置（数据源也是它）")

        net_x, _ = quiet(feed.train, dict(base, epochs=2, resume=ck_path))
        log(int(net_x.nf_last["epoch"]) == 2 and len(net_x.nf_last["history"]) == 2,
            "检查点已经跑满时再 resume：不重复训练，记录也不重复追加",
            "epoch=%s" % net_x.nf_last["epoch"])

        # 旧格式（只有 state_dict + cfg）也要能读
        old_path = str(Path(tmp) / "old.pt")
        torch.save({"state_dict": net_a.state_dict(), "cfg": {"loss": "ce", "batch_size": 6}}, old_path)
        net_old = feed.HandBuiltNet()
        feed.load_checkpoint(old_path, net_old)
        log(torch.equal(net_old.weight.detach(), net_a.weight.detach()),
            "旧格式检查点（只有权重 + 配置）也读得进来")

        # 对不上要拒
        rec_ck = str(Path(tmp) / "rec_ck.pt")
        rec.save_checkpoint(rec.HandBuiltNet(), rec_ck)
        ok, msg = raises(lambda: feed.load_checkpoint(rec_ck, feed.HandBuiltNet()), "对不上")
        log(ok, "换成结构不同的模型（另一份图的检查点）明确拒绝，不半加载", msg[:110])
        ok, msg = raises(lambda: feed.load_checkpoint(str(Path(tmp) / "nope.pt"), feed.HandBuiltNet()), "不存在")
        log(ok, "检查点路径不存在：明确报错", msg[:110])
        junk = Path(tmp) / "junk.pt"
        junk.write_text("这不是检查点", encoding="utf-8")
        ok, msg = raises(lambda: feed.load_checkpoint(str(junk), feed.HandBuiltNet()), "读不出来")
        log(ok, "不是检查点的文件：明确报错", msg[:110])
        net_partial = feed.HandBuiltNet()
        before = net_partial.weight.detach().clone()
        raises(lambda: feed.load_checkpoint(rec_ck, net_partial), "对不上")
        log(torch.equal(net_partial.weight.detach(), before),
            "被拒之后模型一个参数都没被改过（不是半加载）")

        # 有状态图：膜电位一起存 / 一起恢复
        snet = stx.HandBuiltNet().eval()
        with torch.no_grad():
            snet(torch.tensor([[1.0, 0.0]]))
        log(snet.st is not None and float(snet.st.sum()) > 0.0,
            "状态型模型跑过一拍之后 self.st 里有膜电位", "sum=%.3f" % float(snet.st.sum()))
        s_path = str(Path(tmp) / "state.pt")
        stx.save_checkpoint(snet, s_path)
        sck = torch.load(s_path, map_location="cpu", weights_only=True)
        log(sck.get("net_state") is not None, "检查点里带着内部状态（膜电位）")
        snet2 = stx.HandBuiltNet().eval()
        stx.load_checkpoint(s_path, snet2)
        log(snet2.st is not None and torch.equal(snet2.st, snet.st),
            "恢复之后膜电位跟存的时候逐位相同")
        with torch.no_grad():
            next_a = snet(torch.tensor([[0.0, 0.0]])).tolist()
            next_b = snet2(torch.tensor([[0.0, 0.0]])).tolist()
        log(next_a == next_b, "恢复出来的模型接着喂同一拍，输出和原模型一致", "%r / %r" % (next_a, next_b))

        # 训练面板里能改到这些键（生成物默认值也在）
        log(all(k in feed.TRAIN_CFG for k in ("val_split", "val_every", "metrics", "scheduler",
                                              "scheduler_step", "scheduler_gamma", "grad_clip")),
            "TRAIN_CFG 里带着新配置项（编辑器面板写的也是这几个键）",
            ",".join(k for k in ("val_split", "val_every", "metrics", "scheduler", "grad_clip") if k in feed.TRAIN_CFG))
        log(feed.TRAIN_CFG.get("val_split") == 0 and feed.TRAIN_CFG.get("scheduler") == "none",
            "默认值保持旧行为：不划验证集、不调度、不裁剪")
    finally:
        fails = [l for l in OUT if l.startswith("FAIL")]
        for l in OUT:
            print(l)
        print("\n== %d PASS / %d FAIL ==" % (len(OUT) - len(fails), len(fails)))
        shutil.rmtree(tmp, ignore_errors=True)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
