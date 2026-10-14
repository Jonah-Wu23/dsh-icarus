# Icarus

DeepSeek Harness 中的科研与工程搭档。交代目标和简报时间，Icarus 持续阅读公开来源，说明关键假设，给出明确判断，并在授权范围内继续调查、交付可运行代码。反馈进入后续决策，成果通过桌面、QQ 或语音触达。

Icarus is your research and engineering partner in DeepSeek Harness. Set a mission and briefing time. It reads public sources, states assumptions, makes clear judgments, and writes runnable code. It follows up within scope, asks before expanding, learns from feedback, and briefs you on desktop, QQ, or voice.

产品以 Mission 承载持续委托，以稳定人格负责判断与交付。首批用户为 AI 研究者与独立开发者；论文追踪、申请动态和兴趣作品提供日常入口，关联调查把发现转为研究材料与工程成果。

## 当前状态

已完成产品规格、仓库初始化、M1 插件工程与 M2 委托执行链。插件可构建并安装到桌面 profile：BotBridge 打通真实交付，Mission 支持版本快照、按日程调度、租约与代次、重启恢复、预算闸门、审批绑定与错误档案；M2 总验收已在真实桌面宿主上逐步通过。M3 起的采集与反馈能力尚未实现，QQ 适配器安排在 M5，当前尚未接入。

- [最终 PRD](docs/PRD.md)：产品范围、架构与发布验收的实施依据。
- [开发计划](docs/DEVELOPMENT_PLAN.md)：任务依赖、阶段交付与真实运行验收。
- [设计哲学](PHILOSOPHY.md)：人格、任务与反馈的设计原则。
- [第三方说明](THIRD_PARTY_NOTICES.md)：参考材料与外部组件的使用关系。
- [LICENSE](LICENSE)：项目原创内容采用 Apache-2.0。

`docs/` 下其他报告保留为研究输入；实现以 `docs/PRD.md` 为准。

## 工程方向

Icarus 作为独立 DeepSeek Harness 插件，拥有 Mission、成果与反馈数据。DS Bot 提供持续身份和对话，宿主负责模型执行及审批。通过版本化 BotBridge 接入现有 Bot。

已核查的本机兼容目标为桌面宿主 `0.2.0-rc.2` 与 `ds-bot@0.1.5`。现有语音采用本地识别与浏览器朗读。Node.js/TypeScript 为实现语言，SQLite 为单主持久化存储。

插件源码位于 `packages/dsh-icarus`：TypeScript 编写，`tsc` 编译为 ESM 到 `lib/`，不打包，宿主提供的 peer 依赖不重复安装。运行依赖 `markdown-it` 解析成果的 Markdown 结构。BotBridge 已实现稳定身份解析、会话换代与后台成果交付；M1 的演示交付链抓取真实 arXiv 数据交付到绑定 Bot。后续阶段围绕同一条链路实现 PRD 中的完整业务闭环。

## QQ 接入计划

首个移动渠道采用 **NapCatQQ + OneBot 11 私聊**。常驻主机运行独立 NapCat 进程，登录专用 QQ 账号；Icarus 连接其本机 WebSocket 服务，向用户绑定的本人 QQ 发送简报，并接收反馈与追问。任务和模型执行仍由 Icarus 与 DSH 管理。

M5 按顺序完成账号登录与连接认证、本人身份绑定、outbox 定时发送和消息回执，再接通引用成果的反馈与调查请求。验收要求本人手机在约定时间实际收到简报，回复进入同一 Mission，断线与重启后的投递状态可核查。详细契约见 [PRD 第 9 节](docs/PRD.md#9-qq-触达与数据流)，实施步骤见 [开发计划 M5](docs/DEVELOPMENT_PLAN.md#m5完成桌面qq-与语音交互)。

该路线依赖专用 QQ 账号在线及好友私聊可用。腾讯官方机器人文档已声明停止主动推送，无法承担本项目的准点日报要求。NapCat 由用户独立部署，Icarus 只通过协议连接；其现行许可禁止商业使用，商业托管的 QQ 能力须在取得相应授权后提供。依据见 [腾讯消息文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)、[NapCat 配置](https://napneko.github.io/config/basic)与[许可证](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)。

## 构建与安装

插件工程在 `packages/dsh-icarus`，在 Node.js 24 与 pnpm 11 上验证通过。

```powershell
cd E:\AI\dsh-icarus\packages\dsh-icarus
pnpm install --frozen-lockfile
pnpm build      # tsc 产出 ESM 到 lib/
pnpm test       # node:test，验证身份解析（读取 lib/ 产物，需先 build）
```

安装到桌面宿主。`dsh plugin` 要独占 profile，先完全退出 DSH 桌面应用：

```powershell
dsh plugin --profile desktop add E:\AI\dsh-icarus\packages\dsh-icarus
```

安装把该路径登记为 profile 依赖并选中它的 bundle，重启桌面应用后插件加载；改动源码后需重新 `pnpm build`，宿主重启才会载入新的模块。`packages/dsh-icarus/cordis.patch.yml` 挂载 `icarus` 行，启动演示默认关闭。需要演示时，在 profile 的该行 config 中设置 `demo: { onBoot: true }`：每次加载抓取 arXiv cs.AI 最新 5 条提交（按提交时间倒序），生成中文结构化摘要，交付到 `config.bot` 指定的 Bot（默认 `Chief`）。Mission 的实际交付目标由其稳定的 `ownerBotId` 决定。

M2 在 `llm/stream` 请求边界持久保存输入与最大输出的预算预留，结算真实 usage；标题生成和 Bot 阅读交付也进入同一 Mission 的用量。文本输入按 UTF-8 字节数及协议开销保守预留，附件使用路由的上下文上限。`execution.maxOutputTokens` 默认为 8192；`execution.userTokenBudget` 可设置本机用户的累计 token 上限，默认不设总上限。用量未知的调用保留预留，`runs.get()` 的 `budget.reserved` 与 `budget.remaining` 显示其影响。

调度与公开的 `runs.tick()` 共用一次执行中的扫描，每个 Mission 只保留一条等待或执行中的 Run。暂停和取消立即影响执行权限；修改 revision 会停止旧回合。重启恢复先读取宿主会话，已完成回合直接提交原成果；中断的执行保存实际用量后登记新代次。投递发送前保存未确认状态，`delivery_unknown` 等待核查；确认回执与单次委托结束在同一事务内写入。

Bot 身份在每次交付时从 `$DSH_HOME/bot/state.json` 重读（会话换代后 `sessionId` 变化，缓存即错误）；该文件属于 DS Bot，Icarus 只读。抓取失败、Bot 不存在、prompt 被拒绝均按原始错误记录到插件日志，不生成兜底文本，也不静默跳过。

## 开发约定

遵循 [AGENTS.md](AGENTS.md)。真实失败保留原始状态，语义判断交给模型。任务成功以要求与实际产物为准；预算覆盖全部辅助调用。

本地中间文件放在 `.work/`，由 Git 忽略。凭据、数据库和执行记录不进入仓库。发布需要满足 PRD 的真实宿主与来源验收。

M1 的构建、测试与安装命令见上一节；宿主加载与真实交付的联调由负责人执行。

维护者：Zonghe Wu / Jonah Wu。
