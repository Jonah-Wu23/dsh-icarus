// The host services Icarus depends on, typed at the boundary actually used.
// Signatures mirror the verified 0.2.0-rc.2 API: `SessionPromptRequest` from
// `@deepseek-ai/dsh-api-session-controller`, and the Cordis logger/effect surface.
// Only `import type` reaches these, so the compiled plugin imports no host package.

export interface PromptContentPart {
  readonly type: 'text'
  readonly text: string
}

export interface SessionPromptRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string | undefined
}

export interface SessionPromptValue {
  readonly accepted: true
}

export interface SessionCreateRequest {
  readonly workspaceId?: string | undefined
  readonly cwd?: string | undefined
  readonly sessionId?: string | undefined
  readonly agentPreset?: string | undefined
}

export interface SessionCreateValue {
  readonly sessionId: string
  readonly agentPreset?: string | undefined
}

export interface SessionController {
  /**
   * Admit one prompt. The signal is REQUIRED, not decorative: the host gateway calls
   * `signal.throwIfAborted()` on it with no optional chain (0.2.0-rc.2
   * `dsh-api-session-controller/lib/index.js`, `prompt(request, signal)`), so an omitted argument
   * throws `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')` before the
   * prompt is ever admitted.
   */
  prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
  /** Create or idempotently adopt one ordinary Session (0.2.0-rc.2 `sessionController.create`). */
  create(request: SessionCreateRequest): Promise<SessionCreateValue>
}

/** The Session an event belongs to; only `id` is used. */
export interface SessionLike {
  readonly id?: string | undefined
}

/**
 * One `session/event` record. `data` stays loose on purpose: the execution layer reads the
 * few fields it needs (`message.content`, `usage`, `stream`, `reason`) through narrowing
 * helpers, so a host that adds fields cannot break the plugin.
 */
export interface SessionEventLike {
  readonly type: string
  readonly time?: number | undefined
  readonly data?: Record<string, unknown> | undefined
}

export interface Logger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}

export interface IcarusContext {
  readonly logger: Logger
  readonly sessionController: SessionController
  effect(execute: () => (() => void) | void, label?: string): void
  /** Session lifecycle events, including `turn/end` for Icarus-owned execution Sessions. */
  on(event: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): void
  /** Repeating timer owned by this fiber (cordis-plugin-timer); disposed on unload. */
  interval(callback: () => void, delay: number): () => void
  /**
   * Register a service for other plugins under this fiber. Cordis owns the lifetime:
   * the registration is disposed when the plugin unloads. Consumers reach it as
   * `ctx.<name>` after declaring `inject: ['<name>']`.
   */
  provide(name: string, value: unknown): unknown
}
