// 发送前原子领取 Outbox 并保存未确认状态，宿主接受后记录 sent。
// delivery_unknown 等待核查；明确失败可登记下一次尝试。
import { deliver, errorText } from '../bridge/deliver.js'
import { resolveIdentity } from '../bridge/identity.js'
import { inTransaction } from '../domain/index.js'
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
  /** False when the row was already settled and nothing was sent. */
  readonly attempted: boolean
}

export interface OutboxOptions {
  readonly onSent?: (deliverableId: string) => void
  readonly database: IcarusDatabase
  readonly ctx: IcarusContext
  /** Bot id or name that receives deliveries (`config.bot`). */
  readonly bot: string
  readonly dshHome?: string | undefined
  readonly now?: (() => number) | undefined
  readonly retryDelayMs?: number | undefined
  readonly timeoutMs?: number | undefined
}

export interface OutboxService {
  /** Attempt one delivery and record its outcome. */
  attempt(outboxId: string): Promise<DeliveryAttempt>
  get(outboxId: string): OutboxView
  listForDeliverable(deliverableId: string): OutboxView[]
}

export class OutboxNotFoundError extends Error {
  constructor(outboxId: string) {
    super(`icarus: no Outbox row ${JSON.stringify(outboxId)}`)
    this.name = 'OutboxNotFoundError'
  }
}

interface OutboxRow {
  readonly id: string
  readonly deliverableId: string
  readonly channel: string
  readonly destinationRef: string | null
  readonly status: string
  readonly attemptCount: number
  readonly receiptRef: string | null
  readonly nextAttemptAt: number | null
}

const OUTBOX_COLUMNS = 'id, deliverableId, channel, destinationRef, status, attemptCount, receiptRef, nextAttemptAt'

export function createOutboxService(options: OutboxOptions): OutboxService {
  const now = options.now ?? (() => Date.now())
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS
  const { db } = options.database

  function rowOrThrow(outboxId: string): OutboxRow {
    const row = db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM Outbox WHERE id = ?`).get<OutboxRow>(outboxId)
    if (row === undefined) throw new OutboxNotFoundError(outboxId)
    return row
  }

  function settle(outboxId: string, status: OutboxStatus, attemptCount: number, destinationRef: string | null): DeliveryAttempt {
    const at = now()
    inTransaction(options.database, () => {
      db.prepare('UPDATE Outbox SET status = ?, attemptCount = ?, destinationRef = ?, nextAttemptAt = ?, updatedAt = ? WHERE id = ?')
        .run(status, attemptCount, destinationRef, status === 'failed' ? at + retryDelayMs : null, at, outboxId)
      if (status === 'sent') options.onSent?.(rowOrThrow(outboxId).deliverableId)
    })
    return { outboxId, status, destinationRef, attempted: true }
  }

  return {
    async attempt(outboxId) {
      const row = rowOrThrow(outboxId)
      if (row.status === 'sent') return { outboxId, status: 'sent', destinationRef: row.destinationRef, attempted: false }
      if (row.status === 'delivery_unknown') return { outboxId, status: 'delivery_unknown', destinationRef: row.destinationRef, attempted: false }
      const deliverable = db.prepare(`SELECT Deliverable.content, Mission.ownerBotId FROM Deliverable
        JOIN Run ON Run.id = Deliverable.runId JOIN Mission ON Mission.id = Run.missionId
        WHERE Deliverable.id = ?`).get<{ content: string; ownerBotId: string }>(row.deliverableId)
      if (deliverable === undefined) throw new Error(`icarus: Outbox ${outboxId} points at missing Deliverable ${row.deliverableId}`)
      const attemptCount = row.attemptCount + 1
      const claimed = db.prepare(`UPDATE Outbox SET status = 'delivery_unknown', attemptCount = ?, nextAttemptAt = NULL, updatedAt = ?
        WHERE id = ? AND status IN ('pending', 'failed') AND attemptCount = ?`).run(attemptCount, now(), outboxId, row.attemptCount)
      if (Number(claimed.changes) === 0) {
        const current = rowOrThrow(outboxId)
        return { outboxId, status: current.status as OutboxStatus, destinationRef: current.destinationRef, attempted: false }
      }
      const controller = new AbortController()
      let destinationRef: string
      try {
        const identity = await resolveIdentity(deliverable.ownerBotId, { dshHome: options.dshHome })
        const current = db.prepare(`SELECT Mission.revision, Mission.status, Run.missionRevision FROM Deliverable
          JOIN Run ON Run.id = Deliverable.runId JOIN Mission ON Mission.id = Run.missionId WHERE Deliverable.id = ?`)
          .get<{ revision: number; status: string; missionRevision: number }>(row.deliverableId)
        if (current === undefined || current.revision !== current.missionRevision || current.status === 'cancelled') {
          throw new Error('icarus: delivery belongs to a cancelled or superseded Mission')
        }
        destinationRef = identity.sessionId
        await withTimeout(
          deliver(options.ctx, {
            requestId: outboxId,
            sessionId: identity.sessionId,
            text: `Icarus 后台成果已保存。请阅读下面的交付记录，用简短答复说明结论及关键依据。\n\n${deliverable.content}`,
            signal: controller.signal,
            timeoutMs,
          }),
          timeoutMs,
          controller,
        )
        options.ctx.logger.info('icarus: delivered %s to %s (%s)', row.deliverableId, identity.name, identity.sessionId)
      } catch (error) {
        // The raw error is logged as it arrived; the Outbox row records only what the
        // attempt established. A channel receipt reference is M3 (no receipt column until then).
        if (isUncertain(error)) {
          options.ctx.logger.warn('icarus: delivery of %s is unconfirmed: %s', row.deliverableId, errorText(error))
          return settle(outboxId, 'delivery_unknown', attemptCount, row.destinationRef)
        }
        options.ctx.logger.error('icarus: delivery of %s failed: %s', row.deliverableId, errorText(error))
        return settle(outboxId, 'failed', attemptCount, row.destinationRef)
      }
      return settle(outboxId, 'sent', attemptCount, destinationRef)
    },

    get(outboxId) {
      return { ...rowOrThrow(outboxId) }
    },

    listForDeliverable(deliverableId) {
      return db.prepare(`SELECT ${OUTBOX_COLUMNS} FROM Outbox WHERE deliverableId = ? ORDER BY channel`).all<OutboxRow>(deliverableId).map(row => ({ ...row }))
    },
  }
}

/** A timeout or an abort leaves the send unconfirmed; anything else is a definite refusal. */
function isUncertain(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError' || error.name === 'AbortError'
}

/** Bound one attempt: a prompt that never settles must not hold the scheduler. */
async function withTimeout<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: TimerHandle | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          const error = new Error(`icarus: delivery was not confirmed within ${ms} ms`)
          error.name = 'TimeoutError'
          reject(error)
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
