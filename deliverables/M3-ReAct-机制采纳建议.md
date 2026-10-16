# ReAct 论文中值得 Icarus 采用的机制

本轮来源 `ti:"ReAct" AND au:"Yao"` 健康，返回 3 条。命中目标的只有 ReAct 原文；另外两条中，REACT-KD 是医学图像知识蒸馏（缩写撞名），天体物理核反应流那篇与语言 Agent 无关，均已排除。

## 阅读范围

- arXiv 摘要全文（1630 字符，未截断）。
- [ar5iv 正文](https://ar5iv.labs.arxiv.org/html/2210.03629)第 1–5 节全文：引言、ReAct 的形式化、知识密集推理任务（HotpotQA/FEVER 结果与失败模式表）、决策任务（ALFWorld/WebShop 结果与 ReAct-IM 消融）、相关工作；正文在此截断。
- [官方代码仓库](https://github.com/ysymyth/ReAct) README 全文（复现表与引用信息）。
- 未读：附录 C 的完整 few-shot 提示词、附录 D 的轨迹表、附录 E 的失败模式样例。

## 结论

**不要自建 ReAct 循环。** 论文的形式化是把动作空间扩为 A∪L，语言动作（thought）不产生环境观测，只更新上下文。DSH 宿主已经在单回合内让模型自主交错思考与工具调用，Icarus 只需发一条 prompt 并等待 `turn/end`；再实现一层循环就会与宿主的回合边界（10 分钟执行超时、审批、回合结算）冲突。

**最值得采用的机制是「thought 稀疏、位置由模型定」。** 论文对 ALFWorld/WebShop 这类动作密集的任务，让模型自行决定 thought 何时出现，不规定格式、不挑示例，受控实验里六次试验稳定优于等轨迹的 Act-only：相对增益 33%–90%，平均 62%；最佳 ReAct 71% 对最佳 Act 45%，最差 ReAct 48% 仍高于最佳 Act。落到 Icarus：执行 prompt 不要按固定步数强制输出思考，预算闸门按 token 与检索次数计算，而不是按步数。

**第二个可用点是「轨迹即证据」，也是与现有证据服务结合最紧的一条。** 论文的可解释性来自三者交错，人可区分内部知识与外部环境来源；HotpotQA 人工标注 50 条轨迹，CoT 的幻觉占其失败模式 56%，ReAct 为 0%，误报率 6% 对 14%。Icarus 现在只把工具结果写成 `icarusEvidence`（`executor.ts` 在 `tool_result` 上追加该标记），模型的思考文本没有进入证据链。建议在同一处把每步 thinking 与对应工具结果一起持久化，一次记录同时满足「摘要只含实质内容」和「判断依据用户可随时查」，不新增第二套结构。

**两类失败模式要在 Icarus 侧显式登记，这是当前实现的具体缺口。** 论文测得 ReAct 高频错误之一是重复生成上一步的 thought 与 action、跳不出循环（归入 reasoning error，占其失败 47%），检索无信息占错误 23%。Icarus 拥有跨回合历史，比模型自己更容易识别重复工具调用。建议在 `executor.ts` 登记两类可观测失败：同一工具同参数的重复调用、检索空返回或无信息返回，而不是只写原始错误日志。

**thought 编辑式人工介入与现有设计同构。** 论文有人类在行动中途改 thought 的实测（附录 A.3，未细读）。这与 PHILOSOPHY 的「纠正改变后续行为」以及 M2 已有的 modify 重排、审批绑定同构，落地成本最低，做成反馈入口即可，不是新功能。

**一条边界：撤掉「执行模型足够强」这个假设，长轨迹上的推理+行动双能力提示不成立。** 论文在 PaLM-8/62B 提示场景下 ReAct 反而最差，用 3000 条正确轨迹微调后才成为最优。Icarus 执行档位是 deepseek-flash，长工具轨迹不要让同一个档位同时承担复杂推理与行动编排，涉及判断的合成与验收交给更强档位。

## 优先级

1. 轨迹即证据：thinking 与工具结果一起进入证据记录。
2. 稀疏思考 + token/检索预算，替代按步数约束。
3. 重复动作与无信息检索显式登记为可见失败。
4. thought 编辑式介入，作为修改后的反馈入口。

不推荐默认采用论文的 ReAct→CoT-SC / CoT-SC→ReAct 回退（21 个样本多数投票）：每回合 token 成本翻十几倍，与现有预算闸门冲突。仅在用户明确要求「必须给出结论」时作为可选档。

## 来源

- 论文：[ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)（v3，ICLR 2023）
- 正文：[ar5iv 全文](https://ar5iv.labs.arxiv.org/html/2210.03629)
- 代码与复现说明：[ysymyth/ReAct](https://github.com/ysymyth/ReAct)
