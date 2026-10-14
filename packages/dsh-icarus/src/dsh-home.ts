// The DSH home directory, resolved once for every Icarus module that needs it.
//
// `$DSH_HOME` wins; otherwise `~/.dsh`, matching DS Bot's own `dshHomeOf`. Bot identity
// (bridge) and the Icarus data directory (storage) must agree on this path, so it has
// one definition.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface DshHomeOptions {
  /** Explicit DSH home; defaults to `$DSH_HOME`, then `~/.dsh`. */
  readonly dshHome?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
}

/** Absolute DSH home directory. */
export function dshHomeOf(options: DshHomeOptions = {}): string {
  const env = options.env ?? process.env
  const configured = options.dshHome ?? env.DSH_HOME
  return configured !== undefined && configured.trim() !== '' ? resolve(configured.trim()) : join(homedir(), '.dsh')
}
