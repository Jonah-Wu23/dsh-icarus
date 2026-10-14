# M1 计划：插件工程与 BotBridge

日期：2026-10-14 · 状态：执行中 · 上游依据：[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) §3 M1、[PRD.md](PRD.md) §7–8

## 1. 宿主接口核对结论

核对对象：桌面宿主 `0.2.0-rc.2`（`E:/AI/dsh-harness/resources/app.asar` 解出的运行时源码，参考副本在 `.work/host-0.2.0-rc.2/`）与 `ds-bot@0.1.5`（`~/.dsh/profiles/desktop/node_modules/ds-bot`）。

| 接口点 | 核对结论 | 依据 |
|---|---|---|
| 插件加载 | profile 的 `package.json` 声明依赖与 `dsh.profile.bundles`；bundle 自带 `cordis.patch.yml`，以 `- insert: - id/name` 挂载插件。安装走 `dsh plugin install <spec>`，支持本地路径；HMR 开启时改动即时生效 | `dsh-plugin-manager` README、`~/.dsh/profiles/desktop/package.json`、ds-bot `cordis.patch.yml` |
| 插件形态 | ESM 包：`export const name`、`export const inject = [...]`、`export function apply(ctx, config)`；`package.json` 的 `dsh.bundle.patch` 指向 patch 文件 | ds-bot `index.js`、`package.json` |
| 模型调用 | `ctx.llm.stream({provider, model, messages})`，chunk 流以 `finish` 终结。M1 不直接调用模型，入口确认到此 | `dsh-llm` README |
| 审批入口 | `ctx.approval.request(req)` 必须在打开的 turn 内调用；policy 为 `ask`/`never`；无 answerer 时 fail-closed。**结论：Icarus 的后台执行必须发生在某个 Session 的 turn 内才有审批通道**；审批绑定 Mission revision 属于 M2 | `dsh-user-approval` README |
| Bot 身份解析 | `DSH_HOME/bot/state.json`：`bot.id` 是首个 own-chat Session id（不变），`bot.sessionId` 是当前分段（换代时变化）。写入方持 `state.lock` 并原子 rename；只读读取安全，禁止写入 | ds-bot `store.js` |
| 后台交付 | `ctx.sessionController.prompt({requestId, sessionId, mode:'queue', content})` 是 ds-bot 自身 `/api/bot` send 端点的同款路径；更深一层是 `resolveAgent → agent.followup(message)` + `ctx.sessions.flush(session)`，可携带 ds-bot 内部 `source` 协议（`kind:'bot'`、`role`、exchange 路由） | ds-bot `channel.js`、`delivery.js` |
| 定时唤醒 | `cordis-plugin-timer` 提供 `ctx.timeout/ctx.interval` mixin；宿主 `schedule` 服务仅在 Automation tasks bundle 开启时存在，可选注入。Icarus 自己的 due time 库在 M2 建立，M1 不需要 | `cordis-plugin-timer/lib/index.js`、ds-bot `schedules.js` |

执行决定（在开发计划的基础上拍板）：

1. **交付路径用 `sessionController.prompt(mode:'queue')`**。它只依赖公开服务，与 Bot 收到用户消息同路径，Bot 在自己的会话里收到并回应。ds-bot 内部 `source` 协议（reply 路由、exchange 记录）等 M2 需要双向回路时再切换到 `resolveAgent + followup`。
2. **身份解析每次交付时重读 state.json**。`bot.sessionId` 在会话换代后变化，缓存即错误；读文件是原子安全的。不注入 `schedule`，不复制 ds-bot runtime，不碰 `state.json` 写入，不用浏览器 cookie 的 `/api/bot` 做无人值守凭据（PRD §7 禁令全部遵守）。
3. **M1 不做模型调用与审批调用**，只确认入口存在并记录约束。M1 的"一次真实来源研究成果"由桥接演示链产生：抓取 arXiv `cs.AI` 真实新提交，生成结构化摘要文本，交付到绑定 Bot。

## 2. 工程结构

在仓库建立 `packages/dsh-icarus/`：

```
packages/dsh-icarus/
  package.json          # name dsh-icarus，type module，main lib/index.js，dsh.bundle.patch
  tsconfig.json         # NodeNext ESM，输出 lib/
  cordis.patch.yml      # - insert: - id: icarus / name: dsh-icarus
  src/index.ts          # name/inject/apply：装配 bridge，注册演示交付
  src/bridge/identity.ts   # 只读 state.json，botRef → { botId, sessionId, name }
  src/bridge/deliver.ts    # sessionController.prompt 交付，错误保留原始状态
  src/demo/digest.ts       # arXiv cs.AI 真实抓取 + 摘要 + 一次性交付（config 开关）
```

技术决定：TypeScript 源码用 `tsc` 编译为 ESM 到 `lib/`，不打包。Cordis、dsh-llm 等是 profile 提供的 peer 依赖，打包会造成重复实例。

## 3. 安装与验证

安装（写入 README，可复现）：

```powershell
cd packages/dsh-icarus; pnpm build
# 桌面 profile 安装本地路径 bundle
dsh plugin install E:\AI\dsh-icarus\packages\dsh-icarus --profile desktop
```

M1 完成依据的验证方式：

- 宿主加载插件：profile 重启（或 HMR 生效）后插件列表出现 `icarus`，无加载错误。
- 真实交付：`demo.onBoot` 开启时，插件启动后抓取 arXiv 真实数据并向绑定 Bot（默认 `Chief`）交付一条研究摘要；用户在 Bot 会话中看到该消息且 Bot 能回应。
- 会话换代：交付前重读 `state.json` 取当前 `sessionId`；换代场景在联调记录中验证（交付发生在 Bot 换段之后仍能到达）。
- 错误原始状态：抓取失败、Bot 不存在、prompt 拒绝分别保留原始错误记录，不生成兜底文本。

## 4. 任务拆分

| 任务 | 内容 | 验收 |
|---|---|---|
| T1 | 工程骨架：package.json、tsconfig、cordis.patch.yml、入口装配 | `pnpm build` 通过，产物为 ESM |
| T2 | BotBridge：identity + deliver | 单测级验证：构造假 state.json 解析正确；deliver 走真服务签名 |
| T3 | 演示交付链：arXiv 抓取 + 摘要 + 错误处理 | 断网/Bot 缺失时错误原样记录 |
| T4 | README 构建安装命令 + 真实宿主加载与交付联调 | 宿主插件列表可见、Bot 实际收到消息 |
