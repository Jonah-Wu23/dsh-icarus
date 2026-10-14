// Icarus 使用的 Node.js 内置接口声明。
declare const process: { readonly env: Record<string, string | undefined> }

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
}

declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
  export function existsSync(path: string): boolean
  export function statSync(path: string): { isFile(): boolean }
  export function writeFileSync(path: string, data: string): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void
}

declare module 'node:path' {
  export function isAbsolute(path: string): boolean
  export function join(...parts: string[]): string
  export function dirname(path: string): string
  export function resolve(...parts: string[]): string
  export const sep: string
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:crypto' {
  export function randomUUID(): string
  export interface Hash {
    update(data: string): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: string): Hash
}

declare module 'node:buffer' {
  export const Buffer: { byteLength(value: string, encoding: 'utf8'): number }
}

declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined
    run<R>(store: T, callback: () => R): R
  }
}

declare class TimerHandle {
  private readonly brand: 'TimerHandle'
}
declare function setTimeout(callback: () => void, delay: number): TimerHandle
declare function clearTimeout(handle: TimerHandle): void

declare class AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
  throwIfAborted(): void
  static timeout(milliseconds: number): AbortSignal
  static any(signals: readonly AbortSignal[]): AbortSignal
}

declare class AbortController {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}

interface Response {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  text(): Promise<string>
}

declare function fetch(
  url: string,
  init?: { readonly signal?: AbortSignal | undefined; readonly headers?: Record<string, string> | undefined },
): Promise<Response>

// node:sqlite (built into Node 24; the desktop runtime is 24.18.1). Statically linked,
// no native addon and no npm dependency.
declare module 'node:sqlite' {
  export interface RunResult {
    readonly changes: number | bigint
    readonly lastInsertRowid: number | bigint
  }

  export interface StatementSync {
    run(...params: unknown[]): RunResult
    get<T = Record<string, unknown>>(...params: unknown[]): T | undefined
    all<T = Record<string, unknown>>(...params: unknown[]): T[]
  }

  export interface DatabaseSyncOptions {
    readonly open?: boolean
    readonly readOnly?: boolean
    readonly enableForeignKeyConstraints?: boolean
    readonly timeout?: number
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
