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

export interface SessionController {
  prompt(request: SessionPromptRequest, signal?: AbortSignal | undefined): Promise<SessionPromptValue>
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
}
