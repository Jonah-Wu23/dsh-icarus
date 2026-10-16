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
  cancel(request: { readonly sessionId: string }): { readonly accepted: true }
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

export interface HostAgent {
  readonly id: string
  readonly session: { readonly id: string; readonly header: { readonly cwd?: string } }
  cancel(cause: { readonly kind: 'user' }, options: { readonly keepInbox: true }): void
}

export interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string; readonly [key: string]: unknown }[]
  readonly value?: unknown
  readonly isError?: boolean
  readonly error?: { readonly message: string; readonly info?: unknown }
}

export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface PostToolDecision {
  readonly kind: 'accept' | 'block'
  readonly content?: ToolResult['content']
  readonly value?: unknown
  readonly [key: string]: unknown
}

export interface HostToolDefinition extends ToolSchema {
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    render(args: Readonly<Record<string, unknown>>, value: unknown): readonly { readonly type: 'text'; readonly text: string }[]
  }
  execute(args: Readonly<Record<string, unknown>>, exec: { readonly agent?: HostAgent; readonly signal: AbortSignal; readonly callId: string }): Promise<unknown>
}

export interface IcarusContext {
  readonly icarus: import('../index.js').IcarusService
  inject(services: readonly string[], callback: (ctx: IcarusContext) => void): unknown
  /** Read a service without declaring it: `undefined` while absent or still loading. */
  get(name: string): unknown
  readonly web: {
    readonly searchProviderId?: string
    readonly fetchProviderId?: string
    registerSearchProvider(provider: { readonly id: string; available(): boolean; search(request: { readonly query: string; readonly maxResults?: number }, signal?: AbortSignal): Promise<unknown> }): () => void
  }
  readonly connection: {
    readonly rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>): () => Promise<void> }
  }
  readonly settings: { readonly writable: boolean }
  readonly configEditor: {
    entries(): readonly { readonly options: { readonly id: string; readonly name: string }; readonly fiber?: unknown }[]
    edit(entry: { readonly options: { readonly id: string; readonly name: string } }, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
  }
  readonly agents: {
    get(id: string): HostAgent | undefined
  }
  readonly credentials: {
    resolve(ref: string): Promise<{ readonly value: string; readonly source: string } | undefined>
    describe(ref: string): Promise<{ readonly configured: boolean; readonly source?: string; readonly writable?: boolean }>
  }
  readonly tools: {
    schemas(scope?: HostAgent): readonly ToolSchema[]
    get(name: string, scope?: HostAgent): unknown
    register(definition: HostToolDefinition): () => void
    execute(exec: { readonly callId: string; readonly name: string; readonly arguments: Readonly<Record<string, unknown>>; readonly signal: AbortSignal; readonly agent: HostAgent }): Promise<ToolResult>
  }
  readonly logger: Logger
  readonly sessionController: SessionController
  effect(execute: () => (() => void) | void, label?: string): void
  /** Session lifecycle events, including `turn/end` for Icarus-owned execution Sessions. */
  on(event: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): void
  on(event: 'credentials/reference-updated', listener: (ref: string) => void | Promise<void>): void
  on(event: 'llm/stream', listener: (request: ModelRequest, next: () => AsyncIterable<ModelChunk>) => AsyncIterable<ModelChunk>): void
  on(event: 'agent/request', listener: (request: { readonly agent: { readonly session: { readonly id: string } } }, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>): void
  on(event: 'tools/execute', listener: (request: { readonly agent?: { readonly session: { readonly id: string } } }, next: () => Promise<unknown>) => Promise<unknown>): void
  on(event: 'tools/post-execute', listener: (request: { readonly agent?: HostAgent; readonly name: string; readonly callId: string }, result: ToolResult, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>): void
  readonly llm: {
    stream(request: ModelRequest): AsyncIterable<ModelChunk>
    resolveModelInfo(provider: string, model: string): Promise<{ readonly contextWindow?: number }>
  }
  readonly sessions: { get(id: string): { readonly header: { readonly parentSession?: string }; snapshotEvents(): readonly SessionEventLike[] } | undefined }
  readonly sessionQuery: {
    observeSession(id: string, options: { readonly projectionMode: 'none' }): Promise<{
      readonly header: { readonly cwd?: string }
      readonly events: readonly SessionEventLike[]
      [Symbol.dispose](): void
    }>
  }
  /** Repeating timer owned by this fiber (cordis-plugin-timer); disposed on unload. */
  interval(callback: () => void, delay: number): () => void
  /**
   * Register a service for other plugins under this fiber. Cordis owns the lifetime:
   * the registration is disposed when the plugin unloads. Consumers reach it as
   * `ctx.<name>` after declaring `inject: ['<name>']`.
   */
  provide(name: string, value: unknown): unknown
}

export interface ModelRequest {
  readonly sessionId?: string
  readonly purpose?: string
  readonly maxTokens?: number
  readonly signal?: AbortSignal
  readonly messages?: readonly { readonly role: string; readonly source?: { readonly rpcId?: string }; readonly content: readonly unknown[] }[]
  readonly [key: string]: unknown
}

export interface ModelChunk {
  readonly type: string
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly [key: string]: unknown }
  readonly [key: string]: unknown
}
