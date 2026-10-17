import { deliver, errorText } from '../bridge/deliver.js'
import { resolveIdentity } from '../bridge/identity.js'
import { inTransaction } from '../domain/index.js'
import { newId } from '../domain/ids.js'
import { readArtifact, writeArtifact } from './artifacts.js'
import { listItems } from './items.js'
import type { IcarusContext } from '../types/host.js'
import type { IcarusDatabase } from '../storage/index.js'
import type { OutboxView } from './runs.js'

export type OutboxStatus = 'pending' | 'sent' | 'delivery_unknown' | 'failed'
export const OUTBOX_CHANNEL_BOT = 'bot'
export const RETRY_DELAY_MS = 15 * 60_000
export const DELIVERY_TIMEOUT_MS = 30_000

export interface DeliveryAttempt {
  readonly outboxId: string
  readonly status: OutboxStatus
  readonly destinationRef: string | null
  readonly attempted: boolean
}

export interface OutboxOptions {
  readonly onSent?: (deliverableId: string) => void
  readonly database: IcarusDatabase
  readonly ctx: IcarusContext
  readonly bot: string
  readonly dshHome?: string | undefined
  readonly now?: (() => number) | undefined
  readonly retryDelayMs?: number | undefined
  readonly timeoutMs?: number | undefined
}

export interface OutboxService {
  attempt(outboxId: string): Promise<DeliveryAttempt>
  tick(): Promise<readonly DeliveryAttempt[]>
  get(outboxId: string): OutboxView
  listForDeliverable(deliverableId: string): OutboxView[]
  attempts(outboxId: string): readonly unknown[]
  receipt(outboxId: string): unknown
  reconcile(outboxId: string): Promise<DeliveryAttempt>
  dispose(): Promise<void>
}

export class OutboxNotFoundError extends Error {
  constructor(outboxId: string) { super(`icarus: no Outbox row ${JSON.stringify(outboxId)}`); this.name = 'OutboxNotFoundError' }
}

interface OutboxRow extends OutboxView { readonly purpose: 'deliverable' | 'fault' }
interface DeliveryTarget { readonly content: string; readonly missionId: string; readonly ownerBotId: string; readonly revision: number; readonly missionRevision: number; readonly missionStatus: string; readonly deliveryWindowId: string | null; readonly windowStatus: string | null; readonly windowDeliverable: string | null; readonly dueAt: number | null; readonly activeFault: number }
const OUTBOX_COLUMNS = 'id, deliverableId, channel, destinationRef, status, attemptCount, receiptRef, nextAttemptAt, purpose'

export function createOutboxService(options: OutboxOptions): OutboxService {
  const now = options.now ?? Date.now
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS
  const { db, paths } = options.database
  const stopping = new AbortController()
  const active = new Map<string, Promise<DeliveryAttempt>>()
  let ticking: Promise<readonly DeliveryAttempt[]> | undefined
  function rowOrThrow(id: string): OutboxRow {
    const row = db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM Outbox WHERE id = ?`).get<OutboxRow>(id)
    if (row === undefined) throw new OutboxNotFoundError(id)
    return row
  }
  /** What the pre-authorized investigations did, so the Bot can explain started and deferred proposals. */
  function explorationSummary(deliverableId: string): string {
    const rows = db.prepare('SELECT question, status, decidedReason, investigationMissionId FROM ExplorationProposal WHERE deliverableId = ? ORDER BY createdAt').all<{ question: string; status: string; decidedReason: string | null; investigationMissionId: string | null }>(deliverableId)
    if (rows.length === 0) return ''
    const lines = rows.map(row => row.status === 'launched'
      ? `已启动调查：${row.question}（Mission ${row.investigationMissionId ?? '?'}）`
      : `待决定建议：${row.question}（${row.decidedReason ?? row.status}）`)
    return `\n\n主动调查：\n${lines.join('\n')}`
  }

  function target(row: OutboxRow): DeliveryTarget {
    const result = db.prepare(`SELECT Deliverable.content, Mission.id AS missionId, Mission.ownerBotId, Mission.revision, Mission.status AS missionStatus, Run.missionRevision, Run.deliveryWindowId,
      DeliveryWindow.status AS windowStatus, DeliveryWindow.deliverableId AS windowDeliverable, DeliveryWindow.dueAt,
      EXISTS(SELECT 1 FROM Fault WHERE Fault.deliverableId = Deliverable.id AND Fault.clearedAt IS NULL) AS activeFault
      FROM Deliverable JOIN Run ON Run.id = Deliverable.runId JOIN Mission ON Mission.id = Run.missionId
      LEFT JOIN DeliveryWindow ON DeliveryWindow.id = Run.deliveryWindowId WHERE Deliverable.id = ?`).get<DeliveryTarget>(row.deliverableId)
    if (result === undefined) throw new Error('icarus: Outbox points at a missing Deliverable')
    return result
  }
  function eligible(row: OutboxRow, value: DeliveryTarget): boolean {
    return !stopping.signal.aborted && (row.status === 'pending' || row.status === 'failed') && (row.nextAttemptAt === null || row.nextAttemptAt <= now())
      && value.missionStatus === 'active' && value.revision === value.missionRevision
      && (row.purpose === 'fault' ? value.activeFault === 1 : value.deliveryWindowId === null || (value.windowStatus === 'prepared' && value.windowDeliverable === row.deliverableId && value.dueAt !== null && value.dueAt <= now()))
  }
  function unchanged(row: OutboxRow): DeliveryAttempt { return { outboxId: row.id, status: row.status as OutboxStatus, destinationRef: row.destinationRef, attempted: false } }
  function settle(row: OutboxRow, attemptId: string, status: OutboxStatus, sessionId: string | null, receiptRef: string | null, errorRef: string | null): DeliveryAttempt {
    const at = now()
    inTransaction(options.database, () => {
      db.prepare('UPDATE Outbox SET status = ?, destinationRef = ?, receiptRef = ?, nextAttemptAt = ?, updatedAt = ? WHERE id = ?')
        .run(status, sessionId, receiptRef, status === 'failed' ? at + retryDelayMs : null, at, row.id)
      db.prepare('UPDATE OutboxAttempt SET status = ?, sessionId = ?, endedAt = ?, errorRef = ?, receiptRef = ? WHERE id = ?')
        .run(status === 'sent' ? 'accepted' : status === 'failed' ? 'failed' : 'unknown', sessionId, at, errorRef, receiptRef, attemptId)
      if (status === 'sent') options.onSent?.(row.deliverableId)
    })
    return { outboxId: row.id, status, destinationRef: sessionId, attempted: true }
  }
  async function runAttempt(id: string): Promise<DeliveryAttempt> {
    const row = rowOrThrow(id)
    const destination = target(row)
    if (!eligible(row, destination)) return unchanged(row)
    const attemptId = newId('delivery_attempt')
    const claimed = inTransaction(options.database, () => {
      const current = rowOrThrow(id)
      if (current.attemptCount !== row.attemptCount || !eligible(current, target(current))) return false
      db.prepare("UPDATE Outbox SET status = 'delivery_unknown', attemptCount = attemptCount + 1, nextAttemptAt = NULL, updatedAt = ? WHERE id = ?").run(now(), id)
      db.prepare("INSERT INTO OutboxAttempt(id, outboxId, attemptNumber, requestId, status, startedAt) VALUES (?, ?, ?, ?, 'sending', ?)").run(attemptId, id, row.attemptCount + 1, id, now())
      return true
    })
    if (!claimed) return unchanged(rowOrThrow(id))
    let sessionId: string | null = row.destinationRef
    let dispatched = false
    let accepted = false
    try {
      const identity = await resolveIdentity(destination.ownerBotId, { dshHome: options.dshHome })
      const current = target(row)
      if (current.missionStatus !== 'active' || current.revision !== current.missionRevision || (row.purpose === 'fault' ? current.activeFault !== 1 : current.deliveryWindowId !== null && current.windowStatus !== 'prepared')) {
        // 尚未发出请求，恢复为待投递，暂停或换版后的扫描会再次检查。
        inTransaction(options.database, () => {
          db.prepare("UPDATE Outbox SET status = 'pending', nextAttemptAt = ?, updatedAt = ? WHERE id = ?").run(now(), now(), id)
          db.prepare("UPDATE OutboxAttempt SET status = 'failed', endedAt = ? WHERE id = ?").run(now(), attemptId)
        })
        return unchanged(rowOrThrow(id))
      }
      sessionId = identity.sessionId
      inTransaction(options.database, () => {
        db.prepare('UPDATE Outbox SET destinationRef = ? WHERE id = ?').run(sessionId, id)
        db.prepare('UPDATE OutboxAttempt SET sessionId = ? WHERE id = ?').run(sessionId, attemptId)
      })
      stopping.signal.throwIfAborted()
      const items = listItems(options.database, { deliverableId: row.deliverableId })
      const itemRecords = items.length === 0 ? '' : `\n\n记录：missionId=${destination.missionId}；deliverableId=${row.deliverableId}；${items.map(item => `${item.ordinal}. itemId=${item.id}`).join('；')}`
      const explorationLine = explorationSummary(row.deliverableId)
      dispatched = true
      const receipt = await deliver(options.ctx, { requestId: id, sessionId, text: `Icarus 后台成果已保存。请阅读交付记录，结合本次背景说明结论和关键依据。${items.length === 0 ? '' : '保留正文中的条目序号，itemId 仅放在结尾记录行。用户追问某个序号时，用 icarus_items 按本成果 ID 和 ordinal 读取证据。'}\n\n${destination.content}${itemRecords}${explorationLine}`,
        signal: stopping.signal, timeoutMs })
      accepted = true
      const window = current.deliveryWindowId === null ? null : db.prepare('SELECT dueAt, timezone FROM DeliveryWindow WHERE id = ?').get(current.deliveryWindowId)
      const receiptRef = writeArtifact(paths, `deliveries/${id}/${attemptId}-receipt.json`, JSON.stringify({ ...receipt, window, actualAcceptedAt: receipt.acceptedAt, confirmation: '宿主已接受 prompt；Bot 的后续答复单独读取 Session 事件' }))
      options.ctx.logger.info('icarus: delivered %s to %s (%s)', row.deliverableId, identity.name, identity.sessionId)
      return settle(row, attemptId, 'sent', sessionId, receiptRef, null)
    } catch (error) {
      if (accepted) throw error
      const uncertain = dispatched && !isDefiniteRefusal(error)
      const ref = writeArtifact(paths, `deliveries/${id}/${attemptId}-error.txt`, errorText(error))
      options.ctx.logger.error('icarus: delivery %s %s: %s', id, uncertain ? 'unconfirmed' : 'failed', errorText(error))
      return settle(row, attemptId, uncertain ? 'delivery_unknown' : 'failed', sessionId, null, ref)
    }
  }
  function attempt(id: string): Promise<DeliveryAttempt> {
    const existing = active.get(id)
    if (existing !== undefined) return existing
    const work = runAttempt(id).finally(() => { active.delete(id) })
    active.set(id, work)
    return work
  }
  return {
    attempt,
    tick() {
      if (ticking !== undefined) return ticking
      const ids = db.prepare("SELECT id FROM Outbox WHERE status IN ('pending','failed') AND (nextAttemptAt IS NULL OR nextAttemptAt <= ?) ORDER BY nextAttemptAt, createdAt, id").all<{ id: string }>(now())
      ticking = Promise.all(ids.map(row => attempt(row.id))).finally(() => { ticking = undefined })
      return ticking
    },
    get: id => ({ ...rowOrThrow(id) }),
    listForDeliverable: id => db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM Outbox WHERE deliverableId = ? ORDER BY channel`).all<OutboxRow>(id),
    attempts: id => db.prepare('SELECT * FROM OutboxAttempt WHERE outboxId = ? ORDER BY attemptNumber').all(id),
    receipt(id) { const ref = rowOrThrow(id).receiptRef; return ref === null ? null : JSON.parse(readArtifact(paths, ref)) as unknown },
    async reconcile(id) {
      const row = rowOrThrow(id)
      if (row.status !== 'delivery_unknown' || row.destinationRef === null) return unchanged(row)
      const observation = await options.ctx.sessionQuery.observeSession(row.destinationRef, { projectionMode: 'none' })
      try {
        const event = observation.events.find(event => {
          const source = event.data?.source
          return event.type === 'user/message' && typeof source === 'object' && source !== null && 'rpcId' in source && source.rpcId === id
        })
        if (event === undefined) return unchanged(row)
        const ref = writeArtifact(paths, `deliveries/${id}/reconciled-receipt.json`, JSON.stringify({ requestId: id, sessionId: row.destinationRef, meaning: 'host_prompt_consumed', eventTime: event.time, checkedAt: now() }))
        const latest = db.prepare('SELECT id FROM OutboxAttempt WHERE outboxId = ? ORDER BY attemptNumber DESC LIMIT 1').get<{ id: string }>(id)
        if (latest === undefined) throw new Error('icarus: uncertain delivery has no attempt record')
        return settle(row, latest.id, 'sent', row.destinationRef, ref, null)
      } finally { observation[Symbol.dispose]() }
    },
    async dispose() { stopping.abort(); await Promise.all(active.values()); await ticking },
  }
}

function isDefiniteRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? error.code : undefined
  return ['gateway/bad-request', 'session/not-found', 'session/agent-busy', 'session/archived', 'session/invalid-time-zone', 'session/attachment-invalid'].includes(String(code))
}
