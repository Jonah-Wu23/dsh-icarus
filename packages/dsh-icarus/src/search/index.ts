import Schema from '@deepseek-ai/schemastery'
import { bindConnection } from './host-rpc.js'
import { CREDENTIAL_REFS, PROVIDERS, SearchUnavailableError } from './types.js'
import type { Provider, SearchRequest, FetchRequest, SearchOwner } from './types.js'
import type { IcarusContext, HostToolDefinition } from '../types/host.js'

export const name = 'icarus-search'
export const inject = ['credentials']
export const Config = Schema.object({})

export function apply(ctx: IcarusContext): void {
  if (typeof ctx.credentials.resolve !== 'function') throw new Error('icarus-search: incompatible host: credentials.resolve is missing')
  ctx.inject(['icarus', 'tools'], scope => {
    const service = scope.icarus.search
    const database = scope.icarus.searchDatabase
    const { db } = database
    let compatibility: string[] = []
    let takeoverRequested: boolean | undefined
    function owner(sessionId: string | undefined): SearchOwner {
      const run = sessionId === undefined ? undefined : db.prepare("SELECT id, missionId FROM Run WHERE sessionId = ? AND status IN ('running','awaiting_approval') ORDER BY createdAt DESC LIMIT 1").get<{ id: string; missionId: string }>(sessionId)
      return { purpose: 'native-tool', sessionId, ...(run === undefined ? {} : { missionId: run.missionId, runId: run.id }) }
    }
    function register(tool: string, description: string, properties: Record<string, unknown>, required: string[], invoke: (input: Record<string, unknown>, owner: SearchOwner, signal: AbortSignal) => Promise<unknown>) {
      const definition: HostToolDefinition = {
        name: tool, description, parameters: { type: 'object', properties, required, additionalProperties: false },
        output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, exec) {
          if (compatibility.length > 0) throw new Error(`icarus-search: incompatible host: ${compatibility.join(', ')}`)
          const who = owner(exec.agent?.session.id ?? exec.agent?.id)
          try {
            const value = await invoke(args, who, exec.signal)
            if (who.missionId === undefined || who.sessionId === undefined) return value
            const ref = scope.icarus.capabilities.capture(who.missionId, who.runId ?? null, who.sessionId, exec.callId, tool, { value, content: [{ type: 'text', text: JSON.stringify(value) }] })
            return { ...value as object, icarusEvidence: { ref, scope: tool === 'icarus_web_search' ? 'snippet' : 'vendor_extract' } }
          } catch (error) {
            if (who.missionId !== undefined && who.sessionId !== undefined) scope.icarus.capabilities.capture(who.missionId, who.runId ?? null, who.sessionId, exec.callId, tool,
              { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
            throw error
          }
        },
      }
      scope.tools.register(definition)
    }
    register('icarus_web_search', '联网搜索，按健康状态分摊 Keenable、Exa、Tavily 免费额度。搜索词只写主题，不发送个人资料与项目文件原文。返回 snippet 范围的搜索结果及证据。设置入口：DSH 插件 → Icarus → 联网搜索。',
      { query: { type: 'string', minLength: 1 }, maxResults: { type: 'integer', minimum: 1, maximum: 20, default: 8 }, timeRange: { type: 'string', enum: ['day','week','month','year'] }, depth: { type: 'string', enum: ['basic','advanced'] } }, ['query'],
      (input, who, signal) => service.search(input as unknown as SearchRequest, who, signal))
    register('icarus_web_fetch', '通过厂商服务器抽取公开网页正文，阅读范围 vendor_extract，originStatus 为 null。优先使用已绑定的 Fetch MCP 或浏览器，读取失败或被代理拦截后使用本工具。',
      { url: { type: 'string', format: 'uri' }, maxChars: { type: 'integer', minimum: 1, maximum: 50_000, default: 30_000 } }, ['url'],
      (input, who, signal) => service.fetch(input as unknown as FetchRequest, who, signal))

    void service.refresh().catch(error => scope.logger.error('icarus-search: credential refresh failed: %s', error instanceof Error ? error.message : String(error)))
    scope.on('credentials/reference-updated', async ref => { if (Object.values(CREDENTIAL_REFS).includes(ref)) await service.refresh() })
    function report(items: string[]): void {
      if (items.length === 0) return
      compatibility = [...new Set([...compatibility, ...items])]
      scope.logger.error('icarus-search: incompatible host: %s', compatibility.join(', '))
    }
    // 设置面只依赖 RPC 传输。缺少 web 或 configEditor 时接管无法注册，但仍要注册 RPC，
    // 让设置页读到具体缺失项，而不是停在加载状态等待。
    scope.inject(['connection', 'webServer'], surface => {
      const missingMethods = [
        ...(typeof surface.credentials.resolve === 'function' ? [] : ['credentials.resolve']),
        ...(typeof surface.connection.rpc.handle === 'function' ? [] : ['connection.rpc.handle']),
      ]
      report(missingMethods)
      // 没有 RPC 通道时设置页无法取得任何状态，只能依赖插件日志。
      if (missingMethods.includes('connection.rpc.handle')) return
      const missingServices = () => ['web', 'configEditor'].filter(name => scope.get(name) === undefined)
      bindConnection(surface).rpc.handle('/icarus', async (endpoint, payload, signal) => {
        try {
          if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('icarus: RPC arguments must be an object')
          const args = payload as Record<string, unknown>
          if (endpoint === 'searchStatus') {
            const seam = scope.get('web') as IcarusContext['web'] | undefined
            return { ok: true, value: { ...await service.status(), compatibility, missingServices: missingServices(),
              actualSearchProvider: seam?.searchProviderId ?? null, actualFetchProvider: seam?.fetchProviderId ?? null,
              takeoverRequested: takeoverRequested ?? seam?.searchProviderId === 'icarus-search',
              takeoverEffective: seam?.searchProviderId === 'icarus-search' } }
          }
          if (endpoint === 'searchUsage') return { ok: true, value: service.usage() }
          if (endpoint === 'searchTest') {
            if (typeof args.provider !== 'string' || !PROVIDERS.includes(args.provider as Provider)) throw new TypeError('icarus: provider required')
            return { ok: true, value: await service.test(args.provider as Provider, signal) }
          }
          if (endpoint === 'setTakeover') {
            if (typeof args.enabled !== 'boolean') throw new TypeError('icarus: enabled must be boolean')
            const status = await service.status()
            if (args.enabled && !status.providers.some(item => item.lastSucceededAt !== null && item.status === 'healthy')) throw new Error('icarus: 至少一家测试连接成功后才能开启接管')
            const editor = scope.get('configEditor') as IcarusContext['configEditor'] | undefined
            if (editor === undefined) throw new Error('icarus: 宿主缺少 configEditor，无法写入接管配置')
            const entry = editor.entries().find(entry => entry.options.id === 'web' && entry.options.name === '@deepseek-ai/dsh-web')
            if (entry === undefined) throw new Error('icarus: profile has no matching web entry')
            await editor.edit(entry, (_current, inherited) => args.enabled ? { searchProvider: 'icarus-search', fetchProvider: 'http' } : inherited)
            takeoverRequested = args.enabled
            return { ok: true, value: { enabled: args.enabled, restartRequired: true } }
          }
          throw new TypeError('icarus: unknown RPC method')
        } catch (error) {
          return { ok: false, error: { code: error instanceof SearchUnavailableError ? error.code : 'ICARUS_SEARCH_ERROR',
            message: error instanceof Error ? error.message : String(error), details: error instanceof SearchUnavailableError ? { providers: error.providers } : {} } }
        }
      })
      scope.inject(['web', 'configEditor'], connected => {
        report([
          ...(typeof connected.web.registerSearchProvider === 'function' ? [] : ['web.registerSearchProvider']),
          ...(typeof connected.configEditor.entries === 'function' ? [] : ['configEditor.entries']),
        ])
        if (compatibility.length > 0) return
        connected.web.registerSearchProvider({ id: 'icarus-search', available: service.available,
          async search(request, signal) {
            const found = await service.search(request, { purpose: 'host-web-search' }, signal ?? new AbortController().signal)
            return { sources: found.results.map(item => ({ url: item.url, title: item.title, snippet: item.content, ...(item.publishedAt === null ? {} : { publishedAt: item.publishedAt }) })), truncated: false }
          },
        })
      })
    })
  })
}

export default { name, inject, apply, Config }
