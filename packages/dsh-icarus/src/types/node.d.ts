// Icarus 使用的 Node.js 内置接口声明。
interface ImportMeta { readonly url: string }
declare const process: {
  readonly env: Record<string, string | undefined>
  readonly argv: readonly string[]
  readonly platform: string
  readonly execPath: string
  exitCode: number
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): void
}

declare module 'node:net' {
  export function isIP(value: string): 0 | 4 | 6
}

declare module 'node:child_process' {
  export function spawn(command: string, args: readonly string[], options: { readonly env: Record<string, string | undefined>; readonly stdio: 'inherit'; readonly windowsHide: boolean }): {
    kill(signal: 'SIGINT' | 'SIGTERM'): boolean
    once(event: 'error', listener: (error: Error) => void): void
    once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  }
  export function spawnSync(command: string, args: readonly string[], options?: { readonly cwd?: string; readonly encoding?: 'utf8'; readonly windowsHide?: boolean }): {
    readonly status: number | null
    readonly stdout: string
    readonly stderr: string
    readonly error?: Error
  }
}

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
}

declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
  export function existsSync(path: string): boolean
  export function readdirSync(path: string): string[]
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
  readonly headers: { get(name: string): string | null }
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  text(): Promise<string>
}

declare class URL {
  constructor(url: string, base?: string | URL)
  readonly protocol: string
  readonly hostname: string
  readonly host: string
  readonly origin: string
  readonly username: string
  readonly password: string
  readonly pathname: string
  readonly href: string
  hash: string
  readonly searchParams: { get(name: string): string | null; set(name: string, value: string): void; sort(): void }
}

declare function fetch(
  url: string,
  init?: { readonly signal?: AbortSignal | undefined; readonly headers?: Record<string, string> | undefined; readonly method?: string; readonly body?: string },
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
