# 修复交接日志

## 2026-09-22：第 77 轮 —— 训练骨架补上验证集与断点续训（F07 / F08）+ 一处「读接口自己会变」的真问题

### 1. 范围与结论

- 把功能缺口里的 **F07（验证集与训练管理）**、**F08（完整断点续训）** 做进生成的训练骨架，并跑通全部回归。
- 顺手修掉一个**真问题**：`serializeV2()` / `aiSessionDoc()` 是只读接口，但每次调用都给对话记录盖一个新的 `Date.now()`，于是「什么都没变」的两次序列化也会差一个字（自测页 B20「打开失败后整份工程一字未改」就是被这条抖出来的）。现在「内容没变就不刷新活动时间」，同状态两次调用逐字节相同。
- 另外两处收尾：B14 的容量说明与 README 对齐；B16 的桌面构建校验（上一轮做的东西这轮进了安装包）。
- 本轮**已 commit + push**。`%APPDATA%\NeuroForge\settings.json` 全程只读（只在装完新版后做过一次启动自检，前后对比：只有 `at` 这个时间戳变了，`key` 164 字符原样在，`base` / `model` / `noAsk` 都没动）。

### 2. 逐项改动

**F07 —— 验证集与训练管理**（生成文件 `hand_built_net.py` / `model.c` 里的训练骨架）

- 新增 `split_dataset(X, Y, cfg)`：`val_split`（默认 **0 = 不划**，训练集就是全部数据，行为与旧骨架逐位一致）。24 个样本按 0.25 → 18 训练 + 6 验证；同一个种子两次跑得到同一份划分；连续轨迹（`state=keep`）取**尾部连续一段**、不打乱时间顺序。
- 三种划不出来都明确报错（`ValueError`，讲清原因）：`val_split >= 1`、分不出验证集（`nv < 1`）、训练集被吃光。
- 新增 `evaluate(net, X, Y, cfg, dev)`：给「损失 + 指标」，`loss` 是 ce 就给准确率、是 mse 就给 MAE（`metrics` 显式写了就听它的）；验证是独立一次遍历，跑完把 net 切回 train 模式，有状态神经元前后各清一次膜电位。
- 新增 `make_scheduler(opt, cfg)`：`none` / `cosine` / `step`（认不出的名字明确报错）；`grad_clip > 0` 时按 `clip_grad_norm_` 裁剪。
- `train()` 记录每轮指标（`epoch` / `loss` / `lr` / `val` / `val_acc`），`--history hist.json` 写成 JSON（含当时生效的配置）。
- 终端打印由 `log_every` 控制（默认 1 = 每轮一行）。以前是写死的「第 1 轮 / 每 10 轮 / 最后一轮」，四轮的训练只打两行；现在想少打就调大 `log_every`，**训练记录不受影响**（照样每轮都进 JSON）。
- 编译对话框「训练」页新增 4 个控件（验证集比例 / 每几轮验证 / 学习率调度 / 每几轮打印 + 梯度裁剪）；命令行新增 `--val-split` / `--history` / `--log-every`。

**F08 —— 完整断点续训**

- `save_checkpoint` 改成**完整检查点**：`state_dict` + **实际生效的 cfg** + `epoch` + 每轮 `history` + `best` + 优化器状态 + 调度器状态 + 随机数流（torch / numpy / python）+ 内部状态（膜电位 `net_state`）。`optimizer` / `scheduler` 两个键**始终**写出来（没有就是 `None`）——缺键和「没有状态」是两回事。
- 新增 `load_checkpoint(path, net, opt, sched, map_location)`：**先恢复完再返回**；文件不存在 / 读不出来 / 认不出的格式 / 形状或结构对不上（`strict=True`）都明确抛错，被拒之后**模型一个参数都没被改过**（不是半加载）。旧格式（只有 `state_dict` + `cfg`）仍读得进来。
- `train(cfg)` 支持 `resume`：以检查点里那份配置为基准，调用方再给的键覆盖它；`--resume trained.pt` 从那一轮接着跑（检查点已经跑满就不重复训练、记录也不重复追加）。收尾信息留在 `net.nf_last`（`cfg` / `opt` / `sched` / `history` / `best` / `resumed_from` / `epoch`），命令行保存检查点直接用。
- 验收方式是**中断续训 vs 一次跑完逐位相同**：少了动量、随机流、轮次里任何一样都对不上。

**顺带修掉：只读接口每次都换一个字节**

- `aiSessSnap()` 以前无条件 `s.at = Date.now()`，`aiSessDoc()` 又用 `at: Date.now()`，于是 `NF.serializeV2()` / `NF.aiSessionDoc()` 同一份状态连调两次会差一个字（跨毫秒就抖）。现在快照先算一个指纹（当前段 id + 消息条数 + 末条长度 + 日志条数 + did + turns + 手册版本），**内容变了才刷新活动时间**；文档级的 `at` 改成「最近一段对话的活动时间」，不再是「此刻」。语义也更对：读一次接口不该把「最后活动时间」往前推。

**B14 / B16 收尾**

- B14：`ai_manual.js` 的容量说明改成绝对天花板（16,777,216 / 67,108,864），README 四处旧说法同步；手册正文补一节「训练骨架带什么」，`AI_MANUAL_VERSION` r58 → **r59**（README 里的版本号同步）。
- B16：`buildinfo.mjs` + `build_all.mjs` + 成品页指纹 + `sync_frontend.mjs` 逐文件核对这套东西，本轮真的挡住了一次「源码改了没重建」（esbuild 直接报错），桌面安装包也是核过指纹才打的。

### 3. 新增 / 加强的回归

- **新** `tools/verify_train_manage.py`（**42 项**）：验证集划分 / 指标 / 调度 / 裁剪 / `log_every` / 完整检查点 / 续训逐位相同 / 状态型模型的膜电位一起存一起恢复 / 旧格式兼容 / 拒绝半加载 / 被拒后模型没被改。
- 自测页加 2 项（B20 追加）：「什么都没变时对话存档连调两次给同样的字节（跨毫秒也不抖）」+「真发生了事活动时间照样更新」。selftest 992 → **994** 项。
- `verify_torch.py` 的 `softmax_ts` 从「假通过」改成真比数值（见上一轮第 4 节），仍 5/5。

### 4. 实测结果（本机，实测与推断分开写）

- `node prototype/build_all.mjs`：esbuild + build.mjs + 17 个校验页 + 静态复查，**全过**（连接数据列写入点 61 处全部带钩子）。
- `node prototype/run_checks.mjs`：**17 页全部通过**。selftest **994P/0F**、streamcheck 117、crosscheck 117、wmin 63、plastcheck 33、appearcheck 31、sesscheck 78、chunkcheck 19、compatcheck 15、buildcheck 14；perf 页 12 万神经元 / 59.9 万连接，一帧 4.7–9.8 ms。
- 15 个 Python 回归：`verify_import.py` **283**、`verify_train_manage.py` **42**、`verify_train_ce.py` **37**、`verify_audit_codegen.py` **39**、`verify_op.py` **18**、`verify_cross.py` **117**、`verify_stream.py` **25**、`verify_codegen.py` **13**、`verify_param_roles.py` / `verify_bin.py` / `verify_plastic.py` / `verify_compat.py` / `verify_audit_import.py` / `verify_audit_reader.py` / `verify_torch.py` **5** —— **0 FAIL**。
- 3 个 mjs 回归：`verify_audit_io.mjs` 8、`verify_gpt6_protocol.mjs` 40、`verify_gpt6_integration.mjs` 14 组，全过。
- `torch` 会打一条 `lr_scheduler.step() before optimizer.step()` 警告——那是回归脚本自己手动 step 调度器造成的；产品生成的 `train()` 是「批次内 `opt.step()`、每轮末 `sched.step()`」，顺序是对的。

### 5. 构建与桌面更新

- 源码指纹：`prototype/src/main.js` SHA-256 `640BCDFDC6A02CA34C9F4C35211F310958303B2E8F80054ECADA525ED1E39EB2`；B16 源码指纹 `b447af54ad15…`，bundle `3d521552a169…`，成品页 / 前端 `8ac4ccae2bfa…`（3,310,208 字节），构建时刻 `2026-09-22T12:45:36Z`。
- `cd desktop && npm run build` 通过（Rust release 59.5 s），安装包 `desktop/src-tauri/target/release/bundle/nsis/NeuroForge_0.1.0_x64-setup.exe`。
- 已替换 `%LOCALAPPDATA%\NeuroForge\neuroforge.exe`：新版 4,016,128 字节 / SHA-256 `DDD5C2E0A1AECD999640F6CA5DB4B87F7FB362602F7E2B216307E06D85A0ADD6`；旧版备份在 `_dump/backup-neuroforge-before-r77-20260922-204647.exe`（4,011,008 字节 / `3D158493FF33…`）。
- 启动自检：隐藏窗口启动 → 进程活着、窗口标题正常（`NeuroForge 神经元搭建器 v0.1 (原型)`）→ 关掉。启动前后 `settings.json` 都是 486 字节，只有 `at` 变了，API Key 未动。

### 6. 仍然存在的问题

- F01–F06、F09–F16 仍未做（见 `docs/issue-handoff.zh-CN.md` 第 3 节，F07/F08 这轮标了「已实现」）。
- 训练骨架仍然只是骨架：全量数据读进内存，没有混合精度 / 梯度累积 / 多卡；编辑器里不跑训练（训练在生成出来的脚本里跑）。
- `s.at` 的刷新依据是「指纹」而不是逐字节比对：如果末条消息被改成**完全等长**的内容，活动时间这一次不会刷新（只影响对话列表上显示的时间，不影响数据）。

### 7. 下一步

- 建议按 **F09（训练权重回填编辑器）** 或 **F05（编辑器里的训练闭环）** 往下做：现在「训练 → 检查点 → 回填」这条链只差回填那一段。

--------

## 2026-09-22：第 73–76 轮 —— 交接文档 B01–B22 全部修复

### 范围与结论

- 把 [问题与功能缺口交接文档](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/docs/issue-handoff.zh-CN.md) 里的 22 个问题（B01–B22）逐项改完，每项都补了对应回归。22 项状态见该文档第 1 节的「状态」列。
- 改动全部留在工作区：**本轮没有 commit、没有 push**；没有动 `%APPDATA%\NeuroForge\settings.json`，用户填过的 API Key 原样保留（自测页里本来就有备份/还原它的逻辑）。
- 下面第 2 节是改动内容，第 3 节是新增回归，第 4 节是**实测**结果，第 5 节是构建与桌面更新，第 6 节是仍然存在的问题。实测与推断分开写。

### 逐项改动

**B01 — 模型能通过公开 API 请求开启本机权限（P1）**
`desktop/src-tauri/src/sys_exec.rs`、`io_bus.rs`：本机权限命令只认界面那一处发起，模型调用链里 `aiConfig` 不再赋值 `sysFs` / `sysRun`；`list_api` / `run_api` 都过名单，模型递上来的这两个字段一律拒绝并回报真值。浏览器构建（没有壳子）走不到那个对话框。

**B02 — 配置备份补 Key 没有绑定服务端地址（P1）**
凭证备份按 provider 地址分组，恢复时只在**同一地址**上补 Key，换接口不会把 A 的 Key 送到 B；显式清空过的 Key 不会被备份复活。前端与 Rust 写库用同一套地址归一规则。

**B03 — 通用 API 修改没有统一撤销/事务保护（P2）**
`AI_API_ROLE_FLAT`（read / flat / mut / ext 四个名单）成为唯一判据：`run_api` 统一过事务外壳（`snapshot()`），`list_api` 会告诉模型每个接口能不能撤销；没列进表的接口按保守的 `mut` 处理；碰外部世界的（写文件、发请求）单独挂 `ext`。

**B04 / B07 / B08 — 参数语义：统计量、字面常量、共享权重（P1/P2）**
参数角色落到容器里：浮点默认 `weight`，整型默认 `int`，BN / LN 的 `mean` / `var` 判成 `stat`，字面常量是 `const`。生成代码按角色分支——只有 `weight` 才建 `nn.Parameter`，`stat` 跟着 `self.training` 走，`const` 不进优化器。同一个源权重在多处引用时建成「共享参数组」：只建一份参数，改一处全组一起变、编译只存一份、梯度累加到同一段。

**B05 — ONNX Dropout 第三输入漏检（P2）**
导入器把 Dropout 的属性、opset12+ 的第 3 输入、以及第 2 个输出是否被下游用到都查一遍；训练模式是动态输入或与属性矛盾时明确拒绝，不再悄悄变成直通。

**B06 — 精确 GELU 被导成 tanh 近似（P2）**
编辑器里那个 `gelu` 本来就是 `F.gelu(approximate="tanh")`，保持不动；反过来修导入器：ONNX 的 tanh 近似放行，精确 `erf` 版本在 `report.numeric` 里记 `approximate`，让报告不再声称「数值等价」。

**B09 — 内部记忆状态在随机训练批次间串用（P2）**
生成的训练骨架带 `STATE_RESET` 常量、`reset_state()` / `detach_state()` 两个接口，`TRAIN_CFG` 多一项 `state`（`reset` / `keep`，默认 `reset`）；`train()` 按合并后的 cfg 现算，`reset` 时按批复位、`shuffle` 也跟着走，CLI 有 `--state`，编译对话框和文件头都写明策略。

**B10 — 编辑器连续信号与导出模型的状态策略不一致（P2）**
`IFACE` 增加 `stMode` / `st` / `stKey`；`computeSimulation` 接受上次的膜电位并返回 `stOut` / `stCarried`（长度对不上就重新从零开始）；`ifaceForward` 分 keep / reset 两种模式。界面加「状态型神经元的膜电位」下拉 + 清空按钮，`NF.ifaceStateMode(m)` / `NF.ifaceResetState()` 进公开 API 名单。

**B11 / B12 — 分类训练骨架的标签格式与序列 CE 的轴（P2）**
`load_dataset` 只对浮点 Y 转 `float32`（整数标签原样留给 CE）；新增 `prepare_batch` 与 `_check_class_range`：普通分类把整数标签展开成 `(B*T, C)`，循环网软标签做 `transpose(1,2)`，越界类别明确报错。顶层常量 `RECURRENT` 标明网络类型。

**B13 — `source.exact` 把「没跳节点」与「完整等价」混在一起（P2）**
`build_report(b)` 输出结构化报告：`{structure, numeric, dtype, shared, verified, items, itemCount, exactAll, how}`，把「结构上没跳节点」「数值上是否近似」「类型是否降级」「是否有共享」分开说，`exactAll` 只在这些都干净时为真。

**B14 — README 容量和训练能力描述落后于代码（P3）**
中英文 README 与内置 AI 手册（`prototype/src/ai_manual.js`）全部对齐源码：断言数 875 → 992，导入器项数 242 → 283，容量改成「按需增长 + 绝对天花板 `CAP_HARD_N = 16,777,216` / `CAP_HARD_E = 67,108,864`」，把「死上限 50 万 / 200 万」的旧说法逐条清掉（性能表里的 50 万 / 200 万改成「参考机实测规模，不是硬上限」）。

**B15 / B17 — 视角书签的坐标校验与 HTML 注入（P2）**
`viewNorm` 要求 6 个坐标都是合法有限数值，缺字段 / 字符串 / `Infinity` 一律拒；跳转前再保护一次，失败不动相机。书签标签不再拼 HTML，面板改成安全渲染。

**B16 — 桌面构建不会确认前端产物来自当前源码（P2）**
见第 5 节。

**B18 — 直接新增学习档位仍可突破上限（P1）**
`PLAST_MAX = 255`（档位号是 1 字节，超了会静默回绕成别的档位）三处入口一起拦：UI 新增档位、文件头校验、模块复制。

**B19 — 删除自动保存后旧任务把它写回（P2）**
`AUTOSAVE` 加世代号：提交前核对世代，对不上就放弃写入（返回 `{ok:false, stale:true}`）；删除时 `gen++` 并撤掉已排队的定时器与在途任务。

**B20 — 打开损坏文件不是原子操作（P1）**
`nforge3ReadHeader` 做打开前的整份预检；`nforge3Apply` 把所有会抛错的事放在提交之前，提交阶段不再抛——坏了就抛在动图之前，当前图不再被改坏一半。

**B21 — Python 读取器接受缺冻结标记的截断文件（P2）**
`tools/nforge.py` 的 `_inflate()` 统一把坏压缩转成 `ValueError`；`decode_chunk` 查最小长度，8 个上游读取入口都会拒绝截断文件。

**B22 — 权重块计数与实际形状矛盾仍通过（P2）**
`decode_blocks` 校验 `sum(ks)==sum_k`、`sum(ns)==sum_n`，并核对真正存着的权重条数等于 `total_w`，对不上就拒。

### 新增/更新的回归

| 回归 | 覆盖 |
| --- | --- |
| `prototype/check_b01_perms.mjs`（5 项） | B01 权限边界 |
| `prototype/check_b02_keys.mjs`（6 项） | B02 凭证绑定地址 |
| `prototype/check_b03_roles.mjs`（10 项） | B03 角色表 / 事务 / 名单 |
| `prototype/check_b04_08_params.mjs`（11 项） | B04/B07/B08 角色与共享 |
| `prototype/check_b15_17_views.mjs`（6 项） | B15/B17 书签坐标与转义 |
| `prototype/check_b16_build.mjs`（9 项） | B16 构建指纹（全在临时假仓库里跑） |
| `prototype/check_b19_autosave.mjs`（6 项） | B19 自动保存世代 |
| `prototype/check_audit_state.mjs`（18 项） | B18 档位上限、流式分块边界、状态审计 |
| `prototype/check_ai_settings.mjs`（27 项） | 模型列表 / 凭证 / 设置入口 |
| `prototype/make_selftest.mjs` | B09/B10 自测（`stOut`/`stCarried`、reset/keep、`reset_state`/`detach_state`） |
| `tools/verify_train_ce.py`（37 项） | B11/B12 + B09 训练骨架 |
| `tools/verify_param_roles.py`（18 项） | B04/B07/B08 跨 JS / Python |
| `tools/verify_audit_reader.py`（13 项） | B21/B22 读取器校验 |
| `tools/verify_audit_import.py`（6 组） | B05/B06 导入器 |
| `tools/verify_audit_codegen.py`（39 项） | B13 报告与代码生成 |
| `tools/gen_train_ce_fixture.mjs` / `tools/gen_param_roles_fixture.mjs` | 上面两个脚本的夹具 |

### 实测结果（2026-09-22，本机）

- `node prototype/build_all.mjs`：esbuild 打包 → 成品页 3.13 MB → 17 个校验页刷新 → **静态复查 10 个全过**（B16 之前是 9 个）。
- `node prototype/run_checks.mjs`：**17 个校验页全部通过**。其中 selftest **992 PASS / 0 FAIL**、streamcheck 117/0、sesscheck 78/0、plastcheck 33/0、wmin 63/0、appearcheck 31/0、chunkcheck 19/0、compatcheck 15/0、buildcheck 14/0、blockcheck / bincheck / codegen / crosscheck / importcheck / opcheck / plastbin / perf 均 OK。
- 静态复查：B01 5、B02 6、B03 10、B04/07/08 11、B15/17 6、**B16 9**、B19 6、B18/状态 18、AI 设置 27，连接数据列 61 处写入点全部带钩子。
- Python 侧：`verify_import.py` **283 项通过**、`verify_audit_reader.py` 13 项、`verify_audit_import.py` 6 组、`verify_audit_codegen.py` 39 项、`verify_train_ce.py` **37 项**、`verify_param_roles.py` 18 项、`verify_stream.py` 25 项、`verify_cross.py` 117 项、`verify_op.py` 18 项、`verify_codegen.py` 13 项、`verify_bin.py` / `verify_compat.py` / `verify_plastic.py` 全部通过。
- **既有失败（不是本轮引入）**：`tools/verify_torch.py` 的 `softmax_ts` 用例报「本该报错却通过了」。已用 `git show HEAD:tools/nforge.py` 换回改动前的实现复现同一失败，确认与本轮无关，本轮不修。

### B16 的修法与构建

- `prototype/buildinfo.mjs`（新）：定义「源码清单 = `prototype/src/*.js` + `template.html`」的内容指纹，以及产物标记的读写与核对——生成侧和校验侧共用同一份规则。
- `prototype/build.mjs`：把 `src=<源码指纹> bundle=<bundle 指纹>` 写进成品页 `<head>`（在 bundle 内联之前插，避免插到内联 JS 里），并把逐文件哈希写进 `prototype/dist/build-manifest.json`。
- `desktop/sync_frontend.mjs`：同步前重算并逐文件比对，对不上就**拒绝打包并指名改了哪个文件**；「旧产物没有指纹」「只跑了 esbuild 没跑 build.mjs」「成品被手改」三种情况分开报。同步成功后写 `desktop/dist/build-manifest.json`（源码指纹 / bundle 哈希 / 前端哈希）。
- `prototype/build_all.mjs`（新）：唯一完整构建入口（esbuild → build.mjs），`desktop/package.json` 的 `build` / `check` 都先跑 `npm run frontend`，所以「少跑一步」不再是默认行为。
- `README.zh-CN.md` 的构建说明与目录结构同步更新。
- 回归 `node prototype/check_b16_build.mjs` 用审计的原手法复现：假仓库 + mtime 2020 的旧 HTML + 更新的 main.js，同步脚本返回 1、不写 dist；新产物则通过并落盘。

### 构建与桌面更新

- 前端：`node prototype/build_all.mjs` 重建，成品页 3,286,499 字节，源码指纹 `d8d11243f009…`。
- 桌面壳：`desktop` 目录执行 `npm run build`（= 先完整重建前端 → 核对指纹 → tauri build）。日志里能看到链条真的按顺序跑：`静态复查已通过（10 个）` → `已同步前端: dist/index.html 3.13 MB` → `源码指纹 d8d11243f009…（已核对）` → `Built application at: ...\release\neuroforge.exe`。
- 2026-09-22 20:19（UTC+08:00）完成替换。替换前程序**正在运行**（PID 33624），按前几轮的做法把运行中的 exe 改名而不是覆盖，所以没有关闭用户的进程、也没有动账户配置或工程。
- 单文件前端与壳子里那份 SHA-256 一致：`1573E032E477270FCADDA4B824CBD64FB2895476513D3982729177027B9A8C88`。
- 新 exe SHA-256：`3D158493FF33759F96E1D5597FC8D1DE7363F2C60255F34B553B589F7C95F615`（release 与安装目录内一致）。
- 旧 exe SHA-256：`7EB79BB9D858E4B609E3E378BCAD3B7644F2D14A1E44C754B41B9CFF7F8957BA`，备份在 `_dump/backup-before-b01-b22-20260922-201932/neuroforge.exe`，安装目录内另留 `neuroforge-before-b01-b22-20260922-201932.exe`。
- NSIS 安装包：`desktop/src-tauri/target/release/bundle/nsis/NeuroForge_0.1.0_x64-setup.exe`，SHA-256 `8126F50606280B7EDA5A1D7CBB689D4306245ACAEE1E18C17B99F1EF98B1D961`。
- `%APPDATA%\NeuroForge\settings.json` 未被读写（最后修改时间仍是 18:03:12）：`key` 164 字符、接口 `https://api.openai.com/v1/responses`、模型 `gpt-6-astra`，另外 `noAsk=true` / `autoRun=true`（用户之前关掉的「AI 操作要确认」设置也还在）。**用户重启程序后才会跑上新 exe。**
- 本轮没有提交到 Git：工作区里 B01–B22 的全部改动、新增回归和文档都还没有 commit / push。

### 仍然存在的问题

1. `tools/verify_torch.py` 的 `softmax_ts` 用例是本轮之前就存在的失败（见第 4 节），没修。
2. B16 只保证「打包进壳子的前端来自当前源码」；它不保证 exe 里那份和当前工作区一致——装了之后要覆盖 `neuroforge.exe` 才算真的换掉（README「已经装好的那份不会自动更新」那段仍然有效）。
3. 交接文档第 3 节的 16 项功能缺口（F01–F16）不在本轮范围。

## 2026-09-22：全面问题清单与离线复现交接（只写文档，未修程序）

- 用户希望节省额度，把发现的问题详细交给其他模型处理，并明确“不局限任何地方”。在原模型能力审查基础上，扩查配置/凭证、权限/撤销、文件解析/载入、自动保存、学习档位、书签界面和构建交付；检查到的问题均记录，未做无限规模或真实用户数据的压力测试。
- 主入口：[问题与功能缺口交接文档](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/docs/issue-handoff.zh-CN.md)。共 **22 个待修问题、16 项功能缺口、9 个后续验证领域**；每项区分实际复现/源码确认/未覆盖范围，附文件位置、触发条件、实际与预期、修复方向和验收。部分编号共享根因，不等于 22 个独立安全漏洞。
- 本轮新增的高优先问题：通用模型工具可请求自开本机权限；通用配置恢复跨接口补 Key；损坏工程普通打开失败后已部分覆盖当前图；UI/API 直接新增学习档位仍能超限并回绕；BN 梯度模式前向报错。其他问题包括撤销、Dropout/GELU、常量和共享权重训练语义、状态隔离、CE 标签/轴、exact 说明、过期文档、书签坐标/HTML、过期构建、自动保存删除竞态、Python 文件校验。
- **上述问题尚未修复。** 已有 FIX_LOG 的“档位上限”修复只覆盖模块复制路径，本次 B18 证明直接新增入口还需修，不能把旧条目当作全入口验收。f64 正常编译已有明确拦截，未作为静默失真漏洞计数。
- 复现材料在 `_dump/capability-audit`、`_dump/param_semantics` 及本文列出的配置/书签探测文件；全为极小合成样本、假凭证、假宿主或临时目录。BN/部分数值测试只覆盖实际表达式和生成规则，已标明不等于全应用端到端测试；B09/B10 主要为源码确认。
- 安全实验未执行真实权限变更、读取真实 Key、发网络请求或证明真实凭证泄露。故障 nforge 夹具仅用于隔离脚本，没有拿用户工程试错。
- 产品源码、安装程序和用户配置均未修改，未重新构建。主程序/导入器/AI 手册 SHA-256 与能力审查基线一致；新增文档及本轮探测脚本已检查，`git diff --check` 通过。此前未提交改动全部保留。
- 交接包 `docs/NeuroForge-audit-handoff-2026-09-22.zip` 包含报告、日志和选定的离线复现材料；不含真实凭证、用户工程、完整产品源码或依赖。接手模型先读主文档第 0/6 节，再按 B 编号逐项修复并追加实际测试和构建状态。

## 2026-09-22：模型复现与 AI 扩展能力审查（报告，未修程序）

- 用户询问是否能复现所有类型 AI 模型、缺少哪些功能，以及能否由内置 AI 补充。本轮已检查计算/导入/导出、训练/状态和 AI 工具/权限三个方向；没有修改生产代码、重新构建安装或调用真实 API，原用户设置和工程未动。
- 完整矩阵、源码行号、验证范围和开发顺序见 [模型复现能力审查](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/docs/model-capability-audit.zh-CN.md)。结论：支持常见标量网络、部分 CNN/循环网和固定形状 Attention，尚非任意模型的完整复现平台；搭建/显示、数值推理、训练等价、规模可运行需分别验证。
- 已确认待修问题：① 模型可调用的 `run_api → NF.aiConfig → aiSysSync → nf_sys_allow` 暴露本机权限变更入口（仅静态追踪，未执行）；② BatchNorm running mean/var 被生成成 `nn.Parameter`，普通梯度模式前向报错，且固定推理模式；③ 现代 Dropout 第三输入训练开关漏检；④ GELU 精确模式被导成 tanh 近似；⑤ 有状态神经元缺少训练样本间复位策略，编辑器连续输入与导出模型状态语义也不一致。**这些是本轮新发现，未修复。**
- 其他缺口：算子/动态形状/参数别名支持有限，编辑器缺真实张量执行与常规训练闭环；外部训练骨架缺完整续训/评估/权重回导等管理功能。README 固定 50 万/200 万上限及“无 DataLoader”等描述已过时；当前动态容量和训练能力以源码为准。
- 极小离线实验确认：固定形状缩放 Attention 可导入，原生 ONNX RNN/LSTM/GRU 和动态非 batch 维被拒；现代训练 Dropout 被错误接受；BatchNorm 在 `no_grad` 下推理通过、梯度模式报错；真实导入器+真实生成表达式的 GELU 样例 `exact=true` 但最大绝对差 `0.00047326087951660156`。GELU 复现位于 `_dump/capability-audit/gelu_probe.py`、报告 `gelu-result.json`；未把局部探测冒充全应用端到端测试。
- 内置 AI 能组合现有接口、热加载自定义工具、编写/运行外部脚本；新算子或新训练语义要实现引擎支持、数值验证及必要的构建更新。建议优先修正确性与授权边界，再做算子扩展接口、真实计算后端和训练管理；本轮未启动这些开发。

## 2026-09-22：API 额度说明与模型选择入口

### 用户意图与额度边界

- 用户说明若要额外充值就暂时不处理 API，同时反馈设置中找不到自由选择模型的入口。本轮停止真实 API 测试；没有充值、重试余额错误或修改用户保存的凭证。
- ChatGPT／Codex 订阅剩余额度与 OpenAI Platform API 计费分开。上一轮的 `credit_balance_exhausted` 只描述这把 Key 所属组织的 API 预付余额，不能据此说用户的 ChatGPT／Codex 额度已用完。如果用户看到的确实是 API 可用余额，应先核对 Key 与账单所属组织，不能直接要求重复充值。
- 官方依据：[认证与 API 计费](https://learn.chatgpt.com/docs/auth)、[余额错误码](https://developers.openai.com/api/docs/guides/error-codes)。后续不得未经用户重新要求就继续真实 GPT-6 调用测试。

### 模型入口问题

- 原有下拉框混在本机服务配置中，未拉取列表时不显示当前模型；「拉模型列表」还会在当前模型不在返回清单时自动改成第一个模型，可能意外选中不适合聊天的模型。
- `prototype/template.html`：将「选择模型」下拉框、「刷新模型列表」按钮与「模型 ID」手填框移到设置最上方。当前模型无需联网即可显示；选择或手填后自动保存。候选来自用户当前接口，不保证其中每一个都是支持对话的模型。
- `prototype/src/main.js`：`aiSelectModel` 统一显式选择/手填保存，`aiRefreshModels` 只刷新候选、绝不自动改模型；当前模型未列出、空列表或失败时均保留。列表按接口和 Key 隔离，新增的列表来源快照仅驻内存，不另存一份 Key；请求序号与来源核验丢弃旧结果，后备请求不能借用新 Key。打开设置不自动请求模型接口。
- 修复原 HTTP 非成功响应被空桌面回退结果覆盖的问题；保留真实状态和错误，401/429 等不继续尝试第二个模型 URL。去掉本机探测后的自动选择首项，改由用户明确选择。
- `prototype/check_ai_settings.mjs` 新增 9 组行为回归，`tools/serve_gpt6_smoke.mjs` 增加两枚固定假 Key 的不同模型列表（其他凭证统一拒绝且不回显）；`tools/verify_gpt6_integration.mjs` 同步设置渲染模拟依赖。中英文 README 同步入口与计费说明。

### 验证与桌面更新

- 离线设置回归 **27/27**，覆盖选择/手填同步、刷新保留当前模型、空列表/失败、来源变更、乱序请求和中途改模型；独立复查通过。
- Responses 协议 **40/40**、最终 GPT-6 集成 **14/14** 通过；真实 Chrome 自检 **956/0**、会话与设置布局回归 **78/0** 通过。最终前端 esbuild/build 成功，17 个派生校验页刷新，状态 18 项与历史钩子 61 处守卫通过；`git diff --check` 通过。最终一次重新打包仅同步本机提示中的按钮名称，未改变上述行为。
- 同源构建浏览器实操：选择入口打开即显示；本机假列表首项不同于当前模型，刷新未切换；下拉选择同步模型 ID；手填不在清单中的模型后再刷新仍保留，重新加载仍保留；更换假 Key 清除旧候选，新列表只来自新凭证。页面无 JS 错误，没有向真实 API 发请求或操作用户工程。
- `npm run build` 成功生成 release exe 和 NSIS 安装包。单文件前端与桌面内嵌页面 SHA-256 同为 `E428464DCADA81B96EF3810199DFA597BF4943A69289466B7FC4FCF1F8893548`。
- **2026-09-22 18:26:08（UTC+08:00）已更新安装文件** `C:\Users\Administrator\AppData\Local\NeuroForge\neuroforge.exe`，SHA-256 与最终 release 一致：`7EB79BB9D858E4B609E3E378BCAD3B7644F2D14A1E44C754B41B9CFF7F8957BA`。
- 旧版备份 `_dump/backup-before-model-picker-20260922-182608/neuroforge.exe`，SHA-256：`1FFE54FEB61E587D51410DC082A8F74E304C6F69F768A6147ADFD290B72DE8EE`；安装目录内另保留 `neuroforge-before-model-picker-20260922-182608.exe`。没有关闭运行中的用户程序、修改账户配置或丢弃工程；保存工程、退出并从原快捷方式重新打开后生效。

## 2026-09-22：真实 GPT-6 调用检查与密钥弹窗说明

### 真实调用结果

- 用户已将桌面配置改为官方 `https://api.openai.com/v1/responses`、模型 `gpt-6-astra`，密钥非空且不是本地假 Key。没有输出、复制到日志或修改密钥。
- 通过本项目实际 `ai_responses.js` 构造请求，使用一个不修改工程的 `nf_ping` 工具、`reasoning.effort=low`、最多 2048 输出 token；用户保存的 `max` 档配置保持不变。
- Node 直连先遇到 `UND_ERR_CONNECT_TIMEOUT`，随后让诊断进程使用 Windows 已配置的系统代理；未更改系统代理。**18:06:42（UTC+08:00）开始的真实请求约 2773ms 返回 HTTP 429，错误码 `credit_balance_exhausted`**。官方说明是组织预付额度已无余额，需要在账单设置添加额度；不能据此宣称 GPT-6 已成功回复或工具调用已通过。
- 收到余额错误后停止，未发起第二轮工具结果回传，也没有重复重试额度错误。没有使用用户工程、聊天历史或执行工程工具。
- 诊断脚本与无密钥报告位于被 Git 忽略的 `_dump/gpt6-live-check.mjs`、`_dump/gpt6-live-check-result.json`。后续额度补足后可继续同一验证；脚本最多两次请求且无自动重试，运行前仍须确认用户要求真实测试。
- 此电脑的 Node 默认直连不使用 Windows 系统代理。复测需在诊断进程内把 `HTTPS_PROXY` 设为系统当前代理，再使用 `node --use-env-proxy _dump/gpt6-live-check.mjs`；不要把诊断工具的直连超时直接当成桌面 WebView 的网络结果。
- 参考：[OpenAI 错误码说明](https://developers.openai.com/api/docs/guides/error-codes)。

### 弹窗为何空白

- 用户确认空白的是点击「OpenAI GPT-6」后弹出的配置框，并非主设置页的 API Key 一行。该弹窗有意不预填已保存密钥，用于新填/更换凭证；取消不会删除原 Key。本次真实请求也使用了软件已保存的 Key。
- 为避免误解，补充“已保存 OpenAI Key、此框仅用于更换”的状态说明；仍不把旧 Key 或伪掩码填入弹窗。仅在当前主接口确为官方 HTTPS origin 且 Key 非空时显示已保存状态，其他服务不冒充 OpenAI 配置。
- `node prototype/check_ai_settings.mjs`：**18/18 通过**，新增官方接口已有 Key 的状态说明、取消保留、空应用不覆盖，以及无 Key/其他 origin 不误报检查。只使用假凭证。
- 隔离浏览器实操：用假 Key 应用官方预设，再次打开弹窗显示“已保存 OpenAI API Key”；输入框保持空白，取消后主设置页仍有密码圆点及已保存提示，页面无 JS 错误。未点击真实 API 测试按钮。
- 前端重新 esbuild 并生成 17 个校验页，设置 18 项、状态 18 项、61 处历史钩子检查通过。本次仅修改预设弹窗说明与对应回归，没有改动主设置回填、凭证保存规则或 API 调用逻辑。
- `npm run build` 成功生成 release exe / NSIS；**2026-09-22 18:12:03（UTC+08:00）已更新** `C:\Users\Administrator\AppData\Local\NeuroForge\neuroforge.exe`。新 exe SHA-256：`1FFE54FEB61E587D51410DC082A8F74E304C6F69F768A6147ADFD290B72DE8EE`，与最终 release 一致；前端页面和桌面内嵌页面 SHA-256 同为 `21275ACD2984A9CC205926743684CBB77E7B7DF21C594042AAD2AAB7DBF71724`。
- 旧版备份 `_dump/backup-before-key-hint-20260922-181203/neuroforge.exe`，SHA-256：`AB2FE971EC62465BA68DC08D931F5EA1B0B9D9D60749F914701FA2456123970E`。运行中的原 exe 保留为安装目录下 `neuroforge-before-key-hint-20260922-181203.exe`；没有关闭用户进程或改写账户配置。保存工程并重启原快捷方式后提示生效。

## 2026-09-22：官方 GPT-6 API 获取与连通性检查

- 已查阅 OpenAI 官方模型页与快速入门：模型 `gpt-6-astra`，本软件使用 `https://api.openai.com/v1/responses`，账户密钥由用户在 `https://platform.openai.com/api-keys` 创建并填入软件。
- 当前桌面设置仍是 `api.deepseek.com` / `deepseek-flash`；未发现 `OPENAI_API_KEY` 环境变量。仅输出服务商、模型与密钥是否存在，未输出密钥，也没有把 DeepSeek 密钥发给 OpenAI。
- 实际执行不带认证的 `GET https://api.openai.com/v1/models`，约 768ms 返回 HTTP 401；证明当时网络可达，**不代表账户认证或 GPT-6 模型调用通过**。
- 真实 GPT-6 调用尚待用户把自己的 OpenAI Key 填入软件。后续以最多两次简短请求验证无副作用工具调用、完整上下文回传及流式回复，不使用用户工程或聊天历史；完成后继续在此记录真实结果。
- 本轮没有修改程序或已有账户配置。

## 2026-09-22：AI 设置页被挤成细缝

用户反馈打开 AI 助手设置后只能看到一条缝，而且无法拉开。已在隔离浏览器页面复现：窗口为 1280×720、输入框有 30 行草稿时，设置区仅高约 38.5px，而输入栏占 235px、聊天区至少占 120px。

### 原因与修复

- 原设置、聊天和输入栏共用一个最多占视口 68% 的纵向 flex 容器。聊天的最小高度和输入框的自动增长挤掉设置空间；长历史记录会进一步加重。原界面没有 AI 面板拖高功能，也没有保存错误高度的问题。
- `prototype/template.html`：设置打开时独占面板内容区，暂时隐藏聊天与输入栏；外框高度最多 720px，并受当前视口限制，设置内容独立滚动。设置项不再互相挤压，窄窗口下标题按钮换行。
- `prototype/src/main.js`：`aiSetUI` 同步设置布局状态，关闭设置、折叠/展开、切换对话时恢复对应布局。聊天记录和草稿保留原内容，没有改动模型接口、Key 或本机操作权限。
- `prototype/make_sesscheck.mjs`：补充真实布局回归，覆盖长聊天、多行草稿、短视口、滚动到底、折叠展开与对话切换。

### 验证与交付

- 真人方式操作隔离浏览器：相同长草稿下，设置区域修复后高约 554px（可用内容高度 553px）；可滚动到最底部的「保存」按钮。关闭设置后，30 行未发送草稿完整保留，聊天及输入栏恢复，页面无 JS 错误。
- 桌面截图工具返回 `SetIsBorderRequired failed: 不支持此接口 (0x80004002)`，桌面可访问性树也没有提供应用内部控件。本轮 GUI 验证使用同源代码构建的浏览器页面；没有操作正在运行的用户工程。
- `node prototype/build.mjs` 通过：前端与 17 个衍生校验页刷新，设置 16 项、状态 18 项、61 处历史钩子检查通过。运行前已重新执行 esbuild；新增布局断言后单独重新生成会话校验页。
- `node prototype/run_checks.mjs --only=selftest,sesscheck`：自检 **956/0**，会话 **78/0**；其中新增 **23** 项布局断言覆盖 500 行聊天、220px 输入框及 360px 短视口。`git diff --check` 通过。
- `npm run build` 成功生成 release exe 和 NSIS 安装包。最终单文件前端与 `desktop/dist/index.html` SHA-256 一致：`3CA9F3AB0F47F864D12F8020FE33184E2FDAA637C0C9628A0DEFD27AE924792F`。
- **2026-09-22 17:54:52（UTC+08:00）已更新安装文件** `C:\Users\Administrator\AppData\Local\NeuroForge\neuroforge.exe`，SHA-256 与新 release exe 一致：`AB2FE971EC62465BA68DC08D931F5EA1B0B9D9D60749F914701FA2456123970E`。
- 旧版备份：`_dump/backup-before-ai-settings-20260922-175452/neuroforge.exe`，SHA-256：`3986CC1FDB7508DC57238FA753C7F947ACE751BC45F8F42A6CE12B1C2A2DB56B`。已校验备份一致，可在关闭软件后复制回安装位置回退。
- 更新时用户桌面程序仍在运行，**没有终止该进程或关闭工程**。原 exe 在安装目录内重命名为 `neuroforge-before-settings-20260922-175452.exe` 保留当前进程使用，再放入新 exe。当前窗口仍运行旧版；用户保存工程、退出并从原快捷方式重新打开后才生效。

## 2026-09-22：内置 AI 接入 GPT-6 Astra

用户明确要求让软件支持 GPT-6 并记录改动。本节接在前一轮 12 类审计修复之上；没有撤销上一轮改动，也没有更换用户已有 API 配置。

### 使用方法

1. 打开 AI 助手的「设置」，点击「OpenAI GPT-6」。
2. 在密码输入框填入自己的 OpenAI API Key，点击应用。取消则保持原配置。
3. 软件填入接口 `https://api.openai.com/v1/responses`、模型 `gpt-6-astra`，视觉接口跟随主接口。主 Key 不会沿用上一个服务商的 Key。
4. 可以点「测试连接」检查当前账户的实际访问权限与工具调用；此操作会调用配置的 API。正式使用仍需账户有该模型的权限和可用额度。
5. 思考强度支持 `low / medium / high / xhigh / max`；「跟随接口默认」不发送该参数，GPT-6 的「关」按 `low` 处理。GPT-6 请求不发送温度参数。

支持自行填写 Responses 网关地址；模型名为 GPT-6 时也会把旧 Chat Completions 地址转换为同一服务的 Responses 地址。网关本身必须支持 Responses。其他模型的既有 Chat Completions 路径继续保留。

### 实现与交接

- `prototype/src/ai_responses.js`：独立的 Responses 请求、消息/图片/函数工具转换与 JSON/SSE 响应处理。使用 `store:false`，在本机历史中保留后续工具调用需要的原始输出及加密推理项。
- `prototype/src/main.js`：请求路由、主接口和视觉接口接入、工具执行结果回传、会话存档恢复、连接测试。切换服务商或模型时不复用原 Responses 原始输出；发回 Chat Completions 时不夹带 Responses 专有字段。
- `prototype/src/main.js`、`prototype/template.html`：增加 GPT-6 设置入口和 `xhigh`，说明不适用的参数。预设仅在用户填入新的非空 Key 后应用，取消不改配置；不自动测试、不自动使用旧 Key。旧配置写入的迟到回包不能覆盖刚切换的新服务配置。
- 「拉模型列表」向与当前主接口同源的地址附带当前 Key；不同域名、协议或端口不携带该凭证。本机端口探测仍不附带凭证，桌面回退沿用相同请求头与既有地址限制。
- Responses 鉴权错误、请求错误或输出不完整时显示真实错误；不会以「不支持工具/看图」为由盲目降级，也不会执行截断的工具参数。
- 工具执行仍使用现有权限开关、确认与撤销机制；新增模型支持没有自动开启文件或命令权限。
- `tools/serve_gpt6_smoke.mjs` 是隔离的本地协议夹具，只接受固定假 Key，供真人操作界面联调；它没有调用模型，不能证明真实账户的 GPT-6 可用性。

### 验证与构建

| 验证 | 实际结果 |
| --- | --- |
| `node tools/verify_gpt6_protocol.mjs` | 40 项通过，0 失败：请求格式、历史/图片/工具转换、加密推理项、JSON、UTF-8 分片与 SSE、取消、截断、错误、桌面非流式返回。 |
| `node tools/verify_gpt6_integration.mjs` | 14 组通过：提取真实主程序函数接入协议模块，覆盖多轮工具、session 导出/恢复、旧 DeepSeek 请求、视觉路径、401、停止、连接测试及配置迟到回包。HTTP 和存储均为隔离模拟。 |
| `node prototype/check_ai_settings.mjs` | 16 项通过：预设应用/取消/空 Key/忙碌状态、旧默认配置、URL、七档思考强度与温度提示，以及模型列表同源鉴权、软件通道请求头和无凭证探测。 |
| `node prototype/build.mjs` | 前端与 17 个衍生校验页刷新；设置 16 项、上一轮状态 18 项、61 处历史钩子检查通过。此前已重新执行 esbuild。 |
| `node prototype/run_checks.mjs --only=selftest,sesscheck` | 最终 Chrome 自检 956/0，会话回归 55/0。七档思考强度的原有断言已同步更新。 |
| 真人方式操作浏览器测试界面 | 应用假 Key 预设后转到本机夹具；连接测试成功；SSE 工具往返确实把工程从 22 个神经元增加到 23 个；「看画面」请求包含图片并成功返回。刷新最终构建后配置保持，页面无 JS 错误。 |
| `git diff --check` | 通过。 |

本轮未使用真实 OpenAI Key 调用 GPT-6，因此不能据此保证用户账户权限、额度、网络或第三方网关兼容性。一次假 Key 请求返回了真实 HTTP 401，程序保留该错误；成功流程由隔离的本地 Responses 夹具验证。所有验证均未打开用户已有工程。

### 桌面更新与回退

- 2026-09-22 17:44:36（UTC+08:00）完成更新，替换前确认 NeuroForge 没有运行。`npm run build` 成功生成 release exe 和 NSIS 安装包。
- 已更新 `C:\Users\Administrator\AppData\Local\NeuroForge\neuroforge.exe`，复制后 SHA-256 与最终 release exe 一致；重新打开桌面快捷方式即可使用。
- 新 exe SHA-256：`3986CC1FDB7508DC57238FA753C7F947ACE751BC45F8F42A6CE12B1C2A2DB56B`。
- 旧 exe 已备份到 `_dump/backup-before-gpt6-20260922-174436/neuroforge.exe`，其 SHA-256 为 `2A438DD6B9FD9BE3F3E7071A2128D19940F0A8FFE4DAC6B18509145E32639177`，与替换前文件一致。这是上一轮审计修复后的版本；退出软件后可复制回安装位置回退。
- 最终单文件页面与桌面包前端 SHA-256 一致：`F0B533FCA70A45A1A8DA3F767667AC1839B291E96BBC0B3773161EA5B387F1E2`。源码、打包页面和已安装程序已同步。
- 界面实操使用独立本地测试地址，未启动已安装桌面程序做 GUI 复测。测试页面已关闭、本地夹具已停止；没有改写用户已有工程或桌面程序的 API 设置。改动尚未提交 Git。

依据：[GPT-6 官方迁移说明](https://developers.openai.com/api/docs/guides/latest-model)、[Responses 迁移](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[函数调用](https://developers.openai.com/api/docs/guides/function-calling)、[流式响应](https://developers.openai.com/api/docs/guides/streaming-responses)。

## 2026-09-22：审计确认的 12 类问题

本轮由用户明确授权修复。起点：`497f8d9`（第 72 轮），开始时工作区无未提交改动。
当前状态：12 类问题已修复，专项与现有回归通过，前端和桌面包已重建，已安装桌面程序已更新。改动尚未提交 Git。

### 改动范围

| 编号 | 原问题 | 修复位置及行为 |
| --- | --- | --- |
| 01 | 流式读块失败仍计为成功，重试跳过并可能保存残缺工程 | `prototype/src/main.js`：读块失败可重试；完整读入后才更新驻留计数，同块并发读取合并，过期读取不能污染新工程。 |
| 02 | 共享矩阵的不同子块使用同一共享组，保存时覆盖权重 | `tools/import_model.py`：共享键区分矩阵方向及切块位置，只共享对应子块。 |
| 03 | 激活后的常量加法被合入激活前 | `tools/import_model.py`：只向独占的线性层折叠偏置；已有激活时保留独立加法层。 |
| 04 | 循环模型仅有权重块的波次被跳过 | `prototype/src/main.js`：权重块不再依赖该波次是否有普通前向边。 |
| 05 | 可塑性小模型生成 Python 小写 `false` / `true` | `prototype/src/main.js`：使用 Python 可接受的冻结掩码字面量。 |
| 06 | 强硬抑制导出模型出现张量维度错误 | `prototype/src/main.js`：修正抑制掩码维度与设备，并验证输入、多个抑制源等场景。 |
| 07 | Gemm 标量偏置没有广播至全部输出 | `tools/import_model.py`：建层前广播偏置并验证长度，防止偏置列表被缩短。 |
| 08 | 池化省略 strides 时错误采用核大小 | `tools/import_model.py`：按 ONNX 默认步长 1 导入。 |
| 09 | 二进制偏置冻结标记读取错位；weight decay 仍修改冻结参数 | `prototype/src/main.js`：读取正确冻结分区，导出的训练入口保护优化器更新。详见下方外部优化器用法。 |
| 10 | 撤销没有恢复学习档位和强硬抑制 | `prototype/src/main.js`：历史保存并恢复 `nPlast`、`nHard`、`PLAST`，恢复后刷新缓存。 |
| 11 | 模块副本丢失学习属性、自环和分组归属 | `prototype/src/main.js`：保存学习档位定义、抑制与多组成员，实例化恢复合法自环，兼容旧模块。 |
| 12 | TCP / 串口把二进制内部的换行字节当帧边界 | `desktop/src-tauri/src/io_bus.rs` 和前端接口：按信号位数量确定完整帧长，保留半帧、拆分连在一起的多帧，发送使用完整写入。 |

### 使用与兼容注意

- 旧版已经错误写入的权重无法由代码更新还原；涉及共享子块或偏置的旧导入工程，应从原始 ONNX 重新导入。
- 外部自建 PyTorch 优化器需要调用 `net.protect_frozen(optimizer)`；导出的 `make_optimizer()` 会自动调用，保护冻结参数免受 weight decay 和动量更新影响。
- 冻结保护通过优化器 step 前后钩子工作。绕过标准 `optimizer.step()` 的手工参数更新不在保护范围内；在一次 step 内反复计算闭包的优化器可能在中间计算时读到临时变化的参数，本轮只验证了常规 SGD、Adam、AdamW。原 Parameter 与 state_dict 键名保持兼容。
- TCP / 串口的 `f32`、`i16` 为小端定长帧，每帧按信号位顺序各传一个值，不附加换行；双方信号位数量须一致。更改编码或信号位会关闭旧连接，需要重新打开。UDP 仍然一个数据报一帧，文本通道仍按原有规则分帧。
- 通道正在打开时更改配置，也会取消过期打开操作；后续打开等待旧连接清理。TCP 服务端遇到坏连接时继续向其他正常连接发送。
- 模块中以前没保存的学习属性无法自动补回，需重新封装原始子图。
- 学习档位表沿用文件格式的最多 255 项限制；满表时允许复用已有相同档位，新增档位会在修改图之前拒绝。
- 流式加载兼容旧 Python 编码器产生的尾部填充；检查最小有效长度及头部声明长度，不强求有效载荷恰好耗尽整块。

### 验证记录

以下均为实际执行结果，不表示已覆盖程序的所有输入或全部硬件环境。

| 命令 / 操作 | 结果 |
| --- | --- |
| `node prototype/check_audit_state.mjs` | 18 项通过：历史、模块、多组、自环、档位上限、流式失败/并发/会话隔离，真实旧样本全部 24 块。 |
| `py -3.13 -B -X utf8 tools/verify_audit_codegen.py` | 39 项通过：真实图分析与代码生成、PyTorch CPU/CUDA、ONNX 动态批次、冻结参数与 checkpoint。 |
| `py -3 -B -X utf8 tools/verify_audit_import.py` | 6 组通过：实际文件往返、2048×2048 共享分块、ONNX 参考执行器、标量偏置、矩阵转置、默认池化。 |
| `py -3 -B -X utf8 tools/verify_import.py` | 242 项通过。 |
| `node tools/verify_audit_io.mjs` | 8 项通过：帧长、残帧拒绝、配置修改、延迟打开取消及公开 API。 |
| `cargo test -- --nocapture`（`desktop/src-tauri`） | 6 项通过：二进制半帧/连帧/内部换行、旧文本、真实 TCP 回环、坏客户端不阻塞正常客户端。 |
| `node prototype/build.mjs` | 17 个校验页面刷新；状态专项及 61 处连接历史写入钩子检查通过。运行前已用 esbuild 重新打包。 |
| `node prototype/run_checks.mjs` | 首轮 17 页中 16 页通过，流式页暴露旧文件尾部填充兼容问题；修正后定向重跑 `--only=streamcheck,selftest`，流式 117/0、自检 955/0。其余页面没有相关改动。 |
| `py -3 -B -X utf8 tools/verify_bin.py` | 二进制权重、冻结标记、布局及前向执行通过。 |
| `py -3 -B -X utf8 tools/verify_codegen.py` | 13 项通过，包含 Python、ONNX 和 C 编译执行。 |
| `py -3 -B -X utf8 tools/verify_op.py` | 18 项通过。 |
| `py -3 -B -X utf8 tools/verify_plastic.py` | 可塑性规则及二进制导出执行通过。 |
| 浏览器界面实操（隔离测试地址） | 强硬抑制设置 → 撤销 → 重做恢复正确；封装模块 → 放置副本，副本保留强硬抑制。 |
| `git diff --check` | 通过。 |

复查中另发现并修正模块允许创建第 256 项档位的边界回归；新增满 255 项拒绝新增、允许复用的两项测试。最终重新生成前端和桌面包，并再次运行 `node prototype/run_checks.mjs --only=selftest`，955 项通过、0 失败。最终页面重新载入正常，浏览器未记录页面错误。

串口采用与 TCP 相同的分帧函数，但没有连接实体串口设备验证。性能页使用本机 RTX 3070 Ti，12 万神经元 / 599,335 条连接的现有测试通过。

### 构建与桌面更新

- 2026-09-22 17:19（UTC+08:00）完成最终构建与桌面程序替换；替换前确认 NeuroForge 没有运行。
- `npm run build` 成功生成 release exe 和 NSIS 安装包。`prototype/神经元编辑器原型.html` 与 `desktop/dist/index.html` SHA-256 一致，确认桌面包采用最终前端。
- 已更新：`C:\Users\Administrator\AppData\Local\NeuroForge\neuroforge.exe`；复制后 SHA-256 与最终 release exe 一致。
- 旧 exe 已备份：`_dump/backup-before-audit-fix-20260922-171935/neuroforge.exe`（已校验与替换前原文件一致；此目录被 Git 忽略，保留用于本机回退）。
- 新 exe SHA-256：`2A438DD6B9FD9BE3F3E7071A2128D19940F0A8FFE4DAC6B18509145E32639177`。
- 旧 exe SHA-256：`806545304D9F8167E4ABA35874E3EF7B39B4FE82ACC52D97926E903E3C903320`。
- 界面验证在独立本地测试地址完成，未打开或改写用户已有工程；未启动已安装桌面程序做 GUI 复测。

重建顺序（仓库根目录，PowerShell；每一步成功后再运行下一步）：

```powershell
.\prototype\node_modules\@esbuild\win32-x64\esbuild.exe prototype\src\main.js --bundle --format=iife --target=chrome110 --outfile=prototype\dist\bundle.js
node prototype/build.mjs
```

然后在 `desktop` 目录执行 `npm run build`。生成 `desktop/src-tauri/target/release/neuroforge.exe` 和 `desktop/src-tauri/target/release/bundle/nsis/NeuroForge_0.1.0_x64-setup.exe`。

### 后续对话接手

先阅读本日志并检查 `git status`，保留本轮尚未提交的改动。修改前端后必须先运行 esbuild，再运行 `node prototype/build.mjs`；桌面包需随后运行 `npm run build`（在 `desktop` 目录）。单独改源文件不会更新已安装桌面程序。
