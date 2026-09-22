# NeuroForge 问题与功能缺口交接文档

日期：2026-09-22。适用对象：接手修复的模型或开发者。

**本轮只审查、做离线合成实验、写文档，没有修改产品代码或安装文件。下面的待修问题尚未修复。** 之前已经修复的项目在 [FIX_LOG.md](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/FIX_LOG.md)，不能把两者混为一谈。

本文件是实施入口；模型类型覆盖矩阵见 [模型复现能力审查](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/docs/model-capability-audit.zh-CN.md)。本次覆盖编译/导入/导出、训练/状态、AI 工具/配置/权限；不是完整安全认证，也不是所有模型、硬件和交互组合的穷尽测试。

## 0. 接手须知

- 工作区：`C:\Users\Administrator\Documents\ChatGPT\神经元搭建程序`。大量改动尚未提交；先看 `git status --short`、本文件和修复日志，保留现有改动，禁止直接重置整个文件或回滚整个工作区。
- 本文行号对应审查时源码。后续改动会使行号漂移，应同时按函数名和代码特征定位。
- AI 接口协议、设置页尺寸、GPT-6 密钥弹窗说明、模型选择入口以及此前 12 类缺陷已有修复。下文只对仍存在的路径提出问题。
- 用户已表示暂不处理需要额外充值的 API 测试。本轮没有真实模型请求、充值、读取真实 Key、更改实际权限或打开用户工程。后续离线修复不需要真实 Key。
- 当前安装程序可能仍有旧进程在运行；不得为修复擅自结束用户程序。需要更新时先备份、记录构建版本，提醒用户保存工程后重启。
- “导入成功”“画面点亮”“编译成功”“数值推理一致”“可以按原算法训练”是不同层面的结论，要分别验收。

### 优先级与证据等级

- **P1**：应优先修复，涉及凭证/授权边界或常见训练路径不可用。
- **P2**：数值、训练或数据状态语义错误，可能影响结果但有明确触发条件。
- **P3**：文档/提示、防御性一致性或体验问题。
- **实测**：运行过真实相关函数或生成模型；具体边界在每项标明。
- **源码确认**：调用链和行为可从当前源码确定，尚未执行完整用户操作复现。
- **功能缺口**：能力未实现，不代表原先承诺过；与程序缺陷分开排期。
- **待验证**：有必要继续测试，不能当成已确认缺陷宣传。

## 1. 待修问题索引

| ID | 优先级 | 问题 | 验证程度 | 状态 |
| --- | --- | --- | --- | --- |
| B01 | P1 | AI 通用调用可请求打开本机文件/命令权限 | 真实前端函数 + 隔离假宿主实测；Rust 源码确认 | ✅ 已修（第 73–76 轮） |
| B02 | P1 | 配置备份恢复可能跨接口混用 Key | 真实前端函数 + 假凭证/假请求实测；Rust 源码确认 | ✅ 已修（第 73–76 轮） |
| B03 | P2 | 通用 API 修改绕过工具快照，无法保证撤销/失败恢复 | 真实函数隔离实测 | ✅ 已修（第 73–76 轮） |
| B04 | P1 | BatchNorm 统计量成为可训练参数，梯度模式前向报错 | 真实生成表达式 + 合成 Torch 参数实测 | ✅ 已修（第 73–76 轮） |
| B05 | P2 | 现代 ONNX Dropout 的训练输入被忽略，变成直通 | 真实导入器 + 合法合成 ONNX 实测 | ✅ 已修（第 73–76 轮） |
| B06 | P2 | 精确 GELU 被生成成 tanh 近似 | 真实导入器/表达式与 ONNX 参考数值对照 | ✅ 已修（第 73–76 轮） |
| B07 | P2 | ONNX 字面常量被优化器更新 | 真实导入、分析、生成模型及 Torch 一步训练实测 | ✅ 已修（第 73–76 轮） |
| B08 | P2 | 多算子共用的同一初始化器丢失参数共享 | 真实导入、分析、生成模型及 Torch 一步训练实测 | ✅ 已修（第 73–76 轮） |
| B09 | P2 | 内部记忆状态跨随机训练批次保留 | 源码确认；完整训练对照待补 | ✅ 已修（第 73–76 轮） |
| B10 | P2 | 编辑器连续输入与导出模型的状态保留方式不同 | 源码确认；跨运行时数值对照待补 | ✅ 已修（第 73–76 轮） |
| B11 | P2 | CrossEntropy 的普通整数标签不能按常规格式加载 | 见下文离线训练骨架实验 | ✅ 已修（第 73–76 轮） |
| B12 | P2 | 序列 CrossEntropy 未把类别维转换到正确位置 | 见下文离线训练骨架实验 | ✅ 已修（第 73–76 轮） |
| B13 | P2 | `source.exact` 不足以说明数值/类型/训练等价性 | 源码 + B05/B06/B08 实测 | ✅ 已修（第 73–76 轮） |
| B14 | P3 | README 容量和训练能力描述落后于代码 | 源码/文档对照 | ✅ 已修（第 73–76 轮） |
| B15 | P2 | 视角书签坐标校验不完整，跳转损坏相机状态 | 真实函数 + Three.js Vector3 隔离实测 | ✅ 已修（第 73–76 轮） |
| B16 | P2 | 桌面打包同步步骤允许过期前端进入新程序 | 真实同步脚本 + 临时假工程实测 | ✅ 已修（第 73–76 轮） |
| B17 | P2 | 外部视角书签坐标可注入持久化 HTML | 真实导入事件链 + 假 DOM/存储实测 | ✅ 已修（第 73–76 轮） |
| B18 | P1 | 直接新增学习档位突破格式上限，编号可回绕成 0 | 真实 UI/API/格式检查器隔离实测 | ✅ 已修（第 73–76 轮） |
| B19 | P2 | 删除自动保存后，旧的在途保存将其写回 | 真实异步函数 + 延迟编码/假数据库实测 | ✅ 已修（第 73–76 轮） |
| B20 | P1 | 普通打开损坏工程失败时，当前图已被部分覆盖 | 真实读取/应用函数 + 285 字节合成文件实测 | ✅ 已修（第 73–76 轮） |
| B21 | P2 | Python 读取器接受缺冻结标记的截断文件 | 公开 read/StreamReader + 470 字节文件实测 | ✅ 已修（第 73–76 轮） |
| B22 | P2 | Python 读取器接受矩阵形状与索引/权重数量矛盾 | 公开 read + 665 字节文件实测 | ✅ 已修（第 73–76 轮） |

上表的「已修」都指改动已落到工作区、且有对应回归跑过；逐项改动内容、触发条件与实测结果见 `FIX_LOG.md` 第 73–76 轮条目。


## 2. 问题详单

### B01 — 模型能通过公开 API 请求开启本机权限

**位置**：[run_api](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:21920)、[NF.aiConfig](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:21203)、[aiSysSync](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:21614)、[aiNeedsConfirm/aiExec](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:23665)、[nf_sys_allow](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/desktop/src-tauri/src/sys_exec.rs:78)。

**触发条件**：桌面宿主通道可用，AI 自动执行开启；文件/命令权限初始关闭。“大改动先问我”开启也不能保护这条路径。

**最小复现**：在隔离 VM 中加载真实 `aiExec`、`aiNeedsConfirm`、`run_api`、`NF.aiConfig`、`aiSysSync`，将 `SHELL_INVOKE` 替换为只记录调用的假函数；执行 `aiExec('run_api', {name:'aiConfig', args:[{sysFs:true,sysRun:true}]})`。详见第 5 节脚本，不要在真实用户窗口执行这段测试。

**预期**：模型工具只能使用用户授予的权限，无权自行提升授权；用户关闭的权限保持关闭。

**实际**：`sysFs/sysRun` 从 false 变成 true，假宿主收到 `nf_sys_allow({fs:true,run:true})`，确认次数为 0。Rust 接口直接写入权限原子变量。此实验没有真实宿主，因此没有授予实际权限；端到端桌面结果依据前端实测与 Rust 源码链路判断。

**影响**：默认关闭的开关不能作为独立授权边界；一旦走到此路径，后续本机工具所检查的权限可能已被模型自己打开。重启清空开关不能阻止本次运行中的问题。

**建议修复**：从模型可调用的 API 中移除权限授予能力，对 `run_api` 使用明确允许名单；宿主维护独立的用户授权状态，授予动作不能仅由普通页面脚本提交布尔值完成。同时审查自定义工具与其他可执行脚本入口，避免只禁一个函数名后仍可等价调用宿主。

**验收**：文件/命令开关关闭时，模型通过通用 API、自定义工具、配置修改等途径均不能授予权限；用户真实授权可正常使用；撤销授权立即对后续调用生效；普通图编辑工具不受影响。用假宿主/临时目录测试，不访问用户文件。

### B02 — 配置备份补 Key 没有绑定服务端地址

**位置**：[aiSaveCfg](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:21402)、[aiCfgBoot](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:21468)、[桌面 nf_cfg_write](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/desktop/src-tauri/src/sys_exec.rs:1217)、[aiModelsOnce](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:23177)。

**触发条件**：备份属于接口 A 且有 Key；当前或时间较新的配置属于接口 B，Key 为空。主配置和视觉配置都存在类似恢复逻辑。

**复现步骤**：

1. 在内存假存储中保存 A 地址和 `FAKE_PROVIDER_A_CREDENTIAL`。
2. 当前配置改为 `https://provider-b.invalid/v1/chat/completions`，Key 为空。
3. 调用真实 `aiSaveCfg(false)`；另一路用较新的 B 配置执行真实 `aiCfgBoot()`。
4. 用假 HTTP 接收器执行真实模型列表查询，检查请求地址与认证来源。

**预期**：B 的 Key 保持为空，或只从明确绑定 B 的备份中恢复；任何 A 凭证不得自动带到 B。

**实际**：自动保存与启动恢复把 A Key 填进 B 配置；真实请求函数随后向 mock B 携带了假 Key A。Rust 的 `force=false` 分支也会从当前文件/备份补空 Key，但不比较来源地址。只改前端一处不足以修完。

**影响及边界**：存在凭证跨接口发送风险；本次没有读取真实配置或发真实网络请求，**没有证据表明用户真实 Key 已经泄露**。明确填写新 Key 的 GPT-6 预设、前端 `force=true`、旧接口迟到响应拒收等已有保护仍有效，但不覆盖通用恢复链。

**建议修复**：为凭证保存来源绑定，恢复时比较规范化服务端 origin/服务商及需要区分的账户上下文；不能仅按 `model` 或配置时间推断归属。视觉凭证比较其实际地址 `visBase || base`。明确清空必须作为有效状态持久化，避免被旧备份复活。旧备份缺少来源证据时保持为空并提示重新填写。前端自动保存、启动合并、Rust 文件补齐三处一起修。

**验收**：A→B 空 Key 不回填；同来源合法恢复；视觉与主凭证独立判断；本地/磁盘当前与备份四份配置交错；Rust 两种补齐来源；强制清空并重启不复活；原有迟到响应保护、GPT-6 预设、同源鉴权和模型列表隔离回归继续通过。全用假凭证和 mock 端点。

### B03 — 通用 API 修改没有统一撤销/事务保护

**位置**：[run_api](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:21920)、[aiExec](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:23673)、[NF.setBias](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:20807)、[NF.defineTool](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:22565)。

**复现**：在与 B01 相同的隔离 VM 中调用 `aiExec('run_api', {name:'setBias',args:[[0],2]})`，对 `snapshot/unSnapshot` 计数。

**预期**：AI 的可撤销工程修改通过同一事务入口；失败能恢复，成功能一项撤销。

**实际**：偏置从 0 改为 2，`snapshot=0`、`unSnapshot=0`。`run_api` 没有 `mut` 标记，`aiExec` 只为有该标记的工具拍快照；`setBias` 本身不拍快照。自定义工具若未声明 `mut` 也有类似边界。并非所有 NF 方法都缺少内部保护，不能泛称每个 API 都不能撤销。

**建议修复**：为每个公开 API 声明只读/修改/外部副作用、参数校验、是否需确认等元数据，由通用调用统一执行。不要仅给所有 `run_api` 粗暴套图快照：读操作不需要，外部文件和命令也不能靠图快照撤销。修改函数抛错前的部分写入要可回滚。

**验收**：偏置/阈值/连接/分组修改一次撤销恢复原值；抛错恢复；只读调用不新增历史；直接工具与通用入口行为一致；明确说明外部文件/进程的恢复方式。B01 的权限控制不能依赖“操作可撤销”。

### B04 — BatchNorm 推理统计量被当成可训练参数

**位置**：[opBuffersCode](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8880)、[BatchNormalization 表达式](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8736)、[训练循环](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9722)。

**复现**：真实 `opExpr` 生成 `F.batch_norm(x,self.mean,self.var,self.scale,self.B,training=False,eps=0.00001)`；按照实际参数生成规则将四个浮点输入构造成 `nn.Parameter`，输入使用 `[2,2,2,2]` 合成张量。无梯度模式通过；普通梯度模式执行同一表达式。

**实际错误**：`The function 'native_batch_norm' is not differentiable with respect to argument 'running_mean'. This input cannot have requires_grad True.`

**预期**：running mean/variance 是运行统计量；需要训练的 scale/bias 才是可训练参数。支持再训练时应明确定义 train/eval 切换。

**影响**：带 BN 的导出网络可能无梯度推理正常，但普通训练前向立即报错；即使只把统计量改成 buffer，硬编码 `training=False` 仍不能提供正常 BN 训练。注意 `net.eval()` 本身并不等于 `torch.no_grad()`。

**建议修复**：建立参数角色，统计量注册为 buffer；明确 BN 训练模式、momentum、方差更新规则及原模型属性支持范围。推理图没有保存完整训练意图时，要说明再训练策略，不要凭空承诺恢复原训练过程。

**验收**：小 CNN+BN 在 grad 模式正常前向/反向/优化；eval 与 ONNX 参考数值一致；train 时仅预期统计量更新；eval 不更新；CPU/GPU、冻结权重、state_dict 保存加载一致。现有复现覆盖真实表达式及参数声明规则，尚非完整桌面导出测试。

### B05 — ONNX Dropout 第三输入的训练模式漏检

**位置**：[import_model.py Dropout 分支](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:1113)、[生成直通表达式](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8766)。

**复现**：合法 opset 17 图，`Dropout(X,ratio=0.5,training_mode=True)`，ratio 和 training_mode 都通过 initializer 输入，X/Y `[1,4]`；先用 ONNX checker 校验，再运行真实导入器。

**预期**：既然当前不支持训练 Dropout，应明确拒绝并说明；若决定支持，必须保留随机掩码、缩放和训练开关语义。

**实际**：被接受为 4 个直通神经元、0 个算子，且 `source.exact=true`。代码只找旧式 `training_mode` 属性，没有读取现代第三输入。

**建议修复**：按 opset 解析参数位置、缺省值和常量/动态输入；对不支持的训练模式拒绝。复查第二输出 mask，不能只处理第一个输出后声称完整支持。推理模式为 false 时转换为 identity 可以合理。

**验收**：省略或 false 模式正确直通；true 明确拒绝或具有正确随机行为；动态开关明确支持或拒绝；mask 输出得到正确处理/明确错误。不能要求随机 Dropout 每次与无共享随机源的另一实现逐位相同，应按固定测试掩码或统计/缩放规则验收。

### B06 — 精确 GELU 被替换为 tanh 近似

**位置**：[import_model.py GELU 检查](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:478)、[opExpr GELU](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8785)、[OP_FOLD](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8650)。

**复现**：opset 20，identity Conv→Gelu(`approximate='none'`)，X `[1,1,1,601]`，在 [-3,3] 取 601 个 float32 点。真实导入器接受，取得真实生成表达式，与 ONNX ReferenceEvaluator 对照。

**实际**：`source.exact=true`，但表达式为 `F.gelu(x, approximate="tanh")`；最大绝对误差 **0.00047326087951660156**。

**预期**：保留 none/精确 erf 模式；近似是用户或源模型明确选择，不应悄悄切换。误差小不等于语义相同。

**建议修复**：导入时保存模式，表达式及折叠激活都按模式生成；同步检查标量激活和各导出后端能否表达，不能只改一条字符串。若某后端仅支持近似，应拒绝或明确标记转换。

**验收**：none/tanh 分别对照；正负、零、较大输入及梯度；算子与融合路径一致；来源信息准确。现有实验覆盖导入器和实际表达式，不是全桌面导出管线。

### B07 — 字面常量进入优化器，训练改变计算定义

**位置**：[ONNX Constant 读取](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:908)、[op_refs_for](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:320)、[nn.Parameter 生成](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8880)、[make_optimizer](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9701)。

**复现**：合法 ONNX：`C=Constant([0.5]); Y=Mul(X,C)`，X/Y `[1,1]`。用实际导入器、`makeOp`、图分析、PyTorch 生成器和 model.bin 写出；运行生成模型，X=2，loss=sum(Y²)，SGD(lr=0.1) 一步。

**预期**：字面常量 C 保持 0.5，不在可训练参数集合中；若模型完全无可训练参数，训练入口清楚说明。

**实际**：C 成为 `requires_grad=True` 的 Parameter，从 **0.5 变成 0.099999994**。首次推理可以一致，训练后固定缩放规则变了。

**建议修复**：持久化参数 role/trainable 信息，区分字面常量、运行统计量与可训练权重；常量用 buffer。不能把所有浮点都改成 buffer，否则真实卷积/线性权重也无法训练。initializer 的训练策略需要明确，不能仅凭 dtype 决定。

**验收**：常量不出现在 named_parameters，优化前后不变；真实权重有梯度并更新；工程保存/重开、复制、撤销、模块封装和二进制导出后角色保持。

### B08 — 同一个源权重在多个算子里被复制为独立参数

**位置**：[共享 initializer 识别](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:858)、[op_refs_for](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:320)、[dense 共享路径](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:975)、[makeOp 参数复制](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:1664)、[参数分别生成](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8874)。

**复现**：一个 initializer W=0.5，被 `A=Mul(X,W)` 与 `B=Mul(X,W)` 共用；X=2，目标 `[0,2]`，loss=sum((output-target)²)，SGD(lr=0.1) 一步。实际导入、生成模型并运行。

**预期**：两个使用处绑定同一 W，两路梯度 +4/-4 抵消，W 保持 0.5，输出 `[1,1]`。

**实际**：导入来源 `shared=[]`、`exact=true`；生成两个不同对象/存储的 Parameter，更新成约 **0.1/0.9**，输出约 `[0.2,1.8]`。

**建议修复**：按源 tensor 身份保存别名关系，编译参数注册表复用对象；按数值相同去重是错误的，会把本应独立的权重绑在一起。转置/切片/布局变化应保留显式 view 关系，不能直接混绑。此前权重块的共享修复继续保留，本问题针对一般算子参数。

**验收**：以上梯度抵消；两个独立但初值相同的 W 仍可独立更新；多个使用处梯度正确累加；保存载入/编辑/复制共享规则明确；跨算子、权重块的共享情况分别覆盖。

### B09 — 内部记忆状态在随机训练批次间串用

**位置**：[前馈模型内部状态](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9510)、[循环模型内部状态](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8958)、[detach 更新](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9041)、[DataLoader/训练循环](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9729)。

**触发与复现方案**：构建有记忆/漏电等内部状态的模型，准备独立样本 A、B，设保留系数非零；比较“新模型直接计算 B”与“计算 A 后再计算 B”。再用相同 batch 大小和不同打乱顺序训练两批。此项目前为源码确认，完整数值对照尚待执行。

**实际路径**：`self.st` 只有为空或 batch 大小变化时初始化；DataLoader 使用 `shuffle=True`，训练批次间未复位。同一 batch 槽位的后一独立样本可能继承前一样本的内部状态。

**预期**：独立样本默认隔离；确需连续轨迹的训练应显式携带状态、定义序列边界，并保持轨迹与状态对应关系。

**建议修复**：提供 `reset_state/detach_state/step/sequence` 等明确接口；训练配置区分独立样本和连续轨迹，独立批次/epoch 按策略复位。不要把所有状态每步清零，否则真正的连续任务也失效。

**验收**：独立样本 B 的结果不依赖之前是否输入 A；需要连续记忆时可明确保留；batch 大小变化/最后不满批/设备迁移/序列结束时行为稳定；期望保留的状态与 checkpoint 策略一致。

**重要边界**：普通标量 RNN 的 `prev` 每个序列从零开始，与上述 `self.st` 不是同一个变量；不能说所有 RNN 都跨样本串状态。内部 `detach` 另意味着不具备完整跨时间梯度，这也是需要明确的能力边界。

### B10 — 编辑器连续信号与导出运行的状态策略不一致

**位置**：[runSimulation 初始化](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:14736)、[ifaceForward](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:15585)、[导出状态保留](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9510)。

**触发与复现方案**：相同的有状态网络，逐帧输入脉冲→零→零；分别走编辑器外部接口连续收帧、导出 PyTorch 连续 forward，并记录每帧状态/输出。源码显示编辑器每次模拟新建 `prev/st`，导出模型则保留内部状态，尚未完成跨运行时逐帧实测。

**影响**：界面验证的连续行为可能不代表部署结果；不能把“模型已在画布上模拟通过”当作同一状态机的数值验收。

**建议修复**：先写一份共同的状态推进/复位规范。编辑器区分单次预览与连续运行，接口帧触发使用选定模式；导出后端遵守相同规则或明确提示差异。

**验收**：相同输入序列、初态、步数在各后端产生容差内相同输出；显式复位后回到初始结果；编辑拓扑/切换工程不会复用旧状态。此项与 B09 有共同基础，但触发场景和测试不同。

### B11 — 分类训练不能加载常用的整数类别标签

**位置**：[load_dataset](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9678)、[统一 float32](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9682)、[目标形状要求](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9686)、[CrossEntropyLoss](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9714)。

**复现**：执行实际生成器中的 loader、optimizer、loss 和 train 片段，提供合成 NPZ。普通三分类 X 为 `(2,3)`、Y 为整数类别 `(2,)`；序列三分类 X 为 `(1,2,3)`、Y 为 `(1,2)`。

**实际**：普通标签被变成 float32 `(2,1)` 并报 `Y 的形状是 (2, 1)，但模型给的是 (样本数, 3)`；序列整数标签也被拒，要求三维目标。

**预期**：CE 支持常见整数类标，保留或转换为 long；也保留已有 soft targets 支持。

**建议修复**：按损失和标签模式选择 dtype/shape 校验；整数类别验证范围，soft targets 验证形状及需要的概率规则；不能不加区分地对 Y 强制 float32。

**验收**：普通 `(B,)`、序列 `(B,T)` 整数标签成功训练；普通 `(B,C)` 和序列 `(B,T,C)` soft targets 仍支持；无效类别/样本数/时间长度有清楚错误；MSE/L1/BCE 回归。

**实测边界**：普通 soft targets `(B,C)` 已作为对照用例通过损失、反传和一次实际训练更新，因此不能写成“CE 全部不能用”。神经网络部分为合成 logits 模型，数据和训练片段为真实生成代码，不是全应用导出复现。

### B12 — 序列 CE 没有转换类别轴，损失静默算错

**位置**：[循环输出布局](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9050)、[训练损失直接调用](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9742)。

**复现**：使用 `(B,T,C)=(1,2,3)` 的合成 logits 与同形状 soft targets，执行实际生成损失与训练片段；对照将最后一维作为类别的计算。

**预期**：类别轴 C 参与 softmax/交叉熵；应转换成 `(B,C,T)`，或将时间与 batch 展平为 `(B*T,C)` 并同步调整目标。

**实际**：CrossEntropyLoss 把第 1 维 T 当类别维。不会报错，但本用例实际 loss **0.4620981216430664**，正确 loss **0.7549853324890137**；最大梯度差 **0.07324957847595215**。

**建议修复**：在损失适配层统一类别维，整数标签和软标签分别处理；若有 padding/mask，明确有效 token 的平均方式。不可只修 loader 让标签通过，却保留错误轴。

**验收**：T≠C 和 T=C 两种情况都对照损失与梯度；单步、多步、不同 batch；普通分类不回归；序列整数/软标签分别通过真实 train 至少一个优化步骤。

### B13 — exact 标记把“没跳节点”与“完整等价”混在一起

**位置**：[source.exact](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:1273)、[Cast 提示](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:1097)、[精度提示](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:1205)。

**实际**：`exact` 主要由是否存在 skipped 算子决定。B05/B06 的语义改变、B08 的共享丢失都仍可能返回 true；部分浮点 Cast 仅作直通/精度提示，不等于执行了原 dtype 转换。

**影响**：接手者或用户若把 true 解读成输出逐位一致、梯度一致、共享关系保留，就会高估导入可靠性。若它本意仅是“结构未跳过”，应改名或限定说明。

**建议修复**：分别记录结构完整性、已知数值转换、dtype/opset/属性支持、训练参数/共享保留、执行对照是否做过及容差。未知标为未验证；近似或降级给出节点名和原因。不要把所有不完全支持的导入一律假装成功。

**验收**：本文件中的转换样例都产生准确报告；纯支持样例仍可通过；没有做参考执行时不声称“已验证数值等价”。f64 正常导出当前会被拒绝，不能误加一条“正常导出悄悄转整数”的缺陷，见第 4 节。

### B14 — 文档中的容量/训练说明过期

**位置**：[当前容量](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:248)、[已有 DataLoader](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9729)、中英文 README 的能力与限制章节。

**实际**：README 部分段落仍写固定 50 万神经元/200 万连接、无 DataLoader；源码已按需扩容，硬上限分别为 16,777,216 和 67,108,864，并确有训练 DataLoader。其他段落有更新，文档内部也不统一。

**建议修复**：统一真实能力表，区分硬上限、实测可用规模和硬件需求；明确 GPU 渲染与 GPU 训练不同，训练骨架不等于完整训练平台。不要把理论硬上限当性能承诺。

**验收**：中英文 README、AI 内置手册、界面提示与源码一致；模型支持名来自真实白名单，不从配色表推断；构建说明包含实际必需步骤，见 B16。

### B15 — 不完整的视角书签被接受并写入相机

**位置**：[viewsLoad](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:18143)、[viewGoto](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:18161)、[书签 JSON 导入](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:18220)。

**复现**：导入数组 `[{"name":"bad","px":0,"tx":0}]`，或让隔离假存储返回同样内容，再调用真实 `viewsLoad/viewGoto`。实际实验使用 Three.js `Vector3`，没有操作用户视角。

**实际**：仅验证 px/tx，py/pz/ty/tz 缺失仍进入书签列表。跳转后位置/目标 y 为 undefined，相机到目标距离为 NaN。完整界面还会对这些坐标执行格式化和渲染，后续表现需界面回归确认。

**预期**：所有 6 个坐标都必须为合法有限数值；拒绝不完整条目，不污染相机。

**建议修复**：导入、本机加载和公开跳转共用严格 validator，使用 `Number.isFinite` 并明确是否允许转换字符串；无效条目给出数量/原因。跳转前再次保护，避免外部 NF API 直接绕过。

**验收**：缺字段/null/字符串/Infinity/超大非有限值明确拒绝，合法负数/零坐标通过；失败不改变相机；历史合法书签可正常使用；书签字段作为界面文本安全渲染，不能仅补数字校验后忽略其他渲染来源。

### B16 — 桌面构建不会确认前端产物来自当前源码

**已修（第 76 轮）**：`prototype/buildinfo.mjs` 定义「源码清单 = `prototype/src/*.js` + `template.html`」的内容指纹；`prototype/build.mjs` 把 `src=<哈希> bundle=<哈希>` 写进成品页 `<head>`，另把逐文件哈希写进 `prototype/dist/build-manifest.json`；`desktop/sync_frontend.mjs` 同步前重算并按文件比对，对不上就拒绝（同时区分「旧产物没有指纹」「只跑了 esbuild 没跑 build.mjs」「成品被手改」）。新增 `prototype/build_all.mjs` 作为唯一完整构建入口，`desktop/package.json` 的 `build` / `check` 都先跑 `npm run frontend`。回归 `node prototype/check_b16_build.mjs`（9 项，全在临时假仓库里跑，不碰真实安装目录）。

**位置**：[desktop/package.json](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/desktop/package.json:9)、[sync_frontend.mjs](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/desktop/sync_frontend.mjs:12)、[prototype/build.mjs](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/build.mjs:15)、[README 构建说明](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/README.zh-CN.md:111)。

**复现**：在临时假工程中复制未修改的同步脚本，放入带 3 个必需标记的旧 HTML（mtime 2020），再放入更新的 main.js。执行同步脚本返回 0，旧 HTML 原样进入 desktop/dist。只执行了真实同步步骤，没有真的编译或安装 Tauri。

**实际路径**：`npm run build` 是 sync→tauri build，不执行 esbuild 或 prototype/build，也不比较源码与产物；同步只看少量字符串是否存在。`prototype/build.mjs` 的 bundle 时间检查只有显式运行该脚本时才有效。README 较前面的构建命令还省略了必须的 esbuild 步骤。

**影响**：程序编译成功也可能仍包含旧界面/旧修复，接手模型容易误以为改动已交付。本文不声称当前已安装版本过期，上一轮安装有独立哈希记录。

**建议修复**：建立一个真正完整的构建入口，按依赖顺序编译源码、生成页面、同步桌面、构建；或者在桌面入口强制检查含源码/依赖/模板的内容指纹。只依赖 mtime 仍会受复制、解压、时钟变化影响，建议产物清单绑定内容哈希。

**验收**：修改 main.js、导入模块或 template 后直接构建桌面必然包含变化，或明确拒绝旧产物；干净 checkout 有可执行的完整命令；构建记录含源码/前端/exe 对应版本；不用真实用户安装目录做测试。

### B17 — 外部书签可以把标签持久化注入界面

**位置**：[导入字段检查与复制](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:18233)、[坐标 HTML 拼接](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:18197)、[innerHTML 赋值](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:18206)、[本机加载](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:18144)。

**复现**：以实际 `openViewPanel()` 的 click→change→FileReader.onload 链，导入 `{"px":1,"tx":0,"py":"<mark>AUDIT</mark>","pz":3,"ty":0,"tz":0}`。使用假 DOM/FileReader/存储，只记录渲染结果；保存后再执行真实 viewsLoad 并打开面板。

**实际**：py 的原始标签进入 `dlgBody.innerHTML`；pz/ty/tz 同样可触发，重载后仍保留。name 已转义，但这些所谓“数值字段”既没严格检查也没转义。

**影响与边界**：导入外部 JSON 后可以改变书签界面的 HTML。未执行脚本载荷，也未验证最终桌面 CSP，因此**已确认的是持久化 HTML 注入，不是已实证的任意脚本执行**。它与 B15 共享输入校验根因，但渲染输出还需独立保护。

**建议修复**：六个坐标严格有限数字校验；渲染使用 textContent 或统一转义，不信任存储中历史条目。逐个修字段不如统一序列化/校验和 DOM 构造规则。

**验收**：六个字段分别放标签、字符串、null、数组、缺失值都不能进入 HTML；旧存储加载也安全；合法数字书签的导入、保存、重载和跳转继续正常。后续若验证脚本执行风险，限于隔离测试应用和无害标记，不使用用户配置。

### B18 — UI 和脚本直接新增学习档位仍可突破上限

**位置**：[学习面板新增](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:16892)、[NF.plastAdd](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:20510)、[NF.setPlast](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:20528)、[格式检查](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:12870)、[档位表编码](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:12315)。

**复现**：合成包含 255 项的 PLAST.list，执行真实学习面板“新增一档”处理器；列表增至 256 项。继续新增到 ID=256，对合成神经元执行真实 setPlast。

**实际**：格式检查器返回“可塑性档位超过 255 档”；编码器却会写整个超限表。ID=256 的赋值返回 true，Uint8Array 实际保存为 0，即固定不学习。此前模块复制路径已经加上限，不覆盖这里的 UI/API 新增入口。

**影响与范围**：可以通过正常新增生成不符合当前格式校验的状态，流式打开路径会拒绝；过大编号还会静默变成其他档位。普通打开路径未统一调用同一索引检查，不能从这项实验断言所有打开方式都会拒绝。

**建议修复**：所有创建入口共用容量限制，按当前格式最多 255 项（包含固定档位）；赋值检查可表示范围。若决定扩展容量，需要升级文件格式和神经元字段位宽及迁移，而不是删掉检查。

**验收**：边界 254/255 项，满表新增无任何修改；UI、NF API、AI、模块复制/导入都一致；ID 越界明确失败不回绕；合法档位工程正常/分块/流式保存读取往返一致；保留既有模块复制修复。

### B19 — 删除自动保存后，旧任务将其重新写入

**位置**：[autosaveRun 等待编码/写库](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:11021)、[autosaveForget](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:11163)。

**复现**：真实 autosaveRun 中将编码替换为可控延迟 Promise；编码进行时调用 autosaveForget，确认假数据库 `last` 已删除；再释放此前的编码任务。

**实际**：删除返回 true、记录立即消失；旧保存完成后又写回 `last`。删除没有使在途保存失效。全部在内存假数据库中验证，无真实自动保存被改动。

**预期**：用户删除成功时，删除之前已启动的任务不得把同一记录复活；之后的新编辑是否自动保存应遵从界面明确策略。

**建议修复**：为保存设置世代/取消标识，删除提升世代，提交前核验；或用明确任务队列保证删除在旧写入完成后生效。清理相关定时器和可见状态，区分此前任务与之后新编辑。

**验收**：在编码前/编码中/写库中分别删除；删除成功后旧任务结束仍无记录；后续新编辑能正常保存；失败提示和“是否有保存”显示一致。补测关闭自动保存和切换工程时的同类竞态，但未经验证不要直接列为已确认问题。

### B20 — 打开损坏文件不是原子操作，错误后当前图被改坏

**位置**：[nforge3Apply](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:12464)、[提前清空名称/分组](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:12491)、[分块直接写全局数组](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:12508)、[普通打开入口及 catch](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:14061)。

**复现**：285 字节合成 nforge，声明两个神经元块；第一个完整并含 x=123，第二个只有 4 字节，不能提供声明的坐标。旧图设 x=9、一个名字和一个分组。调用真实 nforge3ReadHeader/nforge3Apply，界面/容量辅助使用替身。

**实际**：第二块抛 `Invalid typed array length: 3`；此前 x 已从 9 变成 123，名称和分组已清空。普通 FileReader 打开入口直接调用这条应用函数，catch 仅 toast，未回滚。

**预期**：打开失败应保留完整原工程，包括名字、分组、算子/块、历史、选择与接口等相关状态；文件错误不能导致当前未保存工作部分丢失。

**建议修复**：在提交前完成必要的头/索引/范围/块长度/解压与语义验证；加载到独立状态，全部成功后一次提交，或建立可靠回滚事务。大模型场景应控制内存峰值，不能简单地无条件复制整个工程两遍。普通、分块、自动恢复和 AI 打开入口共用安全加载流程。

**验收**：第二块/后期权重块/算子/扩展区故意损坏，失败后旧状态哈希与各附属表一致；成功载入仍正常；取消/超时也不部分覆盖；模拟内存分配/解压失败；已有流式迟到回包保护保持。

### B21 — Python 公共读取入口接受截断的尾部标记

**位置**：[decode_chunk](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/nforge.py:1220)、[StreamReader.chunk](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/nforge.py:1281)、[read](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/nforge.py:1383)。

**复现**：先用真实 nf.write 生成 2 神经元、1 条冻结边的 raw 文件，再把文件截断到 elock 开始处。470 字节样本经 `nf.read` 与 `StreamReader.chunk(0)` 读取。

**实际**：`check_index(header)` 返回空错误列表；公开读取返回 1 条边，但冻结标记长度为 0，两条读取路线都未拒绝。内存切片在末尾不足时静默缩短，解码没有核对实际字节/字段长度。

**预期**：文件物理长度不满足必需字段时立即明确报错，不能返回内部数组长度不一致的工程。

**建议修复**：读满声明压缩长度；解压后验证最低必需长度与字段完整性；拒绝未知 codec、非法计数/偏移及越界。保持已确认的旧文件末尾对齐填充兼容：缺少可选填充与缺少真实冻结字节不同，不能统一要求所有旧文件等于新 padded total。

**验收**：每个字段边界前后截断、raw/deflate、完整/流式读取都一致拒绝；无冻结值但格式仍要求 elock 的文件也验证长度；合法旧版未填充文件仍可读。此项确认为 Python 工具链，不外推为桌面绕过。

### B22 — Python 权重块的内部计数与实际形状不一致仍通过

**位置**：[decode_blocks](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/nforge.py:313)、[按头计数切数组](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/nforge.py:326)、[形状与权重重建](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/nforge.py:364)、[read_block_region](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/nforge.py:535)。

**复现**：用 nf.write 生成一个 1×1 权重块的合法文件，把块内第一项 k 从 1 改为 2，但保留 sumK=1、totalW=1。665 字节文件经公开 nf.read 读取。

**实际**：`check_index(header)` 不报错，返回矩阵形状 2×1，src 和权重却都只有 1 个。按头声明检查总字节长度不足以发现内部矛盾。

**影响**：下游 reshape/索引/重写时才暴露错误或产生不一致状态，公共读取 API 没有履行完整验证。桌面 makeBlock 有后置校验，本轮未证明能在桌面成功接收。

**建议修复**：将逐块 k/n 的和、非共享实际权重数、共享引用形状与头计数对照；校验索引范围与冻结标记长度。共享块不能简单把所有 k*n 相加当存储权重数，要按引用布局计算。

**验收**：错误 sumK/sumN/totalW、截断、坏引用及不同形状共享都明确拒绝；合法共享/分段/旧格式仍通过；Python 与桌面使用同一格式不变量或一致对照测试。

## 3. 功能缺口与开发验收

下面是功能建设项，不全部属于“程序出错”。先解决上面的正确性问题，再选择具体模型目标逐步补齐。不要让接手模型一次重写所有后端。

| ID / 缺口 | 当前边界与位置 | 建议实现范围及验收 |
| --- | --- | --- |
| F01 算子库不完整 | `main.js` 的 `OP_TYPES`（7888）、`validateOp`（8792）、`opExpr`（8689）只实现有限集合；配色表里的额外名字不是支持证据 | 建统一算子注册表，覆盖属性、形状、dtype、前向/梯度、序列化和后端；每个新算子给正反样例及参考数值测试。先选代表模型需要的 Gather/Embedding、Resize/ConvTranspose 等，不只增加下拉框名称。 |
| F02 动态形状与控制流 | `import_model.py:103/239` 对非 batch 维要求静态；没有通用 If/Loop/Scan、可变长度张量计划 | 把符号维、shape 运算、控制流语义纳入中间表示与导出；短/长序列、空维、跨分支对照，不能把动态维悄悄固定成 1。当前动态 batch 与动态序列不是一回事。 |
| F03 LSTM/GRU 与张量循环 | 原生 ONNX RNN/LSTM/GRU 合成图被拒；`main.js:7877/8288` 拒绝算子/权重块卷入循环 | 可先做显式状态输入/输出的原生单元；验收多时间步、共享门权重、隐藏状态/细胞状态和梯度。固定步数外部展开只是转换方案，仍需验证共享及规模。 |
| F04 编辑器缺真实张量执行 | `main.js:14572` 算子仅依据输入就绪点亮，输出不参与标量传播 | 提供真实执行后端（可研究独立 PyTorch/ONNX Runtime 进程），展示输入/中间张量/输出；UI 图与执行版本绑定，取消/超时/错误可回收。用小 CNN/Attention 与导出模型数值对拍。 |
| F05 训练缺完整软件闭环 | `main.js:10532` 训练页主要配置导出的骨架；现有局部 Hebbian/STDP 不是常规损失反传 | 完成数据→训练进程→指标/曲线→停止/失败恢复→模型产物流程；关闭对话不能被误认为停止训练，进程状态要可见。用小模型在 UI 内完整跑通。 |
| F06 数据/预处理适配有限 | `load_dataset`（9678）一次加载 NPZ，通用 tokenizer、图像处理、变长序列、掩码/采样策略不是现成流程 | 数据适配器与模型输入契约，预处理可保存/复现；训练与推理预处理一致；大数据不要要求整份驻内存。分别验收图像、序列和类别标签。 |
| F07 验证集与训练管理 ✅ **已实现（第 77 轮）** | 现在是：`val_split` / `val_every` 划分并计算验证集，`evaluate` 给损失 + 指标（ce→准确率、mse→MAE），划分不出来时明确报错；`scheduler`（none / cosine / step）、`grad_clip`、`--history` 写 JSON、`log_every` 控打印。骨架原有 DataLoader、autograd、CPU/CUDA、Adam/AdamW/SGD、MSE/L1/BCE/CE | 先实现 train/validation 分离、损失/指标、配置记录、可重复种子；高级训练特性按需求分批补。不要重复“软件没有 DataLoader”的旧结论。 |
| F08 完整断点续训 ✅ **已实现（第 77 轮）** | `save_checkpoint` 现在写完整检查点（权重 + 实际生效的 cfg + 轮次 + 每轮记录 + best + 优化器 / 调度器状态 + 随机数流 + 内部状态）；`load_checkpoint` 先恢复完再返回，结构对不上明确拒绝、不半加载，旧格式仍能读；`--save` / `--resume` 走这条路 | 保存实际生效的配置、训练进度、优化器/调度器及随机状态，定义内部记忆是否持久化；中断续训与连续训练对照。只加载权重不是恢复训练。 |
| F09 训练权重回填编辑器 ✅ **已实现（第 78 轮）** | 现在是：生成的 PyTorch 脚本带 `--export-weights weights.json` （导出每条连接的权重 / 偏置 / 权重块矩阵 / 算子可训练参数）；编辑器侧 `weightsApply` 把它灌回图（编译菜单「回填训练权重...」/ 训练页 / 工具 `weights_import` / `NF.weightsApplyText`），关系稳定 ID 是每条连接的 (源, 目标) 神经元编号而不是编译下标（编译会按波次重排）；安全靠**结构指纹**（只由结构算出的 sha256，权重 / 阈值 / 偏置 / 冻结标记不进指纹）：指纹、连接数、形状对不上都明确拒绝且绝不半填；冻结的连接 / 神经元默认跳过（`force=true` 才覆盖）；整件事是一个撤销格；权重里有 NaN / Inf 时导出那一步就报错（避免写出非法 JSON）。回填结果经 `tools/verify_weights_roundtrip.py` 五个夹具（前馈 / 循环 / 有状态 / 权重块 / 算子）对账：指纹一字不差、每条边序相同、数值按 float32 逐位相同、填回去后前向逐位相同 | 使用稳定 tensor/参数 ID、拓扑版本和形状验证，保留共享/冻结/常量属性；训练后回填与外部模型预测一致，错模型/错版本拒绝，支持撤销和备份。 |
| F10 不同导出目标能力不统一 | C 生成器（9970）拒绝算子节点和权重块且主要推理；当前 ONNX 导出（10319）未完整表达持久内部状态/在线可塑性 | 明确后端能力矩阵；统一中间表示后逐项实现，无法表达就明确拒绝。循环/状态可研究显式状态 I/O；不能说 ONNX 这种格式本身绝对不支持状态表达。 |
| F11 模型文件类型有限 | 通用导入器入口 `import_model.py:1388` 只接 ONNX，不直接重建任意 `.pt/.safetensors/GGUF` 完整图 | 针对格式选择“加载参数”或“恢复架构”的明确范围；文件含权重不保证含可执行拓扑。为适配器建立版本/来源/安全反序列化策略，用实际格式样本验收。 |
| F12 LLM 完整推理系统 | 固定形状缩放注意力子图已导入成功，但不是完整大语言模型；缺完整 tokenizer、KV cache、mask/位置编码/采样工作流等组合支持 | 按一个小 Transformer 建端到端基线，先数值对拍再增量解码；对照 prefill/decode 和 cache reset、不同序列长度。不能把“Attention 全不支持”或“有 MatMul 就支持任意 LLM”写进文档。 |
| F13 扩散/GNN/RL/GAN 完整流程 | 部分子网可搭；MuJoCo 桥提供观测/动作/物理通信（`tools/bridge_mujoco.py:558`），不是 PPO/SAC 训练器 | 扩散需调度/去噪循环；GNN 需索引聚合/图批处理；RL 需奖励/轨迹/经验及算法；GAN 需多优化器交替更新。每类选一个明确小任务，不能用同一“网络能连线”标准验收。 |
| F14 SNN 梯度与状态 | 有硬脉冲/局部可塑性；内部状态更新 detach，硬阈值没有通用替代梯度 | 明确事件仿真、局部规则训练或可微 SNN 哪种目标；若加替代梯度，定义时间离散/复位并给梯度对照。普通 RNN BPTT 现有支持不等于 SNN 也完整支持。 |
| F15 大模型资源管理 | 动态容量不是实际可运行规模；权重块省显式边但仍消耗参数内存；部分流式工程被 `main.js:8120` 拒绝编译 | 增加内存/时间预估、分阶段处理、取消与错误恢复；真正的大模型需要计算计划与外部执行。记录真实机器的峰值内存、载入/编译/训练耗时，禁止拿硬上限作实测结果。 |
| F16 内置 AI 扩展隔离 | `NF.defineTool`（22565）经脚本注入运行自定义 JS，reload（22609）在页面上下文执行；有外部文件/命令/任务能力 | 现有工具可组合操作、生成外部 Python；新引擎能力仍要开发和重建。增加代码审查/来源、受限 API、隔离工作目录、任务停止/回收与版本记录。必须先修 B01/B02，不能让模型自授权限作为扩展方案。 |

### 内置 AI 可以怎样帮忙

1. **已有能力的组合**：批量搭网、参数配置、生成训练代码、自定义工具，可以在现有接口上实现。工具安装成功并不证明数学结果正确。
2. **外部程序**：可编写数据处理/训练/评估/复杂采样脚本；需要用户明确的本机授权、环境依赖、进程管理及输出回导。外部脚本运行成功并不代表编辑器新增了原生算子。
3. **软件开发**：新算子、动态形状、训练后端、保存格式等要实现源码、迁移旧工程、回归测试和构建交付。本文件提供问题与验收，适合让其他编码模型逐项处理。

## 4. 排除的误报、未完成验证与后续检查清单

### 已排除或应保留的行为

- **f64 正常导出没有证实静默转整数**：虽然 `makeOp` 接受 f64，底层参数 helper 存在分类不一致，`analyzeGraph`（8273）和 `buildArtifacts`（10316）已拒绝正常编译。合成实验确认该拦截。可对 helper 再加防线，不能把绕过分析器直接调用 helper 的输出当作用户正常导出结果。
- **固定形状 Attention 不是完全缺失**：合成 Mul/Mul/Transpose/MatMul/Softmax/MatMul 图已被接受。某些原始 Group 输入路径仍受限，应按路径测试。
- **CE 不是全坏**：普通二维 soft targets 已通过实际训练片段；缺陷是整数标签适配和序列类别轴。
- **无梯度 BN 推理不等于训练也通过**；反过来，训练失败也不说明每次推理都失败。
- **Key 弹窗空白不等于没有保存**：此前 GPT-6 预设弹窗故意不预填旧 Key，并已有保存状态说明；本轮 B02 针对自动恢复逻辑，不是撤销这项设计。
- **当前安装更新状态以 FIX_LOG 的哈希记录为准**；B16 是构建流程缺口，不证明当前 exe 一定包含旧内容。
- **现有默认权限关闭、命令黑名单不是完整沙箱**；明确授权后能执行命令本身属于设计能力，不另算漏洞。真正的问题是授权能否被模型绕过和扩展代码是否隔离。

### 仍应验证的领域（不是已经发现的缺陷）

| 领域 | 下一轮具体检查 | 为什么未给“通过”结论 |
| --- | --- | --- |
| 大文件与格式健壮性 | 截断、长度溢出、重复 section、索引越界、压缩损坏、编码版本、流式/完整加载一致性 | 本轮只做少量小合成文件，未完整 fuzz 所有版本。 |
| 自动保存与恢复 | 切工程时迟到保存、断电、磁盘满/IDB 配额、多个窗口、损坏快照恢复、关闭时未完成写入 | 不在用户真实存储做故障注入；需要隔离 profile 与虚拟时钟。 |
| 编辑与历史 | 混合权重块/算子/多组/模块的复制删除、撤销重做、异步任务期间切换工程 | 此前 12 类修复有回归，但不代表所有组合已覆盖。 |
| 外部通信 | 串口/TCP 重连、客户端恶意长度、并发关闭/重开、端口修改、积压和背压、文本编码 | 之前二进制分帧已修；本轮没有连接真实硬件或长期 soak。 |
| 任务/进程生命周期 | 取消是否杀整个子进程树、超时回收、退出/重启遗留进程、输出截断、并发任务上限 | 不能从“停止聊天”推断后台进程终止；需合成短进程测试。 |
| 权限与数据保密 | HTTP 重定向认证、视觉/主端点回退、代理错误、日志/导出是否带 Key、旧配置迁移、自定义 JS 能力边界 | 本轮确认 B01/B02/B17，未验证所有数据流，也未读取真实 Key。 |
| 数值与导出 | 每种算子的属性/opset/dtype/广播、NaN/Inf、空张量、GPU/CPU、梯度/共享/冻结、ONNX/C 对照 | 少量算子通过不能外推整个算子库；量化/剪枝等现有代码路径需另测，不应说它们不存在。 |
| UI 与可访问性 | 小窗口、缩放/DPI、多显示器、键盘焦点/快捷键冲突、长名称、中文/英文切换、错误提示可操作性 | 先前设置页已有浏览器回归；本轮没有全面真人桌面交互遍历。 |
| 性能与稳定性 | 代表规模载入/编辑/布局/保存/编译的峰值内存、帧率、取消响应、长会话内存增长 | 为保护当前工程和控制审查成本，未做大内存/长时间压测。 |

这些条目可变成下一轮测试任务。只有复现或清楚证明可达后再升级为新的 B 编号，不能为了数量把猜测写成漏洞。

## 5. 离线复现材料与执行方法

所有路径相对仓库根；在 PowerShell 中先切到本项目。脚本仅使用合成模型/文件、假凭证或假宿主，不需要真实 API，也不需要打开用户工程。损坏的 nforge 文件是故障夹具，交给隔离探测脚本，不要拿当前有未保存工作的应用窗口直接打开。

环境实测：Node v24 系列；Python 环境含 PyTorch 2.7.1+cu118、NumPy 2.4.6、ONNX 1.22.0。具体可用解释器以本机为准；不要为了复现自行升级用户依赖或触发大下载。视角探测还复用现有 `prototype/node_modules/three`。

| 关联问题 | 从仓库根执行 | 结果文件 |
| --- | --- | --- |
| B01/B03 权限/撤销 | `node _dump/capability-audit/permission_probe.mjs` | `_dump/capability-audit/permission-result.json` |
| B02 Key 归属 | `node _dump/audit_cfg_provider_binding.mjs` | `_dump/audit_cfg_provider_binding_result.json` |
| B04/B05 BN/Dropout | `py -3 -B -X utf8 _dump/capability-audit/training_ops_probe.py` | `_dump/capability-audit/training-ops-result.json` |
| B06 GELU | `py -3 -B -X utf8 _dump/capability-audit/gelu_probe.py` | `_dump/capability-audit/gelu-result.json` |
| B07/B08/f64 边界 | 按下面的三条命令顺序执行 | `_dump/param_semantics/torch_results.json`、`f64_result.json` |
| B11/B12 CE | `py -3 -B -X utf8 _dump/capability-audit/repro_cross_entropy.py` | `_dump/capability-audit/cross_entropy_result.json` |
| B15/B16 书签/构建 | `node _dump/capability-audit/ui_build_probe.mjs` | `_dump/capability-audit/ui-build-result.json` |
| B17 书签 HTML | `node _dump/audit_view_html_injection.mjs` | `_dump/audit_view_html_injection_result.json` |
| B18/B19 档位/自动保存 | `node _dump/capability-audit/repro_state_edges.mjs` | `_dump/capability-audit/state-edges-result.json` |
| B20 加载原子性 | `node _dump/capability-audit/load_atomicity_probe.mjs` | `_dump/capability-audit/load_atomicity_result.json` |
| B21/B22 Python 文件读取 | `py -3 -B -X utf8 _dump/capability-audit/file_parse_probe.py` | `_dump/capability-audit/file_parse_result.json` |

参数语义探测依赖现有 `tools/generate_audit_codegen.mjs` 的生产函数提取器，按序执行：

```powershell
py -3 -B -X utf8 _dump/param_semantics_probe.py --fixtures
node _dump/param_semantics_probe.mjs
py -3 -B -X utf8 _dump/param_semantics_probe.py
```

补充细节：[参数语义探测说明](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/_dump/param_semantics/HANDOFF.md)、[文件解析探测说明](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/_dump/capability-audit/FILE_PARSE_HANDOFF.md)。B09/B10 仍需补真正的状态序列对照，不能把未执行的步骤记成实测通过。

**探测脚本不是修复后的回归断言。** 其中部分脚本恰好断言旧缺陷仍存在，修复后报“expectation changed”可能是预期现象。接手者应保留旧证据、转换为断言正确行为的正式回归，并记录新输出。它们按源码标记提取函数，重构后需要调整提取方式；不能让提取失败被误认为功能失败。

`_dump` 被 Git 忽略。交接包会保留本轮选择的脚本和结果，避免换任务/复制项目时遗漏；包不含完整产品源码、依赖或真实用户数据，重跑仍需对应的项目工作区。

## 6. 推荐修复顺序与既有回归

1. **先保护用户数据与凭证**：B01/B02/B20，连同 B17 输入/输出保护。做到授权不可由模型提升、凭证不串源、打开失败不损坏原图。
2. **修格式与异步一致性**：B18/B19/B21/B22，加 B03 的统一事务入口。避免只改一个入口、另一个入口继续绕过。
3. **统一参数角色与来源身份**：一起设计 B04/B07/B08，但分小批提交验证，覆盖旧文件默认策略。随后修 B05/B06 与 B13 的报告。
4. **修训练与运行状态**：B11/B12 标签/损失，B09/B10 状态协议；逐项做输出与梯度对照。
5. **补交付和用户体验**：B15/B16/B14。稳定后再按 F01–F16 选择具体功能，优先完整跑通一个小 CNN 和一个小 Transformer。

### 接手时保留的已修基线

上一轮 FIX_LOG 记载的 12 类修复包括：流式失败/并发/跨工程隔离、共享矩阵子块、激活后常量加法、循环权重块、可塑性 Python 字面量、强硬抑制形状、Gemm 标量偏置、池化默认 stride、冻结标记/优化器保护、撤销恢复学习字段、模块保留学习/自环/分组、TCP/串口二进制分帧。其后的 GPT-6 Responses、设置布局、密钥提示、模型选择器也需保留。

这些历史通过数是此前日志记录，**本轮没有因为只写文档就重新宣称全部测试又通过一遍**。按修改范围运行相应测试：

| 范围 | 既有命令 / 历史结果 |
| --- | --- |
| AI 设置 | `node prototype/check_ai_settings.mjs`：27 项 |
| 状态/历史/模块/流式 | `node prototype/check_audit_state.mjs`：18 项 |
| Responses 协议 | `node tools/verify_gpt6_protocol.mjs`：40 项 |
| AI 集成 | `node tools/verify_gpt6_integration.mjs`：14 组 |
| 前端通信 | `node tools/verify_audit_io.mjs`：8 项 |
| 导入专项 | `py -3 -B -X utf8 tools/verify_audit_import.py`：6 组；`tools/verify_import.py`：242 项 |
| 代码生成专项 | `py -3.13 -B -X utf8 tools/verify_audit_codegen.py`：39 项；先确认其所需环境和生成夹具 |
| 浏览器自检/会话 | `node prototype/run_checks.mjs --only=selftest,sesscheck`：956/78 项 |
| Rust 通信 | 在 `desktop/src-tauri` 执行 `cargo test -- --nocapture`：6 项 |
| 文件/算子/跨后端 | 按改动补跑 `tools/verify_bin.py`、`verify_codegen.py`、`verify_op.py`、`verify_plastic.py`、`verify_stream.py`、`verify_compat.py` 中相关项 |

### 当前真实构建顺序（B16 修好之后）

```powershell
# 仓库根目录：一条命令走完 esbuild -> 成品页 -> 17 个校验页 -> 静态复查
node prototype/build_all.mjs
# 然后切换到 desktop 目录（build / check 都会自己先跑 npm run frontend）：
npm run build
```

`desktop/sync_frontend.mjs` 在搬运前会核对成品页里的源码指纹，过期产物会被明确拒绝，
所以「编译通过」不再等于「打包的是旧界面」；但仍然不要把“编译通过”当作“已安装更新”：
安装前后记录源版本、页面/exe 哈希和备份，保持用户工程不受影响。
手工跑 esbuild 也可以（`build_all.mjs` 做的就是这件事），但之后**必须**再跑 `prototype/build.mjs`，
否则 bundle 会比成品页新，同步那一步会拒。

### 每项修复日志模板

```text
日期 / 问题 ID：
实际触发条件与原错误：
改动文件、函数与新行为：
兼容性/迁移/明确未覆盖范围：
新增回归用例与实际执行结果：
既有相关回归结果：
是否重新构建、是否更新安装、产物哈希/备份：
剩余问题和下一步：
```

只有相应验收通过后才把 B 项标为已修复，不能因为换了提示、增加 try/catch、跳过失败节点或测试未执行就关闭问题。

## 7. 本轮审查基线与交付范围

- 主程序 `prototype/src/main.js` SHA-256：`5F02B7C96D41CBA0BE2F3C57B0FF5E65046F62CF168E18CD115D89B8562B807E`。
- 导入器 `tools/import_model.py` SHA-256：`EE1BD5AF81A75C4482280E8DBF5ACB6F131B3AF1DAAB6577364FB6614B3464AD`。
- AI 手册 `prototype/src/ai_manual.js` SHA-256：`C86BD06A2548D5667978CE92CF33ADFA708131A717F67ED0AC416DBB44166F06`。
- 本轮新增/更新的是审查文档、FIX_LOG 和 `_dump` 下的隔离探测材料；以上生产文件指纹与审查开始一致。没有重新构建或替换 exe。
- 文档列出 **22 个待修问题、16 项功能缺口、9 个继续验证领域**；问题之间有共同根因，不应把编号数量理解为相互独立漏洞数量。
- 仍可能存在未发现问题。此文档的价值是提供可复核证据与可执行修复验收，不是承诺“所有问题已经找完”。
