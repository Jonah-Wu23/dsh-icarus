// Ambient declarations for the Node.js built-ins Icarus uses. The M1 plan keeps
// `typescript` as the only devDependency, so @types/node is deliberately absent and
// this file describes exactly the surface the plugin touches — no more.
declare const process: { readonly env: Record<string, string | undefined> }

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:crypto' {
  export function randomUUID(): string
}

declare class AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
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
