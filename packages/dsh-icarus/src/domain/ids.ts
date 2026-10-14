import { randomUUID } from 'node:crypto'

/** Mint a domain id. Storage never invents ids; the domain layer does. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}
