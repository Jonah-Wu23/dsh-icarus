// Icarus host plugin (M1).
//
// `apply` assembles BotBridge and registers the demonstration delivery. Resources are
// registered through `ctx.effect`, so plugin unload aborts an in-flight demo instead of
// leaving it behind. No host package is imported at run time: the plugin is installed
// into the profile as a local path and resolves node built-ins only.
import { runDigest } from './demo/digest.js'
import { errorText } from './bridge/deliver.js'
import type { IcarusContext } from './types/host.js'

export const name = 'dsh-icarus'
export const inject = ['sessionController']

export interface IcarusConfig {
  /** Bot id or name that receives deliveries; defaults to the Main Bot `Chief`. */
  readonly bot?: string | undefined
  /** DSH home holding `bot/state.json`; defaults to `$DSH_HOME`, then `~/.dsh`. */
  readonly dshHome?: string | undefined
  readonly demo?: DemoConfig | undefined
}

export interface DemoConfig {
  /** Run the arXiv demonstration delivery once per plugin load. */
  readonly onBoot?: boolean | undefined
  /** Submissions per digest; defaults to 5. */
  readonly maxResults?: number | undefined
}

interface ResolvedDemoConfig {
  readonly onBoot: boolean
  readonly maxResults: number | undefined
}

interface ResolvedConfig {
  readonly bot: string
  readonly dshHome: string | undefined
  readonly demo: ResolvedDemoConfig
}

export function apply(ctx: IcarusContext, config: IcarusConfig = {}): void {
  const resolved = resolveConfig(config)
  ctx.logger.info('icarus: loaded (bot=%s, demo.onBoot=%s)', resolved.bot, resolved.demo.onBoot)
  if (!resolved.demo.onBoot) return
  ctx.effect(() => {
    const controller = new AbortController()
    void runDigest(ctx, {
      bot: resolved.bot,
      dshHome: resolved.dshHome,
      maxResults: resolved.demo.maxResults,
      signal: controller.signal,
    }).catch(error => {
      // The failure keeps its original text and cause; nothing is delivered in its place.
      ctx.logger.error('icarus: boot digest failed: %s', errorText(error))
    })
    return () => controller.abort()
  }, 'icarus: demo boot delivery')
}

function resolveConfig(config: IcarusConfig): ResolvedConfig {
  const bot = config.bot ?? 'Chief'
  if (typeof bot !== 'string' || bot.trim() === '') throw new TypeError('icarus: config.bot must be a non-empty Bot id or name')
  const onBoot = config.demo?.onBoot ?? false
  if (typeof onBoot !== 'boolean') throw new TypeError('icarus: config.demo.onBoot must be a boolean')
  const maxResults = config.demo?.maxResults
  if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults <= 0)) throw new TypeError('icarus: config.demo.maxResults must be a positive integer')
  return { bot: bot.trim(), dshHome: config.dshHome, demo: { onBoot, maxResults } }
}
