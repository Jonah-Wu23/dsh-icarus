# Icarus

持续委托的个人情报搭档。围绕用户长期关注的事情，持续发现值得知道的变化，交付有依据的策展内容，并沿着发现继续调查。

产品采用 **策展体验 + Mission 持续执行 + 稳定人格** 的融合路线。以 AI 研究者与独立开发者为首批用户，支持论文追踪、申请动态和兴趣作品三个场景。

## 当前状态

已完成产品规格、仓库初始化、M1 插件工程与 M2 委托执行链。插件可构建并安装到桌面 profile：BotBridge 打通真实交付，Mission 支持版本快照、按日程调度、租约与代次、重启恢复、预算闸门、审批绑定与错误档案；M2 总验收已在真实桌面宿主上逐步通过。M3 起的采集与反馈能力尚未实现。

- [最终 PRD](docs/PRD.md)：产品范围、架构与发布验收的实施依据。
- [开发计划](docs/DEVELOPMENT_PLAN.md)：任务依赖、阶段交付与真实运行验收。
- [设计哲学](PHILOSOPHY.md)：人格、任务与反馈的设计原则。
- [第三方说明](THIRD_PARTY_NOTICES.md)：参考材料与外部组件的使用关系。
- [LICENSE](LICENSE)：项目原创内容采用 Apache-2.0。

`docs/` 下其他报告保留为研究输入；实现以 `docs/PRD.md` 为准。

## 工程方向

Icarus 作为独立 DeepSeek Harness 插件，拥有 Mission、成果与反馈数据。DS Bot 提供持续身份和对话，宿主负责模型执行及审批。通过版本化 BotBridge 接入现有 Bot。

已核查的本机兼容目标为桌面宿主 `0.2.0-rc.2` 与 `ds-bot@0.1.5`。现有语音采用本地识别与浏览器朗读。Node.js/TypeScript 为实现语言，SQLite 为单主持久化存储。

插件源码位于 `packages/dsh-icarus`：TypeScript 编写，`tsc` 编译为 ESM 到 `lib/`，不打包，宿主提供的 peer 依赖不重复安装。BotBridge 已实现稳定身份解析、会话换代与后台成果交付；M1 的演示交付链抓取真实 arXiv 数据交付到绑定 Bot。后续阶段围绕同一条链路实现 PRD 中的完整业务闭环。

## 构建与安装

插件工程在 `packages/dsh-icarus`，在 Node.js 24 与 pnpm 11 上验证通过。

```powershell
cd E:\AI\dsh-icarus\packages\dsh-icarus
pnpm install    # 工程唯一的 devDependency 是 typescript
pnpm build      # tsc 产出 ESM 到 lib/
pnpm test       # node:test，验证身份解析（读取 lib/ 产物，需先 build）
```

安装到桌面宿主。`dsh plugin` 要独占 profile，先完全退出 DSH 桌面应用：

```powershell
dsh plugin --profile desktop add E:\AI\dsh-icarus\packages\dsh-icarus
```

安装把该路径登记为 profile 依赖并选中它的 bundle，重启桌面应用后插件加载；改动源码后需重新 `pnpm build`，宿主重启才会载入新的模块。`packages/dsh-icarus/cordis.patch.yml` 挂载 `icarus` 行并设置 `config.demo.onBoot: true`：插件每次加载执行一次演示交付，抓取 arXiv cs.AI 最新 5 条提交（按提交时间倒序），生成中文结构化摘要，交付到 `config.bot` 指定的 Bot（默认 `Chief`）。要关闭演示，在 profile 的 patch 中覆盖该行 config，写入 `demo: { onBoot: false }`。

Bot 身份在每次交付时从 `$DSH_HOME/bot/state.json` 重读（会话换代后 `sessionId` 变化，缓存即错误）；该文件属于 DS Bot，Icarus 只读。抓取失败、Bot 不存在、prompt 被拒绝均按原始错误记录到插件日志，不生成兜底文本，也不静默跳过。

## 开发约定

遵循 [AGENTS.md](AGENTS.md)。真实失败保留原始状态，语义判断交给模型。任务成功以要求与实际产物为准；预算覆盖全部辅助调用。

本地中间文件放在 `.work/`，由 Git 忽略。凭据、数据库和执行记录不进入仓库。发布需要满足 PRD 的真实宿主与来源验收。

M1 的构建、测试与安装命令见上一节；宿主加载与真实交付的联调由负责人执行。

维护者：Zonghe Wu / Jonah Wu。
