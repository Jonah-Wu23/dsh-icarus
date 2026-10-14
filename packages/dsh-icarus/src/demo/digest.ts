// M1 demonstration chain: one real fetch of the newest arXiv cs.AI submissions, one
// structured Chinese digest of the parsed Atom XML, one delivery through BotBridge.
//
// Failures keep their original shape: a non-OK response, an unparsable feed and a
// missing Bot all raise, and the caller records them. This module never produces a
// substitute message when the real source is unavailable.
import { deliver } from '../bridge/deliver.js'
import { resolveIdentity } from '../bridge/identity.js'
import type { IcarusContext } from '../types/host.js'

export const ARXIV_CS_AI_QUERY = 'http://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results='
export const DEFAULT_MAX_RESULTS = 5
export const FETCH_TIMEOUT_MS = 30_000
export const SUMMARY_LIMIT = 300
const USER_AGENT = 'dsh-icarus/0.1.0'

export interface DigestEntry {
  readonly title: string
  readonly url: string
  readonly published: string
  readonly authors: readonly string[]
  readonly summary: string
}

export interface DigestRunOptions {
  /** Bot id or name that receives the digest. */
  readonly bot: string
  readonly dshHome?: string | undefined
  readonly maxResults?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (!body.startsWith('#')) return NAMED_ENTITIES[body] ?? match
    const code = Number(body.startsWith('#x') ? `0x${body.slice(2)}` : body.slice(1))
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

function textOf(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  const raw = match?.[1]
  return raw === undefined ? undefined : decodeEntities(raw).replace(/\s+/g, ' ').trim()
}

/** Parse Atom entries in feed order. Pure: the caller decides what an empty result means. */
export function parseAtomEntries(xml: string, limit: number = DEFAULT_MAX_RESULTS): DigestEntry[] {
  const entries: DigestEntry[] = []
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const raw = match[1] ?? ''
    const title = textOf(raw, 'title')
    const url = textOf(raw, 'id')
    if (title === undefined || title === '' || url === undefined || url === '') continue
    const authors = [...raw.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map(author => (author[1] === undefined ? '' : decodeEntities(author[1]).replace(/\s+/g, ' ').trim()))
      .filter(name => name !== '')
    entries.push({ title, url, published: textOf(raw, 'published') ?? '', authors, summary: textOf(raw, 'summary') ?? '' })
    if (entries.length >= limit) break
  }
  return entries
}

function authorsText(authors: readonly string[]): string {
  if (authors.length === 0) return '未标注'
  const head = authors.slice(0, 3).join('、')
  return authors.length > 3 ? `${head} 等 ${authors.length} 人` : head
}

function clip(text: string): string {
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT)}…`
}

/** Render the digest the receiving Bot reads. Labels are Chinese; the content is the real feed. */
export function formatDigest(entries: readonly DigestEntry[], fetchedAt: Date): string {
  const lines = [
    `Icarus｜arXiv cs.AI 最新提交（${entries.length} 条）`,
    '来源：export.arxiv.org（cat:cs.AI，按提交时间倒序）',
    `抓取时间：${fetchedAt.toISOString()}`,
    '',
  ]
  entries.forEach((entry, index) => {
    lines.push(
      `${index + 1}. ${entry.title}`,
      `   提交：${entry.published === '' ? '未标注' : entry.published}｜作者：${authorsText(entry.authors)}`,
      `   摘要：${clip(entry.summary)}`,
      `   链接：${entry.url}`,
      '',
    )
  })
  return lines.join('\n').trimEnd()
}

function snippet(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim()
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`
}

/** Fetch and parse the newest cs.AI submissions. Throws on a failed fetch or an unparsable feed. */
export async function fetchCsAi(options: { maxResults?: number | undefined; signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {}): Promise<DigestEntry[]> {
  const max = options.maxResults ?? DEFAULT_MAX_RESULTS
  const timeout = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const response = await fetch(`${ARXIV_CS_AI_QUERY}${max}`, { signal, headers: { 'user-agent': USER_AGENT } })
  const body = await response.text()
  if (!response.ok) throw new Error(`icarus: arXiv responded ${response.status} ${response.statusText}: ${snippet(body)}`)
  const entries = parseAtomEntries(body, max)
  if (entries.length === 0) throw new Error(`icarus: arXiv response parsed to no entries: ${snippet(body)}`)
  return entries
}

/** One full pass: fetch, resolve the receiving Bot's current Session, deliver, log. */
export async function runDigest(ctx: IcarusContext, options: DigestRunOptions): Promise<void> {
  const entries = await fetchCsAi(options)
  const identity = await resolveIdentity(options.bot, { dshHome: options.dshHome })
  await deliver(ctx, {
    sessionId: identity.sessionId,
    text: formatDigest(entries, new Date()),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  })
  ctx.logger.info('icarus: delivered %d arXiv cs.AI entries to %s (%s)', entries.length, identity.name, identity.sessionId)
}
