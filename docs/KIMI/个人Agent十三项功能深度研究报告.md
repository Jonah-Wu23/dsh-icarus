# 个人 Agent 系统十三项功能深度研究报告

论文检索通过 kimi datasource 的 arXiv 数据源完成，时间窗口 2026-09-01 至 2026-10-14，每项功能选一篇最值得读的论文。插件按 GitHub star 数与成熟度选取，star 数为 2026-10-13 查询值，均可作为 deepseek harness 的外挂能力接入。

## 1. 每日定时收集内容 + 21 点报告 + 按反馈调偏好（白厄美图场景）

**论文：How Can Recommendation Feedback Evolve Agent Memory?（TIDE）**
arXiv 2609.37544v2，2026-09-29，cs.AI。
内容生成 Agent 会收到推荐系统回传的曝光、点击、负反馈等延迟且含噪的信号。TIDE 把记忆当作容量受限的经验种群，用时间归因与责任归因把延迟的推荐结果折算成每条记忆的适应度，再做强化、交叉、变异、淘汰。作者还提出 Memory Evolution Gain（MEG）指标，衡量演化后记忆相对无记忆基线在严格未来任务上的收益。电商营销 Agent 上 MEG 提升 7.75 个百分点，线上 A/B 的点击率与激活率均显著上升。
值得读的理由：这是"用户反馈 → 记忆演化 → 次日推荐变化"这条闭环最完整的形式化，归因方法可以直接搬到美图偏好调整上。

**插件：DIYgod/RSSHub，46.5k stars。**
万物皆可 RSS。Pixiv、Twitter、微博、B站等图源都有现成路由，定时抓取后交给 harness 的筛选与报告环节即可，是最成熟的内容收集底座。

## 2. 每日收集 AI 自进化论文 + 21 点报告

**论文：Ream: Unfolding Mutual Awareness in Human-Agent Workspaces**
arXiv 2610.09497v1，2026-10-07，cs.AI/cs.HC。
文献调研 workspace 里的人与 Agent 互相感知问题：Agent 跑得快，人看不过来；人的兴趣变了也不一定说出口。Ream 用结构化文档、双向行为轨迹记录、局部可视化让双方看到彼此的活动历史，Agent 也能读取人的批注来校准下一步检索方向。18 名研究者的实验证实共享轨迹能提升 Agent 的相关性与人的监督效率。
值得读的理由：它回答的是"每天推送论文后，怎么把用户的浏览和批注变成下一天的检索依据"，正好补 TIDE 在人机交互一侧的空白。

**插件：AutoLLM/ArxivDigest，468 stars。**
用 LLM 做 arXiv 每日抓取、相关性打分与个性化摘要的现成管线，接 cron 即可每晚产出日报。该细分领域整体年轻，没有更高 star 的专用项目；若要更稳的底座，用 RSSHub 拉 arXiv 订阅源再交给 harness 打分也是可行路线。

## 3. 盯 NTU EAI 新录取结果，出现即报

**论文：When Should Agents Check External State? Budgeting Observations for Stored Intentions（BudgetPM）**
arXiv 2609.37125v2，2026-09-29，cs.AI。
前瞻记忆让 Agent 记住"某条件成立时要做什么"，但存下来的意图不会告诉 Agent 条件现在是否成立，每次检查都要花网页访问和付费调用。BudgetPM 首次把这类外部观测形式化为共享预算下的资源分配问题，给出静态与序贯两种策略，在 PM-Bench 上用 42–54% 更少的检查保住 99.9–100% 的效果。
值得读的理由："盯着网页等变化"本质上就是预算受限的前瞻记忆，这篇给出了什么时候查、查多勤的定量答案。

**插件：dgtlmoon/changedetection.io，35.0k stars。**
网页变更检测领域事实标准，支持 CSS/XPath 选择器、 diff 通知、多种推送渠道。把中介案例库和目标页面挂上，变化事件经 webhook 打进 harness 即触发报告。

## 4. 用户画像与长短时记忆系统

**论文：HGP: An on-device personalized agent memory via hybrid graph storage**
arXiv 2610.10071v1，2026-10-07，cs.AI。
把情景记忆、语义记忆、程序记忆分别建成图，外加一条工作记忆状态轨迹捕捉当前约束；用轻量自增强分类器做记忆路由，减少大模型调用，支持端侧部署，用户画像随交互增量精修。PAL-Set 上 S 分 35.58，超最强基线近 7 分。
值得读的理由：多类型记忆分图存储 + 工作记忆轨迹，是"用户是谁、想做什么、为什么、怎么做都有动态补充"这一需求目前最完整的工程化设计。

**插件：mem0ai/mem0，67.1k stars。**
Agent 记忆层里 star 最高、部署最广的项目，长期/短期记忆抽取与用户画像更新开箱即用，可直接作为 harness 的记忆后端。

## 5. 自主发现新事物、构想新方向、主动报告

**论文：LLM-IDEA: Identifiability-Driven Experimental Agent for Autonomous Discovery of Mechanistic World Models**
arXiv 2610.11253v1，2026-10-08，cs.AI。
自主科学发现 Agent 碰到平台期时，需要区分是能力不足还是该问题从数据上根本不可辨识。LLM-IDEA 内置可辨识性引擎，给出三选一判定：能力上限、同设计空间内可解、已证穷尽。在多个发现基准上，它让 Agent 知道该继续搜索、换实验还是换问题类型，而不是盲目空转。
值得读的理由："自主发现新问题"最大的风险是在不可解方向上无限循环，这篇给了闭环发现 Agent 一个可计算的停止与转向机制。

**插件：Significant-Gravitas/AutoGPT，187.6k stars。**
自主目标驱动 Agent 的开山项目，Forge 组件体系支持自定义目标循环与主动执行，是"给个大方向让它自己跑"最成熟的参照实现。

## 6. 关键事项请求授权，一般事务自主行动

**论文：What Did the Agent Actually Do? Evidence-Grounded Oversight for Long-Horizon Agents**
arXiv 2610.06406v1，2026-10-05，cs.AI/cs.CL。
长程任务里用户从逐步决策转为事后监督，难点是从海量活动中找出哪些决策真正需要人确认。作者构建 AgentMonBench 基准，并提出 Evidence-Grounded Behavior Graph（EBG）：把带出处链接的证据聚成行为、组织成图，让监督器识别"有后果的自主决策"并定位证据。八个模型上均提升决策识别与证据定位。
值得读的理由：它直接定义了"哪些事该打扰用户"的判定方法与评测，是授权分级机制的学术对应物。

**插件：humanlayer/humanlayer，11.7k stars。**
专做 Agent 的人类审批门：函数调用级的中断、审批、回传，支持 Slack/邮件等通道，把"只有关键事项请求授权"落成几行装饰器。

## 7. 手机端流畅使用 Agent

**论文：Jev-Mobile: Jev as an Executor for Mobile GUI Agents**
arXiv 2609.30186v1，2026-09-24，cs.AI/cs.SE。
把移动 GUI Agent 改成低频 VLM 规划 + 高频轻量执行：VLM 定局部目标，可访问性树给出结构化动作空间，小决策模型在其中连续选动作。AndroidWorld 全套任务 79% 成功率，与逐步 VLM 基线 84% 接近，平均执行时间降 32.7%，模型 API 成本降 73.4%。
值得读的理由：手机端流畅的核心矛盾是时延与成本，"重规划、轻执行"的分频结构是目前最实用的解法，同样适用于"手机发指令、家里电脑干活"的远程形态。

**插件：open-webui/open-webui，155.6k stars。**
移动端浏览器体验最好的自托管 AI 前端，语音输入、离线队列、多后端接入齐全，在家里电脑部署后，手机在外网经反向代理即可获得接近桌面的 Agent 体验。coder/code-server（79.6k stars）可作为补充，把整个开发环境搬进手机浏览器。

## 8. 全双工语音实时对话

**论文：SALMONN-duo: Adaptive Dual-System Coordination for Full-Duplex Voice Agents**
arXiv 2609.34247v1，2026-09-28，cs.CL/eess.AS。
全双工要求毫秒级时序，工具调用和深思却耗时不定。SALMONN-duo 按双过程认知理论拆成常开的快思考全双工语音模型（系统一）与异步慢思考 Agent（系统二），系统一自己学什么时候直接答、什么时候委派，并在等待后端时保持对话不断流。成本感知强化学习进一步优化委派率与任务成功的权衡。
值得读的理由：全双工要接进 Agent 系统就必须解决"实时对话"与"慢速推理"的冲突，这篇是目前最系统的架构答案。

**插件：pipecat-ai/pipecat，16.4k stars。**
语音与多模态对话 Agent 的主流编排框架，原生支持打断、VAD、全双工流式管线，可直接挂进 harness 作为语音入口。模型层可搭配 kyutai-labs/moshi（11.2k stars）这类开源全双工模型。

## 9. Loop Goal 长时间运行机制

**论文：Humanize MLE Agents: Multi-Agent Session Alternation Beyond Single-Agent Limits（HMA）**
arXiv 2610.13494v1，2026-10-09，cs.AI。
作者先指出两个经验事实：单会话拉长后推理强度衰减（long-horizon deceleration），定制 harness 的收益随模型变强而消失（harness staleness）。随后把交替会话建模为上下文重置半马尔可夫决策过程（CR-SMDP），给出交替超越单智能体上限的充分条件与实验预算上界，并让两个 Agent 在共享 workspace 上交替、每会话限 k 个实验、会话间重置上下文。MLE-bench 75 任务上奖牌率 78.2%，用四分之一时间预算超最强开源基线 8 个点。
值得读的理由：loop goal 的核心问题正是"长跑不掉链子"，这篇从理论到实测证明了会话交替 + 上下文重置比无限拉长单会话更有效。

**插件：temporalio/temporal，23.7k stars。**
持久化执行引擎，工作流状态落盘、崩溃后从断点恢复、定时与重试内建，是"连续跑几天不丢状态"最成熟的底座，harness 的 goal loop 可以包成 Temporal workflow。

## 10. 本地多 Agent 长期协作不崩溃

**论文：Verifying Coordination in Parallel Coding Agents: NP-Bench and a Scheduling Planner（Nerveplane）**
arXiv 2610.07261v1，2026-10-05，cs.AI。
多个编码 Agent 各自测试全绿、合并却崩：协调问题被重新表述为调度问题——按声明的作用域划分不相交工作区、沿生产者-消费者图排序合并，全部前置完成。NP-Bench 三臂对比（无协调、反应式检测、前置规划）用真实 git 合并验证集成：干净集成率从 1/9 升到 9/9，合并冲突从 13 降到 0；跨会话记忆把重复犯错率从 1.00 降到 0.00。
值得读的理由："把多 Agent 当严谨信息系统设计"的最直接样本——收益来自工作分配方式而非模型能力，且随模型变强不衰减。

**插件：microsoft/autogen，61.4k stars。**
多 Agent 框架里 star 最高，群聊、角色、工具协议完整。crewAIInc/crewAI（59.7k stars，近半年提交更活跃）是并列的成熟选项，二者都可作为 harness 的多智能体运行时。

## 11. 权重不变的 Agent 自进化（插件、loop、上下文的自我优化）

**论文：Harness Evolution Hits a Ceiling: When Weight Training Should Begin**
arXiv 2610.11655v1，2026-10-08，cs.AI/cs.CL/cs.LG。
在冻结权重下让 harness 自我演化，先把失败轨迹按"首个触发的信号"分类：过程失败（调用卡死、循环、步数耗尽）由 harness 演化修复，内容失败（交付方案质量差）才留给权重训练。DeepPlanning 上自演化 harness 把 Qwen3.5-4B 留出集得分从 0.16 拉到 0.30，交付率 55%→90%；演化产生的行为再经 LoRA 内化进权重后还能叠加。结论是一条"读失败构成、选干预杠杆"的判别规则。
值得读的理由：它划清了"harness 自进化能修什么、修不了什么"的边界，正好回答权重不变这条约束能做到什么程度。同窗口的 Evo²（arXiv 2610.13025，权重-harness 协同演化）与 Skill-V（arXiv 2610.11781，可证伪的技能库自演化）可作为延伸阅读。

**插件：letta-ai/letta，25.1k stars。**
源自 MemGPT 的自编辑记忆 Agent 框架，Agent 自主读写自己的核心与归档记忆，不改权重就能持续调整行为，与自进化方向最对口的成熟项目。

## 12. 认知与记忆层：从碎片 Checkpoint 到统一认知世界模型

**论文：EvoBelief: Falsifiable World Models for Self-Improving LLM Agents**
arXiv 2610.12789v1，2026-10-08，cs.AI。
把环境知识表示为可证伪的假设：意外结果触发假设生成，后续观测与受控实验独立验证后才允许规则指导预测，反例则收缩或淘汰规则。语言模型全程冻结，每条规则链接到证据与受影响的决策。ALFWorld 上相对冻结世界模型基线提升 23.9–31.3%，MiniGrid 里能在环境静默漂移后自我修正，DiscoveryWorld 上发现定量定律而基线为 0。
值得读的理由："统一认知世界模型"的关键是知识要可检验、可撤销、带证据链，这篇给出了在部署中持续演化信念的完整机制。

**插件：getzep/graphiti，31.7k stars。**
时序知识图谱记忆层，把交互历史增量建成带时间戳的统一图谱，矛盾事实自动更新而非简单追加，是"从碎片到统一认知"最成熟的工程实现。

## 13. 行动层：物理与数字全域操纵

**论文：Make Code as Policy Great Again: Frontier Agents Write, Call, and Evolve Robot Tools（URAI）**
arXiv 2609.39018v1，2026-09-30，cs.RO/cs.AI。
编程 Agent 从任务意图出发写出可复用的机器人工具，经执行反馈与人指导迭代修订；执行 Agent 基于观测选择并参数化这些工具，每次调用本地跑完一段完整动作再交还决策权。验证过的工具修订跨剧集持久化，全程不更新基础模型权重，同一份工具经共享 GUI 与 API 对人和 Agent 同时可用。五个 RoboDojo 任务总成功率从 18.0% 升到 53.0%，七个真实双臂任务（含叠衣服、井字棋人机互动）验证。
值得读的理由：物理与数字操纵的统一接口目前最有说服力的形态就是"Agent 自写自演化工具库"，权重冻结、工具沉淀、人机共用三点都对得上。

**插件：browser-use/browser-use，117.9k stars。**
数字域行动层 star 最高的项目，浏览器操纵的稳定性和生态都最成熟，作为 harness 的数字执行手。桌面 GUI 侧可加 bytedance/UI-TARS-desktop（39.3k stars）；物理域暂无同量级高 star 通用插件，需按具体硬件接 SDK。
