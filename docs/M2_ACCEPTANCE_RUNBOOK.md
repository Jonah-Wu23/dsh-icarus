# M2 总验收 runbook（真实宿主联调）

日期：2026-10-14 · 执行：Chief（手动三步由用户点）· 依据：[M2_PLAN.md](M2_PLAN.md) §3 总验收、§5 M2.5 计划
驱动脚本：`E:\AI\dsh-icarus\.work\m2-acceptance-driver\`（本地 harness，Git 忽略，不进包）

验收要证明的五条（M2_PLAN §3）+ 两条 GUI 审批路径。其中三步只能人手做：**同意审批**、**拒绝审批**、**重启宿主**。

## 1. 前置（一次性）

1. 构建与测试：`cd E:\AI\dsh-icarus\packages\dsh-icarus; pnpm build; pnpm test` → 全绿（验收当天 87 pass / 0 fail；收尾补丁后 97）。
2. **完全退出桌面 DSH**（`dsh plugin` 要独占 profile）。
3. Icarus 的启动演示已在 `C:\Users\JonahWu\.dsh\profiles\desktop\cordis.patch.yml` 里常驻关闭，免得验收期被 arXiv 交付刷屏；同一行还把执行租约压到 1 分钟，供步骤 2 的重启存续验证使用：
   ```yaml
   - id: icarus
     name: dsh-icarus
     config:
       bot: Chief
       demo:
         onBoot: false
       execution:
         leaseMs: 60000
   ```
4. **把权限预设改成会问的**，否则审批步骤不会弹窗（证据里 `approvals` 会是空数组）。同一个 patch 文件里的 `permission` 行改成：
   ```yaml
   - id: permission
     name: "@deepseek-ai/dsh-permission-presets"
     config:
       presets:
         read-only: { sandbox: read-only, approval: ask }
         workspace-write: { sandbox: workspace-write, approval: ask }
         danger-full-access: { sandbox: danger-full-access, approval: never }
       defaultPreset: workspace-write
   ```
   若 GUI 设置里已经选过预设，用户层会盖过这里——以 GUI 里选 `workspace-write` 为准。副作用：验收期间你自己聊天的会话默认也会问审批，验收完改回去。
5. 装驱动插件：
   ```powershell
   dsh plugin --profile desktop add E:\AI\dsh-icarus\.work\m2-acceptance-driver
   dsh plugin --profile desktop install
   ```
   然后确认 `C:\Users\JonahWu\.dsh\profiles\desktop\package.json` 的 `dependencies` 里有 `dsh-icarus-acceptance`、`dsh.profile.bundles` 里有 `dsh-icarus-acceptance`（`dsh plugin add` 没写 bundle 列表就手工加进 `bundles` 数组），并确认 `profiles\desktop\node_modules\dsh-icarus-acceptance` 是指向 `.work\m2-acceptance-driver` 的 link。
6. 清空旧证据：删掉 `E:\AI\dsh-icarus\.work\m2-acceptance\` 里的 `state.json`、`evidence.jsonl`、`evidence\`。
7. 启动桌面应用，日志里应出现 `icarus: loaded` 与 `icarus-acceptance: ...`。

## 2. 驾驶方式

写 `E:\AI\dsh-icarus\.work\m2-acceptance\step.json` → **完全退出并重启桌面应用** → 驱动插件在加载时跑这一步 → 证据落到：

- `E:\AI\dsh-icarus\.work\m2-acceptance\evidence.jsonl`（每步一行，追加）
- `E:\AI\dsh-icarus\.work\m2-acceptance\evidence\<时间>-<步骤>.json`（单条完整证据）
- 宿主日志里 `icarus-acceptance: evidence -> …`

规则：一步只跑一次（`state.json` 去重），要重跑就在 `step.json` 里加 `"rerun": true`。`verify-persist` 和 `dump` 是只读步骤，每次加载都会跑。

## 3. 步骤表

| # | 目的 | `step.json` | 期望证据 `outcome` |
|---|---|---|---|
| 1 | 建长期委托 | `{"step":"create-recurring"}` | `created`，`mission.status=active`，`nextDueAt` 在两分钟内 |
| 2 | 重启存续 | `{"step":"verify-persist"}` | `pass`（重启后逐字相同） |
| 3 | 到期真实执行 | `{"step":"due-run"}` | `pass`，`run.status=succeeded`，`run.usage` 有 input/output |
| 4 | 在途改委托 | `{"step":"supersede"}` | `pass`，`inFlightRun.status=superseded`，`nextRun.missionRevision=2`，`missionAtNextRun.status=active` |
| 4b | 单次委托重排 | `{"step":"superseded-once"}` | `pass`，旧 Run `superseded` 且 `mission.nextDueAt` 重新被设上 |
| 5 | 预算闸门 | `{"step":"budget-zero"}` | `pass`，`run.status=budget_exhausted`，`run.sessionId=null` |
| 6 | 单次委托交付 | `{"step":"once-completed"}` | `pass`，`mission.status=completed` |
| 7 | 审批同意 | `{"step":"approval-grant"}` | `pass`，`approvals=[allowed-once]` |
| 8 | 审批拒绝 | `{"step":"approval-deny"}` | `pass`，`approvals=[rejected]` |
| 9 | 快照（随时） | `{"step":"dump"}` | `dump`，Mission/Run 全量 |

步骤 1 建的长期委托是「每日 HH:mm = 当前本地时间 +2 分钟」，所以步骤 3 必须等到那个时刻；期间可以并行做步骤 5、6。
步骤 2/3 的 missionId 与期望值由驱动从步骤 1 的证据里自动读取，`step.json` 里也可以显式写 `missionId`/`expectNextDueAt`/`expectRevision` 覆盖。
步骤 4 建的是 `*/2 * * * *` 的循环委托（下一次到期 ≤2 分钟），跑完驱动会把它 `pause`，避免验收期继续刷交付。

## 4. 手动动作（三步）

1. **重启宿主**：步骤 1 写完后、写步骤 2 之前，完全退出桌面应用再打开。这是「重启存续」的唯一证据来源。
2. **同意审批**：步骤 7 到期后，执行会话里模型会尝试往工作区外写文件并被沙箱拒绝，然后用 `sandbox_permissions` 重试——GUI 弹出审批时点**允许/Enter**。
3. **拒绝审批**：步骤 8 同上，弹窗时点**拒绝/Escape**。

弹窗没出现 → 权限预设还是 `danger-full-access`，回到前置第 4 步。

## 5. 通过判据（逐条对 §3）

1. **长期委托 + nextDueAt**：步骤 1 的 `nextDueAt` 是未来几分钟内的 ISO 时间；步骤 2 在重启后读到完全相同的值与 revision。
2. **到期产生 Run + 真实用量 + 交付**：步骤 3 的 `run.status=succeeded`、`run.usage.inputTokens/outputTokens` 非空、`deliveries[].outbox[].status=sent`，且 Chief 的聊天里真的收到成果。
3. **在途修改被拒 + 新 revision**：步骤 4 的 `inFlightRun.status=superseded`（旧 revision 的提交被拒、成果丢弃），`nextRun.missionRevision=2`（下一次到期用新 revision），`missionAtNextRun.status=active`（循环委托交付后仍 active；驱动随后把它 `pause` 掉以免验收期刷屏）。
4. **预算闸门零调用**：步骤 5 的 `run.status=budget_exhausted`、`run.sessionId=null`（闸门在建会话之前拦下）、`mission.budgetUsed=0`。
5. **单次/循环状态**：步骤 6 的 `mission.status=completed`；步骤 3/4 的 Mission 交付后仍 `active`。
6. **GUI 审批两条路**：步骤 7 链里 `allowed-once`；步骤 8 链里 `rejected` 且 `delivery[0].content` 含「审批未获通过」。若第 8 步的 Run 判 `failed`，`failureArchive.text` 必须含完整 asked/decided 配对（`requestId`/`tool`/`callId`/`outcome`/两个时间）。

## 6. 请求预算与恢复检查

- `once` 执行失败或预算耗尽后保持 `active`，通过 `awaitingReschedule` 显示等待重新排期。编辑会生成新 revision 并重新排期；恢复已暂停的单次委托也会为尚未交付的工作重新安排执行。
- 请求前检查 `ModelCall` 预留。正预算不足以容纳完整输入及最大输出时，Run 为 `budget_exhausted`，模型请求数为零；回合中预算不足时，下一次请求停止，保留实际用量及进展。
- 将 `execution.userTokenBudget` 设为零，确认用户总预算同样阻止模型请求。恢复正常配置后，核对执行与标题调用的费用；Bot 完整阅读交付后，其调用也计入同一 Mission。
- 对宿主已完成、Run 尚未提交的真实回合重启宿主。租约过期后扫描应提交同一 Run 的原成果，执行模型请求数保持原值。中断回合保存用量后登记新的执行代次。
- 同时调用两次 `runs.tick()` 应共享同一条扫描。已暂停的队列不能被领取，取消会终止其等待状态；同一 Mission 不并发启动两次执行。
- 发送前保存未确认状态。`sent` 不重发，`delivery_unknown` 不自动重发；来源及接收会话可核查后再决定下一项动作。
- 执行超时默认 10 分钟，通过宿主取消仍在运行的回合，错误档案保留审批链及实际进展。租约按不超过其时长三分之一的间隔续期。
- 驱动属于本地联调用具，不随插件分发。实际验收使用桌面 `0.2.0-rc.2` 的运行时与真实模型，标准构建及现有测试通过后再检查上述场景。

## 附录 C 宿主行为观察（M2 总验收，2026-10-15）

都不是 Icarus 缺陷，是宿主环境/路由的事实，复现或排查时先看这里：

1. **审批卡片只在所属执行会话里可见**。执行会话在 `$DSH_HOME/icarus/workspace` 下自建，卡片渲染在它自己的界面里；用户停留在别的会话时看不到卡片。要答审批，先在会话列表打开那个执行会话。
2. **沙箱升级的拒绝原文**是 `the user rejected escalating this command to "<mode>"`（`dsh-sandbox` 抛错路径），不是工具级 `ask` 的 `the user rejected tool "<name>"`；两种组合在 `tool errors` 段里的文案不同，判定时按实际原文核。
3. **审批策略是会话级 + 日志持久**：GUI 改预设走 `permissionPresets.set(session, name)`，只往该会话日志追加 `approval/policy`；新建会话在 `pinInitialPermission` 里按 settings 的 `defaultPreset` 钉定。所以聊天会话里切到 `never` 不影响之后新建的执行会话；要复现审批路径，先确认默认预设还是 `workspace-write`/`read-only`（`ask`）。
4. **权限策略 `never` 的语义**不是「不弹卡片」而是服务在派发前直接返回 `rejected`，因此链里会是 `outcome: rejected`；若链为空，说明请求根本没有发出——两者写法不同，别混。
5. **环境侧的两次失败都被档案原样记下**：Kimi 周配额 403（`turn-error / code: AUTH`）与一次 DeepSeek transport 抖动（`code: TRANSPORT`）；换默认模型后继续，与 Icarus 无关。
6. **审批挂起会持续续租**：实测等待 5m27s（§6）与 24s（§7）两轮中 `leaseUntil` 一直跟着走，`awaiting_approval` 不会被自己的租约过期杀掉——这条是 M2.5 挂起语义在真实宿主里的正面证据。

判定用的两条硬证据也记在这里：同意路径看「探针文件在 `decidedAt` 之后被写入」（实测晚 0.3–0.6 秒）；拒绝路径要么用**事前不存在**的新文件名看「文件没出现」，要么比对 mtime 确认**没被改写**——§6 留下的同名文件会让「被拦住」变成假阳性。

## 7. 验收后清理

```powershell
dsh plugin --profile desktop remove dsh-icarus-acceptance
dsh plugin --profile desktop install
```
将前置第 4 步的权限预设恢复为验收前的配置。原始联调记录保留在 Git 忽略的目录中。
