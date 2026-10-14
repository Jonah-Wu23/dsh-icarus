# DeepSeek Harness 全域自主 Agent 系统深度研究报告

研究时间：2026 年 10 月 14 日 · 论文检索窗口：2026 年 9 月 1 日—10 月 14 日 · 技术底座：DeepSeek Harness（DSH）

## 一、总体判断

建议以 DeepSeek Harness 为统一运行内核，构建具有持久目标、主动感知、长期记忆、自主进化、多端交互能力的个人 Agent 系统。

你描述的 13 项能力实际上指向同一个产品：一个能够长期存在、理解你、主动发现价值，并持续改进自身执行能力的个人智能体。

核心架构应当遵循三项原则：

1. 统一 Agent 生命周期。 每日推荐、论文追踪、Offer 监控和自主研究都是长期目标的不同实例，共享调度、执行、反馈和记忆机制。
2. 模型权重冻结，Harness 持续进化。 通过插件、工具、Agent Loop、记忆、上下文策略和工作流修订提升系统能力。
3. 用户设备成为统一系统的终端。 手机、电脑和语音共享任务状态、记忆、审批与结果，不依赖某一个聊天窗口持续打开。

关键假设是 DeepSeek Harness 继续作为主运行时，允许增加少量自研组件，并以本地优先、必要时使用远程常驻节点的方式部署。撤掉允许自研组件的假设，现有插件仍可覆盖大量基础功能，但无法完整实现目标级持续自治和可验证的跨任务自进化。

已确认的基础生态

GitHub 检索快照

DSH 主仓库

# 24.9万

Stars，约数

社区插件目录

# 307

10 月 12 日收录量

研究需求

# 13

逐项论文与插件配对

已核对的资源包括 DeepSeek Harness 官方仓库、DSH 社区插件目录及 DSH Plugin Registry。社区目录不是成熟度认证，Star 数量也不能代替功能覆盖和运行可靠性评估。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub

+2



## 二、13 项功能：论文与插件逐项裁决

论文严格限定在 2026 年 9 月 1 日至 10 月 14 日首次公开的研究。插件优先选择实际具备对应功能、可与 DSH 集成且仍在维护的项目。Star 为本次 GitHub 查询时的约数；低 Star 的项目明确标为实验性方案。

### 01｜每天 21:00 收集白厄美图，并从反馈中学习审美偏好

![白厄 - 崩坏：星穹铁道WIKI_BWIKI_哔哩哔哩](https://images.openai.com/static-rsc-4/gOdtN8sGA2V4vXYqH2H5F07NkpONZ2biXL_flL2UwC9RK6ziwKqNadGOzip1UIyVM58Ll0sc6N0ToAWU0RUZ_pQ9sJWL2GEJNSkEW2Szf9rng5cSnPwmYUtAukHZvRH5SYk_60KQdxqHnh2X80T08xZrAVIX4tSPdGvXqKK0ZR0?purpose=inline)

首选论文： How Can Recommendation Feedback Evolve Agent Memory?

2026-09-29 · TIDE · 推荐反馈驱动的记忆演化

首选插件： dsh-pixluna · 约 3 Star

能力匹配：直接支持图源、标签检索和 Pixiv 图片获取；成熟度偏低。

TIDE 解决了一个关键问题：用户反馈通常滞后，且多个历史偏好同时参与推荐，系统需要判断哪条记忆应该获得奖励或受到惩罚。论文在其电商推荐任务上报告了 +7.75 个百分点的记忆演化收益。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



工程上应维护一份可更新的角色审美画像，包括画风、场景、服饰、构图、色调与作品来源。每日收集候选图片、去重、排序，21:00 发送精选内容，次日根据收藏、喜欢、不喜欢及文字反馈更新权重。

`dsh-pixluna` 提供了 `pixluna_get`、`pixluna_get_pixiv` 等实际工具接口。它适合作为图片获取层，但还需要自建推荐排序、反馈记忆和图片缓存。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

让 DSH 自己看涩图！ · GitHub



裁决：功能可落地，推荐算法值得自研；暂不把图片插件视为成熟生产组件。

### 02｜每天 21:00 汇报最新 AI 自进化论文，并学习研究偏好

首选论文： AgentRecommender: LLM Agents Enable Customizable Recommender Systems on the User Side

2026-09-25 · 用户侧可定制推荐系统

首选插件： dsh-Mimir-Academic-research · 538 Star

这篇论文的核心价值在于让个人 Agent 独立维护推荐目标，而不依赖内容平台的点击优化逻辑。你的论文推荐目标应当是研究新颖性、机制创新、已有研究覆盖情况和实验可复现性，而非文章热度。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



Mimir 提供 arXiv 文献管理、科研工作台、实验记录等能力。其仓库已有数百次提交，是本轮发现的较成熟 DSH 学术插件之一。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



建议将每篇候选论文压缩为一个可检索的研究对象：研究矛盾、核心机制、相对于已有工作的差异、实验结论、与你关注方向的关系。用户标记“真正有创新”“已有前人做过”“不感兴趣”之后，反馈进入下一轮推荐策略。

裁决：优先级最高的即用型功能之一。

### 03｜监控 NTU EAI 新录取案例，出现后主动报告

首选论文： Self-Evolving Search Index

2026-09-17 · 自进化搜索索引

首选插件： dsh-sentinel · 18 Star

该论文研究如何利用搜索过程中的失败和反馈持续优化索引。它对跨网站案例追踪最有价值的启发，是将新的搜索线索和失败查询转化为下一次检索策略，而非每天机械重复相同关键词。论文侧重检索机制；网站变化触发需要插件承担。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



`dsh-sentinel` 支持持久化 HTTP、文件、命令、进程和 Webhook 监控，并可以在条件满足时唤醒 Agent。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



对于 NTU Master of Science in Enterprise Artificial Intelligence，应监控指南者留学等中介案例库、留学社区、公开社交信息及相关搜索结果。新事件必须经过三层处理：发现新增内容、确认确实属于该专业及申请轮次、按来源 URL 与案例特征去重。

特别需要区分 中介公布的录取案例 和 NTU 官方发布的录取信息。最终通知应携带原始链接、首次发现日期、案例背景和证据等级。

裁决：采用 Sentinel 作为触发底座，另建多源发现与录取案例判定模块。现成插件不足以单独完成整条业务。

### 04｜动态补充“我是谁、想做什么、为什么、怎么做”的长短期记忆

首选论文： Retrieval-Driven Memory Reconsolidation for Long-Term LLM Agents

2026-09-13 · REALM · 检索驱动的记忆再巩固

首选插件： dsh-mnemon · 522 Star

REALM 的重要性在于：历史记忆并非写入后永久保持原样；每次检索和使用都能反过来修正记忆的组织方式。论文报告 LoCoMo 准确率 75.97%、LongMemEval 准确率 65.11%。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



`dsh-mnemon` 为 DSH 提供分层记忆与可组合的记忆来源。它更适合作为现阶段的核心记忆入口，而非让各个 Agent 分别维护互不兼容的 Markdown 文件。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



建议将用户认知拆成四种有明确生命周期的信息：

| 记忆对象 | 内容                     | 更新规则                   |
| -------- | ------------------------ | -------------------------- |
| Identity | 身份、长期兴趣、稳定偏好 | 用户明确确认或稳定证据更新 |
| Goal     | 想完成什么、为什么重要   | 目标状态、优先级随进展更新 |
| Strategy | 当前打算如何执行         | 根据结果与反馈动态修订     |
| Episode  | 发生过什么、证据在哪里   | 保留事件来源和时间关系     |

裁决：选择 `dsh-mnemon` 作为第一版统一记忆接口。记忆模式必须围绕目标与因果关系设计。

### 05｜自主发现新事物、构想新方向、主动研究与解决问题

首选论文： Atria Dawn: The Dawn of Agentic Superintelligence

2026-09-14 · 长时自主研发 Agent

首选插件： dsh-proactive · 4 Star

Atria Dawn 研究 Agent 如何在科学与技术研发任务中执行多阶段探索、方法提出、实验实施和成果评估，其研究范围比简单的新闻推荐更接近你的目标。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



`dsh-proactive` 已经尝试实现心跳、好奇心探索、科学假设生成和主动调度，但项目成熟度尚低，不能仅凭 README 中的自治、共识或自进化描述直接判断其运行可靠性。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



我建议的主动研究循环是：

只有当假设具有明确价值、可验证路径和合理预算时才进入实验阶段。重大突破、对当前目标有实质影响的发现才主动打扰用户。

裁决：这是系统的差异化能力，应自主开发统一主动研究循环，而不是直接依赖 4 Star 插件。

### 06｜一般事务完全自主，只在关键操作前请求授权

首选论文： Runtime Authorization of Self-Generated Subgoals in Long-Horizon Tool-Using AI Agents

2026-10-04 · 长时任务中的运行时子目标授权

首选插件： dsh-permission-rules · 123 Star

该论文直接切中长期自主 Agent 的权限问题：Agent 会自主生成子目标，原始用户授权必须持续约束这些子目标所能触发的真实操作。论文提出将目标状态、授权和最终执行提交绑定。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



`dsh-permission-rules` 支持按照工具名、参数、工作空间路径等条件配置 `allow / ask / deny`，还具备审计和热更新机制。项目有 245 次提交，当前较适合充当统一权限网关。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



建议按实际后果管理授权：

| 执行范围                                     | 系统行为           |
| -------------------------------------------- | ------------------ |
| 搜索、阅读、归纳、推荐、本地非破坏性实验     | 自动执行           |
| 已授权额度内的模型调用和定期监控             | 自动执行并记录成本 |
| 发送外部消息、购买付费资源、修改关键账户配置 | 申请授权           |
| 删除重要文件、支付费用、修改安全权限         | 明确授权且留存记录 |

这里还有一个值得注意的选型结果：`dsh-auto-mode` 有 164 Star，但 GitHub 标记为 Public archive。因此选择仍在维护、可细粒度声明规则的 `dsh-permission-rules` 更合理。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



裁决：必须把授权定义成长期目标的执行契约，实现一次授权、范围内持续自主。

### 07｜在手机上完整使用 Agent，不依赖远程控制电脑

首选论文： Nexus: An Execution Fabric for AI Agents Across Cloud, Edge, and Devices

2026-10-05 · 跨云、边缘和终端的 Agent 执行架构

首选项目： DSHBox · 117 Star

Nexus 将执行身份、任务租约和计算资源分配纳入统一架构，这与你要求的“走出电脑也能使用同一个 Agent”直接相关。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



`DSHBox` 可以在 Android 手机或平板上利用 PRoot、Debian、Node.js、WebView 运行本地 DeepSeek Harness，无需 Root。与单纯的远程桌面相比，这是更符合目标的实现方向。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



但完整体验需要额外完成跨端状态同步：手机上的即时任务可以本地执行，长时间工作交给常驻节点，所有终端共享同一个目标 ID、事件历史和记忆状态。

如果手机离线，长期监控仍由常驻节点负责；手机重新连接后接收进展与结果。目前检索到的 DSHBox 主力实现为 Android，iOS 还需要另行设计客户端。

裁决：DSHBox 是移动端本地执行的首选原型；跨设备连续性要在统一执行层解决。

### 08｜全双工实时语音对话

首选论文： AdaptDuplex: From Static to Adaptive Full-Duplex Spoken Dialogue

2026-09-24 · 自适应全双工语音交互

首选集成项目： qwen-audio-agent · 约 2,900 Star

AdaptDuplex 的研究重点是让系统在持续聆听的同时决定何时说话、何时让出话语权、何时处理用户打断。这比串行的语音识别—文本推理—语音合成更符合真正的全双工需求。论文在 HumDial-FDBench 上报告综合指标 69.6。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



`qwen-audio-agent` 提供实时语音运行时，并明确列出 DeepSeek Harness Native ACP 集成，成熟度明显高于目前找到的原生 DSH 全双工语音插件。不过，它属于外部语音运行时与 ACP 桥接，不能当作普通 Cordis 插件安装。其文档也把 DSH 后端集成标为仍在发展的四星级适配。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



原生 Cordis 方案 dsh-realtime-voice 已支持相关实时接口，但尚无足够社区积累。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



裁决：优先选择 Qwen Audio 语音运行时加 DSH ACP，保留独立实时音频通道，不让长任务阻塞对话。

### 09｜Loop Goal 与数小时、数天的长期持续运行

首选论文： Advancing Model Research in AgentX: Long-Horizon Autonomy for Industrial Recommender Systems

2026-09-24 · 工业级多轮自主研究

首选插件： dsh-mission · 1 Star

AgentX 展示了 Research Agent 与 Model Agent 通过复现、诊断、组合和后续实验持续推进复杂模型研究的方法。其重要启示是长期任务需要结构化状态和真实实验反馈，不能靠不断重复提示词保持进度。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



`dsh-mission` 支持将目标分解为 DAG，加入任务依赖、租约、执行验证和异常后重规划。方向非常接近需求，但只有 1 Star，尚不属于成熟方案。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



这里要利用 DSH 已有能力：官方 Schedule 子系统能够持久化定时任务，并恢复原始 Session。但文档明确说明，定时消息送达不会等待 Agent 执行完成。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



因此应将长期目标持久化为独立的 Mission，并由常驻 Worker 按状态推进。即使一次模型调用结束，Goal 仍然存在；即使程序重启，也能根据最后已提交的事件继续执行。

裁决：长期运行必须进入独立任务控制平面。`dsh-mission` 值得吸收设计，但目前不建议把整套可靠性寄托在该插件上。

### 10｜本地多 Agent 长期、可靠、有序地协作

首选论文： WorkflowOps: Learning Agent Collaboration Priors for Multi-Agent Workflow Orchestration

2026-10-06 · 多 Agent 工作流编排与协作经验复用

首选插件： dsh-agent-teams · 约 2,100 Star

WorkflowOps 的核心贡献是把历史协作经验转化为可重用的工作流先验，减少在每次任务中重新规划团队的成本。论文报告路由模型调用数降低约 80%。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



`dsh-agent-teams` 已具有队伍组织、任务分配、并行执行、成员通信等能力，GitHub 有数千 Star、数百次提交，属于本轮较值得采用的原生 DSH 协作插件。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



需要补足的信息系统契约包括：任务唯一所有者、版本化输出、消息持久化、工作领取租约、重试幂等、失败恢复，以及最终成果的验证和提交。Agent 间自由聊天不应成为整个系统的唯一状态记录。

裁决：采用 Agent Teams 作为协作执行层；以持久化事件和任务状态机约束其行为。

### 11｜冻结模型权重，让 Harness 自身持续进化并获得跨任务泛化能力

首选论文： Self-Evolving Harness on Multiple Tasks with the Agent as Its Own Optimizer

2026-09-29 · 多任务 Harness 自进化 · 同一冻结模型承担 Solver 与 Optimizer

首选插件： dsh-evolve-modes · 202 Star

论文报告的主要结果

# +4.48

分布内平均得分提升

# +12.64

分布外平均得分提升

论文从 49 行初始 Harness 开始，让同一个冻结权重模型交替承担执行者和优化者角色。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org

这篇论文与你的整体技术路线匹配度最高。研究不仅允许模型编辑其自身运行环境，还明确评估多任务训练和未见任务上的泛化结果。论文分析的涌现机制包括历史压缩、输出截断和独立审查。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



`dsh-evolve-modes` 支持可组合工作模式、隔离演化和审查流程，适合作为 Harness 修改的界面和基础控制层。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



真正的自进化闭环应为：

发现失败模式 → 提出 Harness 修改 → 执行差异验证 → 对照历史与未见任务 → 接受或回退 → 提升后续修复能力。

可演化对象包括插件配置、工具选择策略、上下文压缩、Agent Loop、任务分解规则、路由、技能与提示词。每一次版本变化都要与冻结模型权重、验证证据及收益记录关联。

裁决：整套系统最重要的科研主线。优先投入高质量实验设计和可验证的 Harness 版本管理。

### 12｜认知世界模型：从碎片 Checkpoint 变为统一的知识与因果结构

首选论文： MemoWM: How World Models Change What Agents Need to Remember

2026-10-07 · 世界模型驱动的 Agent 记忆

首选项目： MemOS · 约 11,800 Star

MemoWM 讨论一个值得重视的变化：当 Agent 拥有可复用的世界模型时，许多历史经验可以压缩为关于世界运行规律的知识，而不是永远保存冗长的完整轨迹。论文报告相对于其比较系统的单经验记忆量降低 53.9%。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arxiv.org



MemOS 已提供 DSH 官方安装路径，包括本地和云端插件。其本地方案具备混合检索、去重、分层技能演化，以及 L3 World Model 等设计。GitHub 的 11.8k Star 属于 MemOS 主仓库整体，并非单独的 DSH 适配器。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



这里需要把三个概念分清：Checkpoint 用于恢复运行，Episodic Memory 记录历史，World Model 则维护实体、关系、因果假设和可用于推断的环境状态。

MemOS 已经为后两者提供基础，但要达到你设想的统一认知系统，仍需增加跨目标的实体识别、信念更新、冲突处理、证据回溯和预测验证机制。

裁决：MemoWM 是理论方向，MemOS 是优先评估的工程底座。与 `dsh-mnemon` 应选择一个作为主记忆入口，避免两套系统竞争写入和上下文注入。

### 13｜从数字工具调用扩展到物理与数字世界的全域操纵

首选论文： Agent as Policy for Robotic Manipulation

2026-09-11 · 将 Agent 直接用于机器人操作策略

首选插件： dsh-robotic-harness · 24 Star

论文探讨使用通用 Agent 组织机器人操作、观察环境反馈和执行动作序列，在其 8 类实验配置中的 7 类取得至少 80% 的成功率。它为通用推理 Agent 与物理执行系统之间的接口提供了有价值的研究路线。

![img](https://www.google.com/s2/favicons?domain=https://arxiv.org&sz=32)

arXiv



`dsh-robotic-harness` 提供机器人资源检查、MuJoCo 操作仿真、故障注入、实验记录及部分 ROS 操作接口。当前更适合作为具身智能实验基础设施。

![img](https://www.google.com/s2/favicons?domain=https://github.com&sz=32)

GitHub



建议统一两类执行资源的抽象：数字端包括网页、应用、文件、API；物理端包括手机传感器、摄像头、外设、机械臂及 ROS 系统。它们共享授权和执行日志，但采用各自的能力声明与安全边界。

裁决：数字侧已经具备可观基础；通用物理操纵仍应作为研究阶段目标。

## 三、插件选型总表

Star 为 2026-10-14 检索快照附近的约数；“成熟度”综合考虑代码积累、维护状态、原生兼容性和功能完整性。

| 需求              | 最终选型                    | Star   | 工程裁决                     |
| ----------------- | --------------------------- | ------ | ---------------------------- |
| 01 美图与偏好     | dsh-pixluna                 | ≈3     | 图片工具可用，推荐系统自建   |
| 02 科研推荐       | dsh-Mimir-Academic-research | 538    | 优先集成                     |
| 03 EAI Offer 监控 | dsh-sentinel                | 18     | 事件底座可用，发现器自建     |
| 04 个人长期记忆   | dsh-mnemon                  | 522    | 优先集成                     |
| 05 主动研究       | dsh-proactive               | 4      | 参考原型，自建核心           |
| 06 自主权限       | dsh-permission-rules        | 123    | 优先集成                     |
| 07 本地移动端     | DSHBox                      | 117    | Android 优先                 |
| 08 全双工语音     | qwen-audio-agent            | ≈2.9k  | ACP 桥接集成                 |
| 09 持久 Goal      | dsh-mission                 | 1      | 架构参考，可靠性层自建       |
| 10 多 Agent 协作  | dsh-agent-teams             | ≈2.1k  | 优先集成                     |
| 11 Harness 自进化 | dsh-evolve-modes            | 202    | 演化控制基础组件             |
| 12 统一世界模型   | MemOS                       | ≈11.8k | 记忆基础组件，世界模型需扩展 |
| 13 物理数字操纵   | dsh-robotic-harness         | 24     | 研究与仿真阶段               |

这里有一个很明确的事实：这 13 项中，并不存在 13 个同时满足高 Star、原生 DSH、功能完整和成熟稳定条件的插件。 最有价值的成果是确定哪些可以直接集成，哪些必须变成自己掌握的核心能力。

## 四、统一架构：把十三个功能收敛成五层

交互层 · Mobile / Desktop / Voice

DSHBox · Web UI · QwenAudio · 消息推送

目标与权限控制层 · Goal Control Plane

Mission Registry · Schedule · Trigger · Policy · Budget

行动与协作层 · Agent Execution Fabric

Planner · Agent Teams · Worker · Tool / Browser / Device / ROS

统一认知与事件层 · Cognitive State

User Model · World Model · Episode · Evidence · Event Log

自进化层 · Harness Evolution

Trace Mining · Repair · Benchmark · Version · Rollback

所有层共享稳定的目标 ID、执行记录和版本化状态；模型权重保持冻结。

### 4.1 真正需要自研的核心是什么？

我认为只有三个部件应成为这套系统的自有核心，而非外包给单个社区插件。

第一，Mission Control Plane。 统一管理定时任务、事件触发任务、长期研究目标和自主探索目标。一个 Goal 可以持续数周，但其下每一次执行都有明确的开始、领取、完成和失败状态。

第二，Cognitive State。 统一用户画像、目标原因、世界知识、历史证据与动态偏好。每个 Agent 只通过一个认知接口读取和提交记忆，避免插件各自建立相互冲突的真相来源。

第三，Evolution Controller。 所有 Harness 自修改都由它登记版本、关联实验、决定验证范围和发布状态。它是整个系统长期改善的核心。

其余能力——图片搜索、arXiv、移动执行、语音、工具权限、协作和机器人接口——都应该作为可替换的插件或适配器。

### 4.2 一个目标应该如何流转？

建议统一状态为：

```
REGISTERED → READY → RUNNING → VERIFYING → COMMITTED
```

异常路径进入 `RETRYABLE / BLOCKED / FAILED`，等待授权进入 `AWAITING_APPROVAL`。

关键的工程约束是：只有提交到持久化事件日志的结果，才算完成。模型说“已经完成”、定时消息已投递、子 Agent 回复“成功”，均不能直接代替完成事件。

长期运行建议采用 SQLite WAL 或其他事务存储保存目标、工作队列、租约、幂等键、结果和通知发件箱。单节点本地部署时，事务日志与租约机制比一开始就引入复杂的分布式共识更加合适。

### 4.3 三个真实使用场景如何在统一架构中运行？

白厄每日精选：定时目标

20:xx 前完成图片检索、去重、个性化排序和内容缓存；21:00 由定时交付机制发送。用户的喜欢、忽略和收藏行为形成反馈事件，更新下一日的偏好。

自进化论文简报：研究目标

持续发现新论文，按研究机制和贡献去重，在截止时刻生成经过排序的报告。重点关注冻结权重自进化、Harness 改进、跨任务泛化和长期 Agent 系统。

NTU EAI 新录取：条件触发目标

监控器发现新页面或新案例 → 解析学校、专业、申请季与录取结论 → 与历史案例比对 → 可信度足够时主动推送。不需要等到每日 21:00。

## 五、最值得优先读的五篇论文

这五篇构成完整的科研主线：Harness 如何改进、如何记忆、如何主动工作、如何长期运行，以及如何获得新的执行能力。

| 排名 | 论文                                             | 对系统的核心价值                        |
| ---- | ------------------------------------------------ | --------------------------------------- |
| 1    | Self-Evolving Harness                            | 冻结权重下，自我修改并产生跨任务收益    |
| 2    | MemoWM                                           | 将经验沉淀为可复用的世界知识            |
| 3    | WorkflowOps                                      | 将多 Agent 协作从即时编排变成可复用机制 |
| 4    | Runtime Authorization of Self-Generated Subgoals | 长时自主行动与授权持续一致              |
| 5    | Nexus                                            | 将执行从单个电脑扩展到多设备系统        |

其中，Self-Evolving Harness 是必读第一篇。它直接研究你的核心诉求，并且给出了冻结权重、跨任务训练和分布外评估的实验范式。

## 六、最终推进裁决

整体架构方向

PASS

13 项需求可以统一到同一套长期自主 Agent 架构中。

直接安装 13 个插件即完成全部功能

FAIL

主动研究、长期 Mission、跨端同步、可靠事件系统与泛化自进化仍存在显著工程缺口。

我的实施优先级判断如下：

| 顺序 | 建设范围                                        | 原因                                 |
| ---- | ----------------------------------------------- | ------------------------------------ |
| P0   | DSH + Schedule + 统一 Mission + 权限 + 事件日志 | 让系统真正长期存在、可靠运行         |
| P1   | Mimir、Sentinel、记忆系统、移动端               | 立即实现三个日常主动服务和跨设备使用 |
| P2   | Agent Teams、全双工语音、主动探索               | 从工具助手提升为持续协作的个人 Agent |
| P3   | Harness Evolution、世界模型、数字与物理执行扩展 | 建立长期能力增长和科研突破点         |

最终建议：用现有高成熟度插件快速铺出产品功能，把研发资源集中在“持续目标—统一认知—可验证自进化”这一条核心闭环上。

这条路线最有价值的地方，在于同一套系统既可以每天推荐白厄图片、实时盯着 NTU EAI 录取信息，也可以长期开展科研项目，并利用这些真实任务的执行记录持续改进自身 Harness。它具备明确的产品价值，也能为 Agent 自进化研究提供真实、持续增长的实验环境。

最后，两个运行前提直接决定能否达到你的使用体验：必须有全天候运行的执行节点，才能做到准时报告和条件触发；必须有稳定的跨端身份及状态同步，才能做到手机和电脑无缝继续任务。 撤掉前者，主动报告能力便退化为设备在线时执行；撤掉后者，多端体验便退化为多个独立 Agent 实例。