# Icarus

DeepSeek Harness 中的个人 AI 搭档，专注科研与工程。交代目标和简报时间，Icarus 记住你的项目与兴趣，持续追踪公开信息，发现值得关注的变化，并在授权范围内继续调查、交付研究材料与可运行代码。它说明关键假设，给出明确判断，从反馈中学习，通过桌面、QQ 或语音汇报有价值的成果。

Icarus is your personal AI partner in DeepSeek Harness, built for research and engineering. Set a mission and briefing time. It remembers your projects and interests, tracks public sources, and turns meaningful discoveries into research materials and runnable code. It states assumptions, makes clear judgments, follows up within scope, and asks before expanding. It learns from feedback and delivers useful briefings on desktop, QQ, or voice.

产品以 Mission 承载持续委托，以稳定人格负责判断与交付。首批用户聚焦热衷 Agent 与自动化的 AI 发烧友，尤其是其中的研究生与个人开发者。论文追踪、申请动态和兴趣作品提供日常入口，长期记忆与反馈帮助它理解个人目标，关联调查把发现转为研究材料与工程成果。

用户可按需求连接免费 MCP 或安装 DSH 插件，让 Icarus 使用自己的项目文件、文献和笔记，持续关注开源项目或模型动态，并在授权范围内继续行动。扩展推荐说明用途与免费条件；工具连接后，要在任务使用的工作区真实调用，才登记为可用。

## 当前状态

已完成产品规格、仓库初始化、M1 插件工程、M2 委托执行链、M3 持续关注链、M3.99 联网搜索与 M4 反馈及调查。插件可构建并安装到桌面 profile：BotBridge 打通真实交付，Mission 支持版本快照、按日程调度、租约与代次、重启恢复、预算闸门、审批绑定与错误档案；M2 总验收已在真实桌面宿主上逐步通过。M3 已接入四种原生来源、资料与能力绑定、分批评估及交付窗口，并通过真实业务验收；M3.99 补齐联网搜索，三家服务按剩余免费额度分摊，搜索摘要与厂商正文抽取进入证据与预算，设置页可填写 key、测试连接、查看本月用量，并可选让 DSH 内置搜索接管。M4 把成果拆成带稳定身份的条目：反馈挂在具体条目上，偏好按委托隔离并发布版本化条目，评估与成果实际引用所用偏好；论文、申请、兴趣三个模板提供默认要求、条目字段与来源建议；从条目可创建独立的 `investigate` 委托，研究工作交付文档、工程研究在独立 worktree 中改动并实际运行验证命令，预算与检查点支持停止后重试。完整界面与 QQ 接入在 M5。MCP 管理器与浏览器扩展已完成本机安装与后台调用，其余推荐扩展保持候选状态。

- [最终 PRD](docs/PRD.md)：产品范围、架构与发布验收的实施依据。
- [开发计划](docs/DEVELOPMENT_PLAN.md)：任务依赖、阶段交付与真实运行验收。
- [M3 开发计划](docs/M3_PLAN.md)：持续关注、按需扩展与准点交付的具体实施顺序。
- [M3.99 计划](docs/M3.99_PLAN.md)：三家搜索服务、设置页、搜索来源与可选接管的实施与验收。
- [M4 开发计划](docs/M4_PLAN.md)：成果条目、反馈与偏好版本、三个模板、关联调查与主动调查的实施与验收。
- [用户需求与扩展建议](docs/M3_BEGIN.md)：首批用户需求及 MCP、DSH 插件候选。
- [设计哲学](PHILOSOPHY.md)：人格、任务与反馈的设计原则。
- [第三方说明](THIRD_PARTY_NOTICES.md)：参考材料与外部组件的使用关系。
- [LICENSE](LICENSE)：项目原创内容采用 Apache-2.0。

`docs/` 下其他报告保留为研究输入；实现以 `docs/PRD.md` 为准。

## 工程方向

Icarus 作为独立 DeepSeek Harness 插件，拥有 Mission、成果与反馈数据。DS Bot 提供持续身份和对话，宿主负责模型执行及审批。通过版本化 BotBridge 接入现有 Bot。

已核查的本机兼容目标为桌面宿主 `0.2.0-rc.2` 与 `ds-bot@0.1.6`。现有语音采用本地识别与浏览器朗读。Node.js/TypeScript 为实现语言，SQLite 为单主持久化存储。

插件源码位于 `packages/dsh-icarus`：TypeScript 编写，`tsc` 编译为 ESM 到 `lib/`，宿主提供的 peer 依赖不重复安装。BotBridge 连接稳定身份与当前会话，M3 已接入 RSS/Atom、arXiv、GitHub 与网页变化来源，M3.99 增加按查询式定期检索的搜索来源。来源游标、原始证据和实际阅读范围持久保存；模型结合选定项目文件及 Bot 背景，每批评估最多 20 条候选，通过原生工具提交评估及要求核对，再按约定时间交付。

M4 的条目身份固定在成果事务内生成，`DeliverableItem` 与成果同样不可改写；反馈（有用、不感兴趣、看过、收藏与文字纠正）只关联具体条目，打开链接单独写 ReadEvent。偏好整理是一次独立模型步骤，把原话与条目证据整理成 `explicit / inferred` 条目并发布新版本；评估与成果条目引用实际使用的偏好条目，`icarus_feedback adoption` 区分“已保存”和“已采用”。模板只给默认值，用户原话优先；事实缺失的必填字段保存明确的未知原因，不补造。

来源采集、成果准备和投递分别调度。空轮询不调用模型；来源失败保留错误与恢复时间，按委托去重通知。GitHub 来源共享持久请求额度：未认证请求至少间隔两分钟，认证后至少间隔两秒，并遵守上游剩余额度及重置时间。`icarus_sources` 的 `requestBudget` 操作可查询额度记录。

## 按需求扩展能力

现有 Bot 可调用 `icarus_missions`、`icarus_sources`、`icarus_capabilities`、`icarus_results`、`icarus_items`、`icarus_feedback` 与 `icarus_investigations` 管理委托、条目、反馈偏好和调查，查询资料绑定与投递回执。`icarus_missions` 的创建数据可带 `template`（`paper`、`application`、`interest`、`generic`）和 `explorationPolicy`（用户明确预授权的主动调查主题、每周次数与 token 上限）；`icarus_items` 按成果与序号或 itemId 返回证据、阅读范围与所属评估；`icarus_feedback` 记录反馈与打开行为、查询偏好版本并排队整理；`icarus_investigations` 从条目创建调查、查询检查点与真实命令记录、预算停止后重试。模型读取完整目标和实际工具描述后给出推荐；每项必需能力在绑定工作区实际调用，结果保存到对应 Run。扩展的安装和认证复用宿主，免费条件随提供者保存。

浏览器按需启用：在 desktop profile 的 `icarus-browser` 配置中设置 `enabled: true`，重启宿主。它先查找 Playwright 缓存和已安装的 Chrome/Edge，缺少浏览器时才下载 Chromium；显式 `executablePath` 优先。代理沿用宿主的 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`，支持本地 HTTP 与 SOCKS 代理。

Fetch 使用包内的 `icarus-fetch` 入口。`icarus_capabilities catalog` 返回可直接填入 MCP Server Manager 的 stdio `command` 和 `args`；入口使用 uvx 安装固定版本的 Fetch 及 `httpx[socks]`，并转换 Python 所需的 IPv6 `NO_PROXY` 格式。VPN 使用保留地址段解析公开域名时，连接参数包含 `--allow-private-ips`。本机已通过 MCP Fetch 和 DSH 浏览器的真实网页读取。

| 想完成的事情 | 推荐组合 | 预期成果 |
|---|---|---|
| 持续关注研究方向 | arXiv MCP、Zotero MCP，按需使用 MarkItDown | 结合已有文献的发现与方法比较 |
| 判断新项目是否值得集成 | GitHub MCP、Context7、浏览器工具 | 对当前项目的价值判断，M4 关联调查交付实际运行结果 |
| 关注申请与机会 | 搜索和网页阅读，按需连接 Google Workspace MCP | 保留项目与轮次的机会记录，授权后关联材料或日程 |
| 关注作品与视频 | RSS 来源、视觉工具，按需连接 Bilibili MCP | 读取实际内容的推荐，M4 使用对应委托的反馈 |
| 连续维护项目背景 | 项目文件、Obsidian MCP 或 Zotero MCP | 有版本依据的背景读取与调查材料 |

DSH 插件候选包括 [dsh-market](https://github.com/dsh-market/dsh-market) 的安装入口、[MCP 管理插件](https://github.com/Nichts0v0/dsh-mcp-manager) 的连接设置、[dsh-browser](https://github.com/anweat/dsh-browser) 的网页操作。[Vision Toolkit](https://github.com/Anionex/dsh-vision-toolkit) 已安装并在兴趣委托后台会话真实调用：兴趣模板要求视觉描述只能来自视觉工具返回的阅读证据，配置视觉模型时在 profile 补丁的 `vision-toolkit` 行写入提供者（本机验证使用 DeepSeek API 的 `deepseek-flash`，该模型已具备图像输入能力；`deepseek-v4-pro` 不接受图片）。[Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 和 [GenUI](https://github.com/omdsh-dev/dsh-genui) 用于查看材料及呈现成果。按所需能力选装，同类能力复用已有提供者。

具体上游链接与第三方使用关系见 [第三方说明](THIRD_PARTY_NOTICES.md)。版本声明、已安装、已连接和本机后台调用分别记录；所选扩展通过桌面 `0.2.0-rc.2` 验证后才写入可用配置。缺少认证或扩展离线时保留原委托与进度，显示需要完成的连接步骤。

## 联网搜索

打开 DSH「插件 → dsh-icarus → 联网搜索」，填写至少一家 API key，点击“保存并测试”。卡片显示凭据来源、连接结果及本月用量。填写多家后按剩余免费额度占比分摊请求，服务失败时自动切换；认证失败须修改 key 或重新测试，限流与暂时故障按冷却时间恢复。搜索结果和每次调用的计量进入本机证据记录。

申请步骤与额度核对日期：2026-10-16。

| 服务 | 申请步骤 | 免费额度 |
|---|---|---|
| Keenable | 在 [登录页](https://app.keenable.ai/login) 注册，进入 [Console](https://app.keenable.ai/console) 创建 Icarus 专用 key，复制以 `keen_` 开头的 key 到卡片并保存 | [每月 100,000 次请求](https://docs.keenable.ai/credits)，搜索与抓取通常每次 1 credit；按厂商实际返回计量 |
| Exa | 在 [Dashboard](https://dashboard.exa.ai) 用邮箱注册，打开 API Keys 创建名为 Icarus 的 key，复制到卡片并保存；免费档无需绑卡 | [每月 10 美元额度，另有 10 美元注册奖励](https://exa.ai/pricing)；Icarus 按每月 10 美元控制调用 |
| Tavily | 在 [Tavily](https://app.tavily.com) 注册，在 API Keys 点 + 新建，Key Type 选 Development，Monthly Limit 填 1000；复制以 `tvly-` 开头的 key 并保存 | [每月 1,000 credits](https://docs.tavily.com/documentation/api-credits)，每月 1 日重置；基础搜索每次 1 credit，深入搜索每次 2 credits；基础抽取每 5 个成功 URL 消耗 1 credit |

只填一家也能使用。key 经宿主凭据服务保存在本机 `~/.dsh/.credentials.yaml`，为明文保存，同一 Windows 账户的程序可读取；建议每家单独为 Icarus 新建 key。系统环境变量中的同名 key 优先，卡片显示只读来源；需在系统设置中修改。非本机地址打开的页面只显示设置。

`icarus_web_search` 支持 `query`、`maxResults`（1–20）、`timeRange` 和 Tavily 的 `depth`。`icarus_web_fetch` 支持 `url` 与 `maxChars`（最多 50,000）。执行提示要求搜索词只写主题；正文优先使用已绑定的 Fetch MCP 或浏览器，读取失败后使用厂商抽取。阅读记录把搜索摘要标为 `snippet`，厂商正文标为 `vendor_extract`；抽取返回 `originStatus: null`，原站状态未知。

搜索查询和抓取 URL 会发送给选中的厂商，抓取由其服务器完成。返回结果保存在本机 Icarus 数据目录，作为成果证据；SearchCall 记录提供者、状态与计量，并关联对应的 Mission、Run 或普通 Session。卡片用量按 Icarus 记录统计，厂商后台为准；未返回实际费用时保留预算预留并显示费用未知。

`icarus_sources create` 支持 `adapter: search`，`locator` 为查询式，`config` 可设置 `timeRange`、`maxResults` 和 `site`。默认每 6 小时检索，最短 1 小时；创建时自动绑定必需搜索能力。结果按 URL 与内容去重后进入 Observation，沿用委托的评估和交付流程。

Mission 的 `searchBudget: { perRun, perMonth }` 随 revision 保存。搜索来源默认每次执行 10 次，普通委托默认 20 次，每月默认 600 次；调用前预留次数，失败尝试同样保留调用记录。超过上限时执行终止为 `budget_exhausted`，已有证据保留。付费调用须有对应 Mission 的明确授权，并设置 `searchBudget.allowPaid: true`。删除委托会删除查询及证据，匿名的提供者计量继续计入免费额度。

高级区块可开启“让 DSH 内置搜索也使用这些服务”，须至少一家连接测试通过。开关修改当前 profile 的 `web` 配置，卡片显示实际生效的 provider，并提示重启核查；关闭后恢复下层配置，本机为 `auto`。`web_fetch` 保持 `http`。内置搜索的调用记为 `host-web-search`，进入提供者月度统计。

| 页面状态 | 处理 |
|---|---|
| 未填写 | 申请一家服务的 key，保存后自动测试 |
| key 无效 | 到厂商后台确认 key 状态，重新粘贴或手动测试；保留实际的 HTTP 400、401 或 403 |
| 本月额度已用完 | 等待页面给出的恢复时间，或核查厂商后台后重新测试；重置时间未知时等待手动测试 |
| 请求太频繁 | 按厂商 `Retry-After` 冷却，没有该字段时等待 60 秒 |
| 暂时连不上 | 展开原始错误查看网络或服务原因；冷却 2 分钟后重试 |
| 接管未生效 | 重启 DSH 后核查卡片中的实际 provider |
| 宿主缺少服务 | 按卡片列出的服务名核对宿主编排与 profile 的插件集；搜索工具本身仍可用 |
| 宿主接口不兼容 | 按 [M3.99 计划](docs/M3.99_PLAN.md) 第 3.3 节逐项核对宿主接口，升级宿主后重新加载 |

桌面兼容目标为 `0.2.0-rc.2`；升级宿主时按 [M3.99 计划](docs/M3.99_PLAN.md) 复核搜索 seam、凭据接口和私有 RPC。

## QQ 接入计划

首个移动渠道采用 **NapCatQQ + OneBot 11 私聊**。常驻主机运行独立 NapCat 进程，登录专用 QQ 账号；Icarus 连接其本机 WebSocket 服务，向用户绑定的本人 QQ 发送简报，并接收反馈与追问。任务和模型执行仍由 Icarus 与 DSH 管理。

M5 按顺序完成账号登录与连接认证、本人身份绑定、outbox 定时发送和消息回执，再接通引用成果的反馈与调查请求。验收要求本人手机在约定时间实际收到简报，回复进入同一 Mission，断线与重启后的投递状态可核查。详细契约见 [PRD 第 9 节](docs/PRD.md#9-qq-触达与数据流)，实施步骤见 [开发计划 M5](docs/DEVELOPMENT_PLAN.md#m5完成桌面qq-与语音交互)。

该路线依赖专用 QQ 账号在线及好友私聊可用。腾讯官方机器人文档已声明停止主动推送，本项目的准点日报采用 NapCat 协议服务。NapCat 由用户独立部署，Icarus 通过协议连接；其现行许可禁止商业使用，商业托管的 QQ 能力须在取得相应授权后提供。依据见 [腾讯消息文档](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)、[NapCat 配置](https://napneko.github.io/config/basic)与[许可证](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)。

## 构建与安装

插件工程在 `packages/dsh-icarus`，在 Node.js 24 与 pnpm 11 上验证通过。

```powershell
cd E:\AI\dsh-icarus\packages\dsh-icarus
pnpm install --frozen-lockfile
pnpm build      # tsc 产出 ESM，esbuild 构建浏览器端模块到 lib/
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

构建与安装命令见上一节；M3 的真实来源、扩展调用与准点交付验证结果见 [M3 开发计划](docs/M3_PLAN.md) 第 9 节，M4 的条目、反馈偏好、模板与调查实现及真实宿主验收结果见 [M4 开发计划](docs/M4_PLAN.md) 第 9 节。

维护者：Zonghe Wu / Jonah Wu。
