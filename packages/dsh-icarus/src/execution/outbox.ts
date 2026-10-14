// Outbox: the delivery step after a deliverable is persisted.
//
// Status machine (M2 plan §M2.1):
//   pending → sent | delivery_unknown | failed
// `sent` means the host accepted the prompt for the destination Session. `delivery_unknown`
// means the attempt timed out or was aborted, so whether the Bot saw it cannot be told —
// a later attempt is due. `failed` means the attempt was refused with a definite error. A
// retry is a new attempt on the same row (attemptCount + 1); the worker that picks retries up
// by `nextAttemptAt` is M3, so M2.3 records the schedule and stops there.
import { deliver, errorText } from '../bridge/deliver.js'
import { resolveIdentity } from '../bridge/identity.js'
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
    db.prepare('UPDATE Outbox SET status = ?, attemptCount = ?, destinationRef = ?, nextAttemptAt = ?, updatedAt = ? WHERE id = ?')
      .run(status, attemptCount, destinationRef, status === 'sent' ? null : at + retryDelayMs, at, outboxId)
    return { outboxId, status, destinationRef, attempted: true }
  }

  return {
    async attempt(outboxId) {
      const row = rowOrThrow(outboxId)
      if (row.status === 'sent') return { outboxId, status: 'sent', destinationRef: row.destinationRef, attempted: false }
      const deliverable = db.prepare('SELECT content FROM Deliverable WHERE id = ?').get<{ content: string }>(row.deliverableId)
      if (deliverable === undefined) throw new Error(`icarus: Outbox ${outboxId} points at missing Deliverable ${row.deliverableId}`)
      const attemptCount = row.attemptCount + 1
      const controller = new AbortController()
      try {
        const identity = await resolveIdentity(options.bot, { dshHome: options.dshHome })
        await withTimeout(
          deliver(options.ctx, { sessionId: identity.sessionId, text: deliverable.content, signal: controller.signal, timeoutMs }),
          timeoutMs,
          controller,
        )
        options.ctx.logger.info('icarus: delivered %s to %s (%s)', row.deliverableId, identity.name, identity.sessionId)
        return settle(outboxId, 'sent', attemptCount, identity.sessionId)
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
