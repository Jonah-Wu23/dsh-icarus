// Result delivery through the host's own prompt path — the same route DS Bot's
// `/api/bot` send endpoint uses. The prompt is queued on the target Bot's current
// own-chat Session, so the Bot receives it as an ordinary turn and answers there.
//
// A rejected prompt is recorded as it arrived and rethrown. Nothing here substitutes
// text for a failure.
import { randomUUID } from 'node:crypto'
import type { IcarusContext } from '../types/host.js'

export const DELIVERY_TIMEOUT_MS = 30_000

export interface DeliveryRequest {
  /** Current own-chat Session id of the receiving Bot. */
  readonly sessionId: string
  readonly text: string
  /** Caller lifetime; aborting it cancels the attempt. */
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

/** Render any thrown value for a log line without changing what it says. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

/** Admit one queued prompt on `sessionId`. Rejects with the host's original error. */
export async function deliver(ctx: IcarusContext, request: DeliveryRequest): Promise<void> {
  const timeout = AbortSignal.timeout(request.timeoutMs ?? DELIVERY_TIMEOUT_MS)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  try {
    await ctx.sessionController.prompt(
      {
        requestId: randomUUID(),
        sessionId: request.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: request.text }],
      },
      signal,
    )
  } catch (error) {
    ctx.logger.error('icarus: prompt delivery to %s failed: %s', request.sessionId, errorText(error))
    throw error
  }
}
