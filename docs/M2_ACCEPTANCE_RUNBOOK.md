# M2 总验收 runbook（真实宿主联调）

日期：2026-10-14 · 执行：Chief（手动三步由用户点）· 依据：[M2_PLAN.md](M2_PLAN.md) §3 总验收、§5 M2.5 计划
驱动脚本：`E:\AI\dsh-icarus\.work\m2-acceptance-driver\`（本地 harness，Git 忽略，不进包）

验收要证明的五条（M2_PLAN §3）+ 两条 GUI 审批路径。其中三步只能人手做：**同意审批**、**拒绝审批**、**重启宿主**。

## 1. 前置（一次性）

1. 构建与测试：`cd E:\AI\dsh-icarus\packages\dsh-icarus; pnpm build; pnpm test` → 85 pass / 0 fail。
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
| 4b | 单次委托边界（可选） | `{"step":"superseded-once"}` | `finding`，`neverRan=true` |
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

## 6. 发现与边界

- **发现（待裁定）**：`once` 委托在途被修改 → 在途 Run 被 `superseded`，但 `once` 没有下一次到期，`nextDueAt` 为 `null`、Mission 停在 `active`，新 revision 永不执行。证据：驱动 selftest 的 `superseded-once`（`mission.status=active`、`nextDueAt=null`、只有 1 个 revision 1 的 superseded Run）。建议修法：supersede 之后若 Mission 仍 `active` 且 `nextDueAt` 为 `null` 或已过，补一个当前 revision 的 queued Run——与 `claim()` 处理过期 Run 的分支同款。属 M2.3 语义，需负责人决定是并入 M2 总验收修掉还是记入 M3 前置。
- 驱动插件是本地 harness，不进包、不写 Icarus 的数据库结构，只用 `ctx.icarus` 的公开服务面。
- 执行超时默认 10 分钟：人工审批拖过这个时间会走 `approval-timeout`（fail-closed），验收时别把弹窗挂着不管。

## 7. 验收后回滚

```powershell
dsh plugin --profile desktop remove dsh-icarus-acceptance
dsh plugin --profile desktop install
```
再把前置第 4 步改动的 `permission.defaultPreset` 改回原样（icarus 行的演示关闭与租约设置常驻，不动），删除 `.work\m2-acceptance\` 与 `.work\m2-acceptance-driver\`。

## 8. 驱动自身的验证

`node E:\AI\dsh-icarus\.work\m2-acceptance-driver\driver-selftest.mjs` —— 在宿主自带的 Cordis 构建里挂真实 Icarus 插件 + 假 sessionController，逐个跑全部步骤并断言证据字段。它证明驱动与检查点成立；真实模型、GUI 与权限预设仍由本 runbook 的人工步骤负责。
