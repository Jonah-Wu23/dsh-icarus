declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react'
  export const SettingsSecretField: ComponentType<Record<string, unknown>>
  export const SettingsForm: ComponentType<Record<string, unknown>>
  export const MarkdownText: ComponentType<{ text: string }>
  export const Button: ComponentType<Record<string, unknown>>
  export const Tag: ComponentType<Record<string, unknown>>
  export class SettingsFormModel {
    constructor(scope: unknown, fields: readonly unknown[], secrets: readonly { field: string; write: (text: string) => Promise<boolean> }[])
    bind(project: () => unknown): { getSnapshot(): unknown; subscribe(listener: () => void): () => void }
    shell(): { available: boolean; writable: boolean; dirty: boolean; invalid: boolean; saving: boolean; failed: boolean }
    field(field: string): { text: string; overridden: boolean; invalid: boolean }
    actions(): { edit(field: string, text: string): void; discard(): void }
    save(): Promise<void>
    dispose(): void
  }
}
