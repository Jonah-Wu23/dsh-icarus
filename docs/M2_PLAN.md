# M2 计划：持续委托与执行生命周期

日期：2026-10-14 · 状态：待执行 · 上游依据：[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) §3 M2、[PRD.md](PRD.md) §8 · 前置：[M1_PLAN.md](M1_PLAN.md)（已交付并验收核心链路）

## 0. M2 新增接口核对结论

M1 已核对：插件加载、Bot 身份解析、`sessionController.prompt` 交付、审批服务存在性、定时器。M2 设计前补充核对：

| 接口点 | 核对结论 | 依据 |
|---|---|---|
| SQLite | 桌面运行时 Node `24.18.1`（`resources/runtime/versions.json`），内置 `node:sqlite`，无需原生依赖 | runtime versions.json |
| 自建执行会话 | `sessionController.create({sessionId?, workspaceId? \| cwd?, agentPreset?})` 可创建普通 Session，幂等 adopt；`session/created` 事件存在 | `dsh-api-session-controller/lib/types/commands.js` |
| 执行观察 | `ctx.on('session/event', (session, event) => …)` 暴露 `turn/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`（`reason.kind`: completed/error） | ds-bot `turns.js` 的成熟用法 |
| 实际用量 | `assistant/message` 事件的 `data.usage`，或流 chunk `type:'usage'`：`inputTokens/cacheReadTokens/cacheWriteTokens/outputTokens` | ds-bot `usage.js` |
| 审批审计 | 宿主在 Session 日志内追加 `approval/asked` 与 `approval/decided`（含 requestId）；审批只能在打开的 turn 内请求 | `dsh-user-approval` README |
| Bot 会话边界 | ds-bot 的回合路由只接管 `isBotSession` 的 Session；Icarus 自建执行会话不被 Bot 逻辑接管，双方互不干扰 | ds-bot `turns.js` L262 |

执行决定（拍板）：

1. **执行模型 = Icarus 自建执行会话**。Run 创建自己的 Session（cwd 取 Icarus 数据目录下的执行工作区），用 `prompt` 驱动，用 `session/event` 观察到 `turn/end`，从事件流收成果文本与实际 usage。不借用 Bot 的会话：Bot 只收最终交付。这样审批天然落在执行会话的 turn 里（宿主通道有效），usage 归属清晰，Bot 的聊天上下文不被任务执行污染。
2. **存储用 `node:sqlite`**。WAL 模式、单写方假设（与 ds-bot 的 state.lock 同款约束，写进文档）；数据目录 `$DSH_HOME/icarus/`：`icarus.sqlite` + `artifacts/`（原始资料与成果文件）+ `workspace/`（执行会话 cwd）。
3. **调度自管 due time，Cordis 定时器只负责唤醒**（PRD §8.3）。不注入宿主 `schedule` 服务，避免与现有提醒双调度。
4. **schema 一次建全，逻辑分期接线**。PRD §8.1 八张表在 M2.1 全部落库（迁移框架管理）；Source/Observation 的采集逻辑在 M3、Feedback/PreferenceRevision 的整理逻辑在 M4，M2 只让 Mission/Run/Deliverable/Outbox 跑通。
5. **M2 无 UI**。「可查看」= 插件对宿主暴露的内部服务 `ctx.icarus`（查询/操作 API）+ 测试与联调脚本驱动。界面在 M5。

## 1. 子阶段划分

```
M2.1 存储地基 ──> M2.2 Mission 域服务 ──> M2.3 执行生命周期 ──> M2.4 预算 ──> M2.5 审批绑定与错误档案
                                          （调度/租约/恢复 ↑ 依赖 2.1/2.2）
```

### M2.1 存储地基

任务：
- 数据目录与打开方式：`$DSH_HOME/icarus/icarus.sqlite`，WAL、`busy_timeout`、外键开启；打开即跑迁移。
- 迁移框架：`schema_migrations(version PRIMARY KEY, appliedAt)`；迁移为编号 SQL 串，事务内执行，可重复打开幂等。
- 0001 迁移：PRD §8.1 八张表，字段按 PRD 原样落（Mission/Source/Run/Observation/Deliverable/Feedback/PreferenceRevision/Outbox）。关键约束：
  - `Mission.revision` 单调递增，`(id, revision)` 落历史表 `MissionRevision`（每次修改一行快照），当前行保存最新 revision。
  - `Run (missionId, missionRevision, preferenceRevision, status, sessionId, leaseOwner, leaseUntil, generation, …)`；唯一约束 `(missionId, generation)` 防重复领取。
  - `Outbox` 唯一约束 `(deliverableId, channel)` 防重复投递；状态含 `pending/sent/delivery_unknown/failed`。
  - `Deliverable.content` 存摘要与指纹，正文与原始资料落 `artifacts/` 文件，库存引用路径。
- 导出/删除占位：表设计预留 ownerBotId 维度的级联删除路径（M5 才接 UI，M2 先把删除函数写对）。

验收：迁移重复执行结果一致；八张表 DDL 与 PRD §8.1 字段一一对应；node:test 覆盖迁移幂等与唯一约束。

### M2.2 Mission 域服务

任务：
- 状态机 `active/paused/completed/cancelled`：转换表显式定义，非法转换抛错（如 cancelled 不可复活）。循环委托成功交付后保持 `active`；单次委托（`kind: 'once'`）交付成功 → `completed`。
- CRUD：create（kind/objective/requirements/schedule/timezone/budget/authorizationRef/ownerBotId）、modify（产生 revision+1，快照入 `MissionRevision`）、pause/resume、cancel。每次修改即新 revision，**不接受对旧 revision 的写入**。
- 服务面：`ctx.icarus.missions`（create/get/list/modify/pause/resume/cancel/history），插件内装配，供 M3–M5 与测试调用。
- due time 计算：`schedule`（daily HH:mm + IANA 时区 / cron / once）→ 下一到期时刻入库 `nextDueAt`；修改 schedule 立即重算。

验收：node:test 覆盖状态机全转换、revision 快照链、due time 在时区边界（含夏令时不存在的本地时刻取较早瞬间）的计算。

### M2.3 执行生命周期

任务：
- 调度器：每 60s（`ctx.interval`）扫 `nextDueAt <= now AND status='active'` 的 Mission，事务内创建 `Run(queued)` 并把 `nextDueAt` 推进到下一周期——崩溃也只丢一次唤醒，不重复建 Run（唯一约束兜底）。
- 租约与代次：领取 = 事务内 `queued → running` + 写 `leaseOwner(实例 id)/leaseUntil/generation`。`generation` 取自 Mission 当前 revision 与全局代次计数；**提交成果前校验 Run 仍是 running、租约未过期、generation 与 Mission 当前 revision 一致**，否则提交拒绝并转 `superseded`。过期执行者不能提交新结果。
- 执行器：为 Run 创建执行会话（`sessionController.create`，cwd=`$DSH_HOME/icarus/workspace`），装载 Mission 当前 objective/requirements 为任务 prompt，`prompt` 驱动；监听 `session/event` 至 `turn/end`：
  - completed → 收 `assistant/message` 文本为候选成果；
  - error → `failed`，保留原始错误（code/status/requestId）入 `errorRef`；
  - 中途宿主重启 → 重启恢复逻辑见下。
- 要求核对：Run 结束前按 `requirements` 逐条核对候选成果（M2 用程序可判的结构核对：非空、含来源引用标记、长度下限；语义判断留 M3 起交给模型），核对过 → 持久化 `Deliverable` + artifacts 文件 → `Outbox(pending)` → BotBridge 交付 → 成功回执（prompt 无错返回）→ `sent`；prompt 超时无法确认 → `delivery_unknown`；核对不过 → `failed` 并保留原因。
- 重启恢复：插件加载时扫 `running/awaiting_approval` 的 Run：租约已过期 → 按「旧执行」处理转 `superseded` 并重新排队（新 generation）；`queued` 直接由调度器再领取。**旧版本成果提交走同一条代次校验**，统一在状态转换里拒绝。
- Run 查询：`ctx.icarus.runs`（get/list by mission/状态、含 usage 与成果引用）。

验收（对应 DEVELOPMENT_PLAN 完成依据）：
- 关闭窗口（插件卸载/宿主重启）后 Mission 仍在，重启后调度继续。
- 修改 Mission 后，基于旧 revision 的在途执行提交被拒（superseded），新执行遵循新要求。
- 长期委托一次交付后仍 `active`；`once` 委托交付后 `completed`。
- node:test 覆盖：租约过期抢占、代次拒绝、重启恢复分支、delivery_unknown 转换。

### M2.4 预算

任务：
- Mission `budget`：token 硬上限（input+output 合计），价格未知时只展示 token 用量（PRD §8.3）。
- 预留/结算：Run 启动前按配置估算上限做预留（`budgetReserved`），执行中从 `session/event` 的 usage 事件累计实际用量，Run 结束按实际结算（`usage` 字段落库）。**结算点收在执行器收口处**：M3 起采集解释、反馈整理、重跑的每一次模型调用都必须经由执行器发起，否则不予计量、不予放行。
- 上限闸门：预留超过 Mission 剩余预算 → Run 直接 `budget_exhausted`，不发起任何模型调用；结算后更新 Mission 累计用量。
- 用量查询并入 `ctx.icarus.runs` 返回。

验收：预算为 0 的 Mission 到期产生 `budget_exhausted` 的 Run 且零模型调用；node:test 覆盖预留/结算/超额闸门。

### M2.5 审批绑定与错误档案

任务：
- 审批记录：监听执行会话日志中的 `approval/asked`/`approval/decided`，把 requestId、动作、结果绑定到 `Run.id` + `missionId` + `missionRevision` 落 `Run.approvalRefs`。宿主要求审批的动作（沙箱升级等）在执行会话 turn 内发生，天然满足「打开的 turn」前提。
- 状态映射：Run 执行中被审批挂起 → `awaiting_approval`；拒绝 → `failed`（原因保留）；超时未答复 → 按宿主语义失败，不自动放行。
- 错误档案：所有失败保留原始错误结构（code/message/status/requestId/堆栈摘要）于 `errorRef` 指向的 artifacts 文件，DB 存摘要；禁止把失败改写为成功文本。
- 移动端答复审批、过期 request 重发属于 M5；本阶段定义记录契约并联调桌面路径。

验收：一次真实需要审批的执行（如执行会话内触发沙箱升级）在 Run 上留下完整审批链；拒绝路径产生 `failed` 与原始记录。

## 2. 依赖与顺序

```mermaid
flowchart LR
    A[M2.1 存储] --> B[M2.2 Mission 服务]
    B --> C[M2.3 执行生命周期]
    C --> D[M2.4 预算]
    C --> E[M2.5 审批绑定]
    D --> F[M2 联调验收]
    E --> F
```

M2.4 依赖 M2.3 的执行器收口；M2.5 依赖 M2.3 的执行会话。M2.3 是最长路径。

### 已确认的实现接缝（验收记录）

- `Mission.kind` 落地为生命周期型（`once` / `recurring`），不是 PRD 的业务模板型（论文/申请/兴趣/investigate）。DB 对 kind 无 CHECK，M4 接三个模板与 investigate 时在域层扩类型或加 `template` 列（走新迁移），届时显式决策。
- `ctx.icarus` 服务面：`ctx.provide('icarus', { missions })`，其他插件 `inject: ['icarus']` 取用；已用宿主 cordis 4.0.4 实测该机制成立。
- 交付后状态入口为 `missions.recordDelivery(id)`；防重复交付靠 Outbox 状态，不靠状态机。
- 代次校验用 `revision`，不用 `updatedAt`（pause/resume 也改 updatedAt）。
- **预留在内存，不落库**：M2.4 的预留 = claim 时读到的 `budget - budgetUsed`，只作为本次 Run 的可用上限存在执行器内存里，没有 `Run.budgetReserved` 列。理由：M2.3 串行执行，没有并发方需要看见这份预留；落库反而会给人"闸门已考虑预留"的错觉。M4 做并发时按此接缝补齐——0002 迁移加 `Run.budgetReserved`，闸门从 `budgetUsed >= budget` 改成 `budgetUsed + 活跃预留 >= budget`，并在结算时释放预留。
- **无估算式预留（留 M4）**：闸门只看已结算量（`budgetUsed >= budget` → 零调用），不做"输入规模估算 + 用户设定的最大输出"的预检。真正的预留式闸门需要先有估算策略与用户可配的上限，属 M4 并发+预算策略，M2.4 不擅自加参数。
- **超支不销毁成果（拍板）**：超上限判定发生在模型调用之后（token 已消耗），因此 M2.4 采取"超上限照常核对、落库、投递，Run 记 `succeeded`，真实用量结算进 `budgetUsed`"。上限阻止的是新增调用（claim 闸门），不是已付费的交付。超支后 `budgetUsed > budget`、Run 视图 `remaining` 为负，超支记录在 `runs/<id>/budget.txt`（`kind: budget-overrun`，含 reserved/spent/overshoot），并在交付文本里显式提示；闸门在下一个 Run 生效。`runs/<id>/budget.txt` 的另一种是 `kind: budget-exhausted`（闸门拒绝，零调用）。

## 3. M2 总验收（联调，真实宿主）

1. 通过 `ctx.icarus.missions` 创建一个长期委托（每日 21:00 Asia/Singapore 的假日报任务，预算有限），重启宿主后委托存在且 `nextDueAt` 正确。
2. 到期后产生 Run、真实执行会话跑一个最小任务、成果经 outbox 交付到绑定 Bot（Chief），Run 显示实际 token 用量。
3. 执行中途修改委托：在途 Run 提交被拒（superseded），下一 Run 用新 revision。
4. 把 Mission 预算调到 0：到期 Run 为 `budget_exhausted`，无模型调用。
5. 长期委托交付一次后仍 `active`；单次委托交付后 `completed`。

## 4. 明确不做（M2 边界）

- 不接真实来源采集（M3），M2.3 的「成果」由执行会话直接产出。
- 不做反馈与偏好整理（M4）、不做任何界面（M5）、不接 Telegram（M5）。
- 不写宿主 `schedule` 服务、不改 ds-bot 任何文件、不写 `state.json`（M1 已立禁令，延续有效）。
