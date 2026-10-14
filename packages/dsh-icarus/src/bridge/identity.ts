// Bot identity, read from DS Bot's own state file.
//
// The file is DS Bot's: Icarus never writes it. Identity is resolved on every delivery
// because `bot.sessionId` is the Bot's *current* own-chat segment and changes when a long
// conversation moves to a fresh Session; `bot.id` is the first segment's Session id and
// never changes. Reading the file is atomic-safe on the writer's side (lock plus rename).
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface BotIdentity {
  /** Stable Bot id: the Session id of the Bot's first own-chat segment. */
  readonly botId: string
  /** Current own-chat Session id to deliver to. */
  readonly sessionId: string
  readonly name: string
}

export interface IdentityOptions {
  /** DSH home directory; defaults to `$DSH_HOME`, then `~/.dsh`. */
  readonly dshHome?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
}

interface StoredBot {
  readonly id?: unknown
  readonly name?: unknown
  readonly sessionId?: unknown
  readonly segments?: unknown
}

interface StoredState {
  readonly bots?: Record<string, StoredBot>
}

/** Path of the Bot state file for a DSH home. */
export function statePathOf(options: IdentityOptions = {}): string {
  const env = options.env ?? process.env
  const configured = options.dshHome ?? env.DSH_HOME
  const home = configured !== undefined && configured.trim() !== '' ? resolve(configured.trim()) : join(homedir(), '.dsh')
  return join(home, 'bot', 'state.json')
}

/**
 * Resolve a Bot id or name to the identity a delivery needs.
 * @param botRef Bot id (`session-…`) or Bot name, matched exactly.
 * @param options DSH home override, used by tests and by explicit configuration.
 */
export async function resolveIdentity(botRef: string, options: IdentityOptions = {}): Promise<BotIdentity> {
  const path = statePathOf(options)
  const state = JSON.parse(await readFile(path, 'utf8')) as StoredState
  const bots = Object.values(state.bots ?? {})
  const bot = bots.find(candidate => candidate.id === botRef) ?? bots.find(candidate => candidate.name === botRef)
  if (bot === undefined || typeof bot.id !== 'string') {
    const known = bots.map(candidate => (typeof candidate.name === 'string' ? candidate.name : String(candidate.id))).join(', ')
    throw new Error(`icarus: no Bot ${JSON.stringify(botRef)} in ${path}; known Bots: ${known === '' ? 'none' : known}`)
  }
  const sessionId = typeof bot.sessionId === 'string' && bot.sessionId !== '' ? bot.sessionId : bot.id
  return { botId: bot.id, sessionId, name: typeof bot.name === 'string' && bot.name !== '' ? bot.name : bot.id }
}
