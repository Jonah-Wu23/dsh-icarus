export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: object } }
export interface CredentialInfo { readonly configured: boolean; readonly source?: string; readonly writable: boolean }
export interface FormScope {
  getSnapshot(): { readonly status: string; readonly writable: boolean; readonly mode: string; readonly value?: { readonly search?: { readonly tavilyDepth?: string } } }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}
export interface ClientContext {
  readonly remote: {
    readonly credentials: {
      describe(refs: readonly string[]): Promise<RpcResult<Record<string, CredentialInfo>>>
      set(ref: string, value: string): Promise<RpcResult<unknown>>
      unset(ref: string): Promise<RpcResult<unknown>>
    }
    $on(event: string, listener: (ref: string) => void): () => void
  }
  readonly connection: { readonly rpc: { call<T>(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<T>> } }
  readonly locale: { getSnapshot(): { readonly active: string }; subscribe(listener: () => void): () => void }
  readonly configForms: { get(namespace: string): FormScope }
  readonly slots: {
    inject(name: string, callback: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  effect(callback: () => (() => void) | void, label?: string): unknown
}
export function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}
