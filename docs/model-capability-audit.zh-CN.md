# 模型复现能力审查

审查日期：2026-09-22。对象为当前工作区源码，包含当天已有修复。本轮只审查并记录，没有修改程序、重新安装、调用真实模型 API、读取用户密钥或打开用户工程。

后续已按用户要求扩大检查范围。**详细修复入口见 [问题与功能缺口交接文档](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/docs/issue-handoff.zh-CN.md)**：包含 22 个待修问题、16 项功能缺口、复现脚本、证据等级及验收条件。本报告保留模型能力概览，不代替该完整清单。

## 结论

当前软件不能原生复现所有类型的 AI 模型。它具备标量神经网络、权重矩阵块、部分张量算子、局部可塑性学习和代码导出能力；适合搭建受支持的网络，并导出到外部运行或训练。

必须分别判断四件事：结构能否表示、计算结果是否等价、训练过程是否等价、目标机器能否承受规模。导入成功、画面能显示、编译成功均不能单独证明完整复现；还需要原模型权重、数据、预处理和训练方法。

下表的“支持”只针对源码已经实现的路径，不是所有变体都验证过。本次主要采用源码检查和极小合成样例，没有遍历所有模型或做大规模性能测试。

## 按模型类型判断

| 模型/方法 | 当前能力 | 主要边界 |
| --- | --- | --- |
| MLP、全连接前馈网络、简单自编码器 | 支持基础构图、激活、矩阵权重、PyTorch 导出 | 自编码器的特殊损失、训练数据处理仍要实现；VAE 的采样与 KL 损失不属于现成流程。 |
| CNN | 支持部分 2D NCHW 卷积、池化、归一化和张量重排，可导出 PyTorch/ONNX | 不是完整 CNN 算子库；ConvTranspose、Resize、Conv1D/3D 等没有对应的完整原生路径。编辑器不实际计算这些算子的张量输出。带 BatchNorm 的再训练还有下述缺陷。 |
| 普通循环网络 | 支持标量回边、自环、时间展开，普通回边可在导出的 PyTorch 中做 BPTT | 权重块或算子节点参与环时拒绝编译；内部记忆/脉冲状态会 detach，不能概括为所有状态都完整反传。 |
| LSTM、GRU | 不是现成支持的原生循环单元；ONNX 原生 RNN/LSTM/GRU 节点均被拒绝 | 固定步数在外部展开为受支持的前馈算子是可研究的转换方案，仍需验证共享参数和梯度，不能说画几条回边就是 LSTM/GRU。 |
| Attention、Transformer、大语言模型 | 有 MatMul、Transpose、Softmax、Add/Mul、LayerNorm 等组合原语；已用合成 ONNX 验证一个固定形状缩放注意力子图能导入 | 不能保证任意 Transformer 图导入；缺少通用 Gather/Embedding、动态序列/形状、控制流等原生支持，也没有完整 tokenizer、KV cache、生成采样工作流。某些 MatMul/Transpose 的接受与上游是否已是张量算子有关。 |
| 扩散模型 | 可以表达部分卷积或注意力子网络 | 没有完整的噪声调度、反复去噪采样和条件生成流程；常见模型用到的上采样/转置卷积等算子也不齐。不能从“可以搭 CNN”推出“可以完整复现扩散系统”。 |
| 图神经网络 GNN | 可以画有向连接图，并构造固定拓扑上的部分计算 | 编辑器连接图不等于“以图为输入的 GNN”。缺少通用索引、聚合、变长图批处理等原生路径，不能直接保证标准 GNN 导入与训练。 |
| 强化学习、GAN | 可搭部分策略/价值/生成器/判别器网络，已有 MuJoCo 通信桥 | 没有完整奖励采样、经验管理、PPO/SAC 或多网络交替优化流程；这些是训练方法和系统流程，不能仅靠网络结构完成。 |
| 脉冲/生物启发网络 | 有记忆、泄漏状态、脉冲、Hebbian/STDP 等局部规则 | 模拟阈值与导出模型语义不同；硬脉冲没有替代梯度；连续输入状态还存在下述不一致。不能视为通用 SNN 框架。 |
| 决策树、SVM 等非神经网络方法 | 不是当前原生建模目标 | 可以让 AI 写外部代码，但不因此成为编辑器支持的可视化模型类型。 |

主要源码证据：真正的算子白名单在 [main.js:7888](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:7888)，生成映射在 [main.js:8689](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8689)，卷积限制在 [main.js:8792](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8792)。显示配色表里出现 Gather、ConvTranspose 等名字不代表编译器已支持它们。

导入形状要求见 [import_model.py:103](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:103) 和 [import_model.py:239](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:239)：除批量维外要求静态形状；导入按 batch=1 表示，导出的代码另可接受动态 batch。MatMul 的分支差异见 [import_model.py:918](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:918)。

注意力需要多个张量间的运算，LSTM 包含门控、逐元素乘法与状态更新，不能以普通加权求和替代。对照资料：[PyTorch 注意力定义](https://docs.pytorch.org/docs/main/generated/torch.nn.functional.scaled_dot_product_attention.html)、[ONNX LSTM 定义](https://onnx.ai/onnx/operators/onnx__LSTM.html)。

## 已确认的问题与功能缺口（尚未修复）

### 优先：AI 权限边界

可达链为 `run_api → NF.aiConfig → aiSysSync → nf_sys_allow`。模型可调用的通用接口能够修改 `sysFs`、`sysRun`；在自动执行开启的情况下，“本机文件/命令开关默认关闭”不能保证只由用户授权打开。后续已用真实前端函数和隔离假宿主复现：未触发确认就提交了开启请求；没有在真实宿主执行或更改实际权限。详见交接文档 B01。

证据：[通用接口调用](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:21920)、[权限字段修改](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:21212)、[Rust 权限门](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/desktop/src-tauri/src/sys_exec.rs:78)。建议将授权入口从模型可调用 API 中分离，并由宿主保持独立的授权状态。让 AI 自动安装依赖或修改程序之前，应优先补上这一边界。

后续还用假凭证确认通用配置备份可能把 A 接口的 Key 回填到 B，再由实际请求函数携带到 mock B；没有真实配置读取或网络发送，也没有证据证明用户 Key 已泄露。必须同时修前端保存、启动恢复和 Rust 备份补齐，见交接文档 B02。其他新增确认包括常量被训练、算子参数共享丢失、序列 CE 类别轴、工程加载非原子、档位上限旁路、自动保存删除竞态、书签校验/HTML 注入和 Python 文件完整性检查，均尚未修复。

### 优先：部分模型可推理，但不能按当前骨架训练

BatchNorm 的 running mean/variance 与其他浮点算子参数一起被生成成 `nn.Parameter`，随后作为 `F.batch_norm` 的统计量使用。离线合成张量实验中，`torch.no_grad()` 推理通过，普通训练前向报错：`native_batch_norm is not differentiable with respect to argument running_mean`。此外，生成表达式硬编码 `training=False`，Dropout 被视为直通，因此也没有恢复正常的 train/eval 切换行为。

证据：[BatchNorm 表达式](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8736)、[浮点参数生成](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8880)、[训练循环](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9722)。建议先区分可训练参数、固定常量和运行统计量，再实现训练模式。

### 优先：导入结果的严格等价性不能仅看 exact 标记

- **GELU 数值改变。** 合成 `Conv(identity) → Gelu(approximate=none)` 被真实导入器接受，来源记录 `exact=true`；真实 `opExpr` 却生成 `F.gelu(x, approximate="tanh")`。在 [-3,3] 的 601 个 float32 输入点上，与原 ONNX 参考输出最大绝对差为 **0.00047326087951660156**。这不是完整桌面端到端导出测试，但已直接覆盖导入和实际生成表达式，足以确认此处语义不一致。证据：[导入判断](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:478)、[生成映射](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8785)；复现脚本和报告在 `_dump/capability-audit/gelu_probe.py`、`gelu-result.json`。
- **现代 Dropout 训练开关漏检。** 合法 opset 17 合成图通过第三输入设置 `training_mode=True`，导入器仍接受为恒等直通。当前代码只检查旧属性，没有读取现代第三输入。证据：[import_model.py:1113](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:1113)。
- **精度/类型有边界。** 神经元路径以 float32 计算；Cast 到其他浮点类型可能只记提示而不执行降精度。`exact` 当前仅由是否跳过算子决定，不能代表逐位一致。证据：[Cast 处理](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:1097)、[exact 标记](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:1273)。Cast 本应执行目标类型转换，参见 [ONNX 定义](https://onnx.ai/onnx/operators/onnx__Cast.html)。

建议建立按算子属性、dtype、opset 和训练模式划分的数值/梯度对照测试，导入报告区分“完全支持”“近似转换”“缺失/拒绝”，不以跳过节点来冒充复现。

### 状态型网络的样本隔离与运行一致性

生成的 `self.st` 在 batch 大小不变时跨调用保留；训练 DataLoader 使用 `shuffle=True`，每批没有状态复位，会让不同样本继承前一批同位置的状态。普通标量 RNN 的 `prev` 每次序列调用从零开始，需与上述记忆/脉冲内部状态区别对待。

编辑器每次 `runSimulation` 新建 `prev`、`st`，接口收到外部信号又重新调用模拟；这与导出模型保留内部状态不是同一连续运行语义。状态更新中的 `detach` 也意味着其梯度不会完整跨时间传播。

证据：[状态保留](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9510)、[批训练](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9729)、[编辑器状态初始化](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:14736)、[接口调用](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:15585)、[detach](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9041)。需要明确 reset/detach/step/sequence 的接口及行为，按独立样本或连续轨迹选择复位策略。

### 真实计算与训练管理

- 编辑器算子节点的激活只是“输入就绪后点亮”，输出不参与标量传播，见 [main.js:14572](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:14572)。要在软件里检查 CNN/Attention 中间张量和最终预测，仍缺少统一的真实张量执行后端。
- 图形界面训练页配置导出代码，不在编辑器中进行普通监督训练，见 [main.js:10532](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:10532)。现有局部 Hebbian/STDP 不等价于损失反传。
- 外部 PyTorch 骨架确有 DataLoader、autograd、Adam/AdamW/SGD、四种损失和 CPU/CUDA。缺少完整的数据适配、验证集、训练曲线管理、调度、混合精度、梯度累积、分布式与完整断点续训。checkpoint 仅保存模型状态和配置；普通整数分类标签也需适配，不能笼统承诺任意训练数据可直接使用。见 [main.js:9678](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9678)、[main.js:9752](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9752)。
- 训练后的外部权重不会自动回填到当前编辑工程；仍需设计稳定的参数映射与回导流程。
- 外部模型的通用导入器只接 ONNX，不直接恢复任意 `.pt`、`.safetensors` 或 GGUF 中的完整计算结构。C 后端拒绝算子节点和权重块且只负责推理；权重块需先展开或改用其他目标。本项目的 ONNX 导出也未完整表达持续状态和在线可塑性。不同目标的能力应分别列出，不能合并宣称支持。见 [导入入口](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:1388)、[C 后端限制](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:9970)。
- 权重块支持真正的共享参数组，但逐条边、未成功建组的权重及一般算子参数仍可能变成独立副本；同一份初始数值并不保证更新时继续共享，不能保证任意模型的训练语义。见 [共享处理](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/tools/import_model.py:1232)、[参数声明](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8880)。

### 规模与文档

当前源码按需扩容，神经元硬上限 **16,777,216**、显式连接硬上限 **67,108,864**，实际受内存、临时计算和硬件约束。权重块可以不占逐条连接额度，但仍要存参数、做计算；流式查看大文件不等于整模型能编译或训练。未完整载入的工程会拒绝编译。

证据：[容量](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:248)、[流式编译限制](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8120)。README 中固定 50 万/200 万、没有 DataLoader 的部分已落后于源码，本次结论以源码为准。这些硬上限也不是经过本次实测的可用性能承诺。

## 内置 AI 能补到哪一步

| 需求 | 当前可行路径 | 是否自动成为软件原生能力 |
| --- | --- | --- |
| 批量搭网、重复操作、已有算子组合 | 用现有工具与 `NF` 接口；可封装成 `NF.defineTool` 自定义工具 | 可以增加操作流程，不增加新的数学算子实现。 |
| 数据处理、复杂损失、训练/评估脚本、扩散或 RL 外部循环 | 生成 Python 文件，在桌面文件/命令通道和依赖可用时运行 | 是外部程序；不会自动回填模型、增加编辑器控件或成为内置训练器。 |
| 新的算子、动态形状、训练语义、导出后端 | 修改相应源码，补形状/dtype/版本规则、代码生成、保存载入与数值测试 | 必须完成软件开发、构建和版本更新。仅 `add_op("新名字")` 会遇到编译白名单拒绝。 |
| 让工具扩展后立即可用 | `save_tool → reload_tools → NF.defineTool` | 自定义工具可以热加载；软件内置代码仍要重新构建。 |

证据：[add_op](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:22254)、[自定义工具](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:22565)、[编译拒绝未知算子](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:8792)、[产物导出](C:/Users/Administrator/Documents/ChatGPT/神经元搭建程序/prototype/src/main.js:10833)。

自定义工具不能覆盖同名内置工具。工程撤销也不涵盖所有 AI 动作：`aiExec` 只为标记 `mut` 的工具拍快照，`run_api` 与默认自定义工具没有统一修改快照；外部文件、命令和后台训练不属于工程撤销。停止聊天也不自动终止后台任务。新增功能应同时定义失败恢复、撤销/备份和任务停止行为。

## 建议的开发顺序

1. **先修正确性与授权边界**：权限自开启路径、BatchNorm 参数/模式、Dropout/GELU 属性、状态复位与梯度语义；让导入报告准确说明等价程度。
2. **建立算子扩展接口和真实计算后端**：统一算子类型、形状/dtype、参数/常量、前向/梯度、导出和序列化；可研究以外部 PyTorch/ONNX Runtime 承担真实计算，让界面展示中间结果。
3. **按代表模型补功能**：先做到一个小 CNN 和一个小 Transformer 的导入、推理、训练、保存回导都能对照通过，再扩展 LSTM/GRU、GNN、扩散等；每类都需要明确数值容差与测试模型。
4. **完善训练工作流**：数据与标签适配、验证指标、曲线、暂停/恢复、checkpoint、权重回填，再考虑混合精度和分布式。
5. **最后扩展 AI 自动开发流程**：以隔离工作目录、明确授权、可审查代码、自动对照测试和修复日志为基础；把“模型写了代码”与“软件已验证支持”分开记录。

这是实施建议，尚未开发或验证为新功能。没有一个有限算子列表能据此承诺未来所有 AI 架构均无需扩展即可复现。

## 审查记录

- 编译/导入、训练/状态、AI/扩展三个方向独立检查；未触碰用户配置或执行权限变更。
- 极小合成样例：固定形状注意力导入成功；原生 RNN/LSTM/GRU、动态非 batch 维被拒绝；现代训练 Dropout 被错误接受；BatchNorm 梯度模式报错；GELU 精确/近似差异确认。部分实验只到导入器或生成表达式层，不冒充整个桌面应用端到端验证。
- 主程序 SHA-256：`5F02B7C96D41CBA0BE2F3C57B0FF5E65046F62CF168E18CD115D89B8562B807E`。
- 导入器 SHA-256：`EE1BD5AF81A75C4482280E8DBF5ACB6F131B3AF1DAAB6577364FB6614B3464AD`。
- 本报告中的新问题均为待处理项，未在本轮标记修复。
