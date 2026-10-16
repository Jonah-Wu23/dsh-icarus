import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, MarkdownText, SettingsForm, SettingsFormModel, SettingsSecretField, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { CREDENTIAL_REFS, PROVIDERS } from '../search/types.js'
import type { Provider, ProviderState } from '../search/types.js'
import type { SearchService } from '../search/service.js'
import { unwrap } from './context.js'
import type { ClientContext, CredentialInfo, FormScope } from './context.js'
import { TUTORIALS } from './tutorials.js'

type Status = Awaited<ReturnType<SearchService['status']>> & {
  actualSearchProvider: string | null; actualFetchProvider: string | null; takeoverRequested: boolean; takeoverEffective: boolean; compatibility: string[]; missingServices: string[]
}
type TestResult = Awaited<ReturnType<SearchService['test']>>
const NAMES = { keenable: 'Keenable', exa: 'Exa', tavily: 'Tavily' }
const STATUS_ZH = { healthy: '可用', unconfigured: '未填写', auth_failed: 'key 无效', quota_exhausted: '本月额度已用完', rate_limited: '请求太频繁', cooling: '暂时连不上' }
const STATUS_EN = { healthy: 'Available', unconfigured: 'Not configured', auth_failed: 'Invalid key', quota_exhausted: 'Quota exhausted', rate_limited: 'Rate limited', cooling: 'Temporarily unavailable' }
const cardStyle = { padding: '20px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' }
const mutedStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: 1.7 }

function useLocale(ctx: ClientContext): boolean {
  return useSyncExternalStore(callback => ctx.locale.subscribe(callback), () => ctx.locale.getSnapshot().active).startsWith('zh')
}
function localPage(): boolean { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname) }
function statusLabel(state: ProviderState, configured: boolean, zh: boolean): string {
  if (configured && state.lastSucceededAt === null && state.status === 'healthy') return zh ? '待测试' : 'Not tested'
  return (zh ? STATUS_ZH : STATUS_EN)[state.status]
}

function ProviderRow(props: { ctx: ClientContext; scope: FormScope; provider: Provider; zh: boolean; status: Status; credentials: Record<string, CredentialInfo>; refresh(): Promise<void> }) {
  const { ctx, scope, provider, zh, status, credentials, refresh } = props
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tested, setTested] = useState<TestResult>()
  const ref = CREDENTIAL_REFS[provider]
  const info = credentials[ref]
  const state = status.providers.find(item => item.provider === provider)!
  const usage = status.usage.find(item => item.provider === provider)!
  const writable = localPage() && info?.writable === true && scope.getSnapshot().writable
  const test = useCallback(async () => {
    setBusy(true); setError(''); setTested(undefined)
    try { setTested(unwrap(await ctx.connection.rpc.call<TestResult>('/icarus', 'searchTest', { provider }))) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false); await refresh() }
  }, [ctx, provider, refresh])
  const model = useMemo(() => new SettingsFormModel(scope, [], [{ field: 'key', async write(value) {
    setError('')
    try { unwrap(await ctx.remote.credentials.set(ref, value)) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); throw failure }
    await test()
    return true
  } }]), [ctx, scope, ref, test])
  const store = useMemo(() => model.bind(() => ({ ...model.shell(), key: model.field('key') })), [model])
  const form = useSyncExternalStore(callback => store.subscribe(callback), () => store.getSnapshot()) as ReturnType<SettingsFormModel['shell']> & { key: { text: string } }
  const actions = useMemo(() => model.actions(), [model])
  useEffect(() => () => model.dispose(), [model])
  async function remove() {
    setBusy(true); setError(''); setTested(undefined)
    try { unwrap(await ctx.remote.credentials.unset(ref)); await refresh() }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const source = info?.source === 'env' || info?.source === 'process' || info?.source === 'process-env' || info?.writable === false
    ? zh ? '来自系统环境变量，需在系统设置中修改' : 'From process environment; edit it in system settings'
    : info?.configured ? zh ? '本机保存' : 'Saved locally' : zh ? '未配置来源' : 'No credential source'
  const hint = state.status === 'auth_failed' ? zh ? '请到厂商后台确认 key 未被吊销，重新粘贴后点测试连接。' : 'Check that the key is active, paste it again and test the connection.'
    : state.status === 'quota_exhausted' ? zh ? '额度恢复后自动重试，也可核查厂商后台后重新测试。' : 'Wait for the reset, or check the vendor dashboard and test again.'
    : state.status === 'cooling' || state.status === 'rate_limited' ? zh ? '稍后自动恢复；可展开原始错误查看原因。' : 'Recovery is automatic after cooldown; expand the original error for details.' : source
  return <section style={cardStyle} aria-label={NAMES[provider]}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
      <strong>{NAMES[provider]}</strong><Tag tone={state.status === 'healthy' ? 'neutral' : 'quiet'}>{statusLabel(state, info?.configured === true, zh)}</Tag>
    </div>
    <p style={mutedStyle}>{provider === 'keenable' ? zh ? '实时网页搜索，免费额度最多。' : 'Realtime web search with the largest free allowance.' : provider === 'exa' ? zh ? '语义搜索，适合论文和技术文章。' : 'Semantic search for papers and technical articles.' : zh ? '常规检索与正文抽取，按 credits 计量。' : 'Web search and extraction, metered in credits.'}</p>
    <SettingsForm state={{ ...form, writable }} labels={{ unavailable: zh ? '设置尚未加载。' : 'Settings are loading.', readOnly: source,
      saveFailed: zh ? '保存失败，请查看下方错误。' : 'Save failed; see the error below.', save: zh ? '保存并测试' : 'Save and test', saving: zh ? '保存中…' : 'Saving…' }}
      onSave={() => { void model.save() }} onDiscard={actions.discard}>
      <SettingsSecretField id={`icarus-search-${provider}`} label="API key" hint={source} disabled={!writable || busy} text={form.key.text}
        configured={info?.configured === true} stateLabel={info?.configured ? zh ? '已保存' : 'Saved' : zh ? '未填写' : 'Empty'} onEdit={(value: string) => actions.edit('key', value)} />
    </SettingsForm>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
      <Button disabled={busy || !info?.configured} onClick={() => { void test() }}>{busy ? zh ? '请求中…' : 'Working…' : zh ? '测试连接' : 'Test connection'}</Button>
      <Button disabled={!writable || busy || !info?.configured} onClick={() => { void remove() }}>{zh ? '移除' : 'Remove'}</Button>
    </div>
    <p style={mutedStyle}>{hint}{state.until === null ? '' : ` ${zh ? '恢复时间' : 'Resumes'}: ${new Date(state.until).toLocaleString(zh ? 'zh-CN' : 'en')}`}</p>
    <p style={mutedStyle}>{zh ? '本月已用' : 'This month'}: {provider === 'exa' ? `$${usage.costDollars.toFixed(4)} / $10` : `${Number(usage.units.toFixed(3))} / ${usage.freeUnits} ${provider === 'tavily' ? 'credits' : zh ? '次' : 'requests'}`} · {usage.calls} {zh ? '次调用' : 'calls'} · {zh ? '重置' : 'Reset'} {new Date(usage.resetAt).toLocaleDateString(zh ? 'zh-CN' : 'en')}
      {provider === 'exa' && usage.unknownCosts ? ` · ${usage.unknownCosts} ${zh ? '次费用未知，额度保留预留金额' : 'calls with unknown cost, allowance remains reserved'}` : ''}</p>
    {tested && <p role="status">{zh ? '连接成功' : 'Connected'} · {tested.results.length} {zh ? '条结果' : 'results'} · {tested.elapsedMs} ms · {tested.units} {zh ? '计量单位' : 'units'}</p>}
    {error && <p role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-error)' }}>{error}</p>}
    {state.lastError !== null && <details><summary>{zh ? '最近一次原始错误' : 'Last original error'}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>{JSON.stringify(state.lastError, null, 2)}</pre></details>}
    <details style={{ marginTop: 12 }}><summary>{zh ? '申请教程' : 'Get an API key'}</summary>{TUTORIALS[provider][zh ? 'zh' : 'en'].split('\n\n').map((text, index) => <MarkdownText key={index} text={text} />)}
      <p style={mutedStyle}>{zh ? '核对日期：2026-10-16。只填一家也能用，填多家会自动分摊额度。' : 'Checked: 2026-10-16. One provider is enough; multiple providers share usage.'}</p></details>
  </section>
}

function SearchCard({ ctx }: { ctx: ClientContext }) {
  const zh = useLocale(ctx)
  const scope = useMemo(() => ctx.configForms.get('icarus'), [ctx])
  const form = useSyncExternalStore(callback => scope.subscribe(callback), () => scope.getSnapshot())
  const [status, setStatus] = useState<Status>()
  const [credentials, setCredentials] = useState<Record<string, CredentialInfo>>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [draftDepth, setDraftDepth] = useState<string>()
  const refresh = useCallback(async () => {
    const [next, refs] = await Promise.all([ctx.connection.rpc.call<Status>('/icarus', 'searchStatus', {}), ctx.remote.credentials.describe(Object.values(CREDENTIAL_REFS))])
    setStatus(unwrap(next)); setCredentials(unwrap(refs))
  }, [ctx])
  useEffect(() => {
    const update = () => { void refresh().catch(failure => setError(failure instanceof Error ? failure.message : String(failure))) }
    update()
    const timer = window.setInterval(update, 15_000)
    const unsubscribe = ctx.remote.$on('credentials/reference-updated', ref => { if (Object.values(CREDENTIAL_REFS).includes(ref)) update() })
    return () => { window.clearInterval(timer); unsubscribe() }
  }, [ctx, refresh])
  async function changeTakeover(enabled: boolean) {
    setBusy(true); setError('')
    try { unwrap(await ctx.connection.rpc.call('/icarus', 'setTakeover', { enabled })); setNotice(zh ? '配置已保存，请重启 DSH 后核查实际提供者。' : 'Saved. Restart DSH and check the active provider.'); await refresh() }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  async function saveDepth() {
    setBusy(true); setError('')
    try {
      if (!await scope.set('search', { ...form.value?.search, tavilyDepth: draftDepth })) throw new Error(zh ? '宿主拒绝保存搜索深度。' : 'The host refused to save search depth.')
      setDraftDepth(undefined); await refresh()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const healthy = status?.providers.filter(item => item.status === 'healthy' && item.lastSucceededAt !== null).length ?? 0
  return <div style={{ maxWidth: 760, lineHeight: 1.6 }}>
    <h2 style={{ marginTop: 0 }}>{zh ? '联网搜索' : 'Web search'}</h2>
    {status && <p role="status">{healthy} {zh ? '家可用' : 'providers available'} · {zh ? '本月已用' : 'This month'} {status.usage.map(item => `${NAMES[item.provider]} ${item.provider === 'exa' ? `$${item.costDollars.toFixed(4)}` : Number(item.units.toFixed(3))}`).join(' / ')}</p>}
    {status?.providers.every(item => !item.configured) && <p>{zh ? '填一个 key 就能用，推荐先申请 Keenable，免费额度最多。' : 'Add one key to start. Keenable has the largest free allowance.'}</p>}
    {!localPage() && <p role="status">{zh ? '当前页面通过非本机地址打开，设置只读。请在 DSH 桌面或 localhost 打开。' : 'Settings are read only on a remote address. Open DSH desktop or localhost to edit.'}</p>}
    {status && <p style={mutedStyle}>{zh ? 'DSH 内置搜索实际提供者' : 'Active DSH search provider'}: {status.actualSearchProvider ?? (zh ? '自动选择' : 'automatic')} · fetch: {status.actualFetchProvider ?? 'automatic'}</p>}
    {status && status.missingServices.length > 0 && <p role="alert">{zh ? `当前宿主缺少 ${status.missingServices.join('、')}，安装接管与用量设置未注册；搜索工具本身仍可用。` : `This host is missing ${status.missingServices.join(', ')}, so takeover and usage settings are not registered. The search tools still work.`}</p>}
    {status && status.compatibility.length > 0 && <p role="alert">{zh ? `宿主接口不兼容，搜索未注册：${status.compatibility.join('、')}。请按 docs/M3.99_PLAN.md 第 3.3 节核对宿主版本。` : `Incompatible host interfaces; search is not registered: ${status.compatibility.join(', ')}. Check the host version against docs/M3.99_PLAN.md section 3.3.`}</p>}
    {status?.takeoverRequested && !status.takeoverEffective && <p role="alert">{zh ? '接管未生效，请重启 DSH；上方显示当前实际提供者。' : 'Takeover is not active. Restart DSH; the active provider is shown above.'}</p>}
    {error && <p role="alert" style={{ overflowWrap: 'anywhere' }}>{error}</p>}
    {!status && <p>{zh ? '正在读取搜索服务…' : 'Loading search service…'}</p>}
    {status && PROVIDERS.map(provider => <ProviderRow key={provider} ctx={ctx} scope={scope} provider={provider} zh={zh} status={status} credentials={credentials} refresh={refresh} />)}
    <p style={mutedStyle}>{zh ? '用量按 Icarus 记录统计，厂商后台为准。' : 'Usage is based on Icarus records; the vendor dashboard is authoritative.'}</p>
    {status && <details style={cardStyle}><summary>{zh ? '高级设置' : 'Advanced settings'}</summary>
      <label style={{ display: 'flex', gap: 10, margin: '16px 0' }}><input type="checkbox" checked={status.takeoverRequested} disabled={!localPage() || !form.writable || busy || (healthy === 0 && !status.takeoverRequested)} onChange={event => { void changeTakeover(event.target.checked) }} />{zh ? '让 DSH 内置搜索也使用这些服务' : 'Use these providers for DSH built in search'}</label>
      <label>{zh ? 'Tavily 搜索深度' : 'Tavily search depth'} <select value={draftDepth ?? status.tavilyDepth} disabled={!localPage() || !form.writable || busy} onChange={event => setDraftDepth(event.target.value)}>
        <option value="basic">{zh ? '基础：1 credit / 次' : 'Basic: 1 credit / call'}</option><option value="advanced">{zh ? '深入：2 credits / 次' : 'Advanced: 2 credits / call'}</option>
      </select></label> <Button disabled={draftDepth === undefined || busy} onClick={() => { void saveDepth() }}>{zh ? '保存' : 'Save'}</Button>
      {notice && <p role="status">{notice}</p>}
      <p style={mutedStyle}>{zh ? '搜索查询与要抓取的 URL 发送给对应厂商；抓取由厂商服务器完成。返回结果保存在本机 Icarus 数据目录，作为成果证据。' : 'Search queries and extraction URLs are sent to the selected vendor. Extraction runs on its servers. Results are saved locally as Icarus evidence.'}</p>
      <p style={mutedStyle}>{zh ? 'key 在本机 ~/.dsh/.credentials.yaml 明文保存，同一 Windows 账户的程序可读取。建议每家为 Icarus 单独新建 key。搜索词只写主题。' : 'Keys are stored as plain text in ~/.dsh/.credentials.yaml; programs under the same Windows account can read them. Create dedicated Icarus keys. Use only topics in search queries.'}</p>
    </details>}
  </div>
}

export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'connection', 'configForms']
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-icarus', inject: () => ({ ctx }) }, SearchCard))
}

export default { inject, apply }
