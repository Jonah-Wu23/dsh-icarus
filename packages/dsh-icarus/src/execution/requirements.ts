// Requirement check for M2: structural rules the program can decide on its own.
//
// The rules (M2 plan §M2.3: non-empty, source reference, length floor, plus one response
// section per requirement) are:
//   R1 non-empty      — the trimmed result has content;
//   R2 length floor   — at least MIN_RESULT_CHARS characters;
//   R3 source marker  — at least one http(s) link, or a line starting with `来源：`/`来源:`;
//   R4 response       — for every requirement, a Markdown heading (1-6 `#`) whose text
//                       contains the requirement, followed by a non-empty section that ends
//                       at the next heading of the same or a higher level.
// Semantic judgement (is the answer actually about the requirement) stays with the model,
// from M3 on. A failed rule never rewrites the result: the caller stores the report and the
// raw result as the failure record.
import MarkdownIt from 'markdown-it'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIN_RESULT_CHARS = 200

export interface RequirementResult {
  readonly requirement: string
  readonly passed: boolean
  readonly reason: string
}

export interface CheckReport {
  readonly passed: boolean
  readonly results: readonly RequirementResult[]
  /** Rule failures, in report order; empty when the result passes. */
  readonly failures: readonly string[]
}

interface Heading {
  readonly level: number
  readonly text: string
  readonly line: number
}

const markdown = new MarkdownIt({ linkify: true })

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

function headingsOf(text: string): Heading[] {
  const headings: Heading[] = []
  const tokens = markdown.parse(text, {})
  tokens.forEach((token, index) => {
    if (token.type !== 'heading_open' || token.map === null) return
    const content = tokens[index + 1]
    const title = content?.children?.map(child => child.content).join('') ?? content?.content ?? ''
    headings.push({ level: Number(token.tag.slice(1)), text: title, line: token.map[0] })
  })
  return headings
}

function hasSource(text: string, lines: readonly string[]): boolean {
  const tokens = markdown.parse(text, {})
  const link = tokens.some(token => token.children?.some(child => {
    const href = child.type === 'link_open' ? child.attrGet('href') : null
    if (typeof href !== 'string') return false
    if (href.startsWith('https://') || href.startsWith('http://')) return true
    if (href.startsWith('file:')) return existsSync(fileURLToPath(href))
    const path = decodeURIComponent(href)
    return isAbsolute(path) && existsSync(path)
  }))
  const sourceLine = (line: string): boolean => {
    const value = line.trim()
    const marker = ['来源：', '来源:', 'source:', 'source：'].find(prefix => value.toLowerCase().startsWith(prefix))
    return marker !== undefined && value.slice(marker.length).trim() !== ''
  }
  return link || lines.some(sourceLine) || tokens.some(token => token.type === 'inline'
    && sourceLine(token.children?.map(child => child.content).join('') ?? token.content))
}

export function checkDeliverable(text: string, requirements: readonly string[]): CheckReport {
  const failures: string[] = []
  const results: RequirementResult[] = []
  const lines = text.split('\n')
  const body = text.trim()

  if (body === '') failures.push('R1 non-empty: the result is empty')
  if (body.length < MIN_RESULT_CHARS) failures.push(`R2 length floor: ${body.length} of ${MIN_RESULT_CHARS} characters`)
  if (!hasSource(text, lines)) failures.push('R3 source marker: no usable source reference')

  const headings = headingsOf(text)
  for (const requirement of requirements) {
    const wanted = normalize(requirement)
    const start = headings.findIndex(heading => normalize(heading.text) === wanted)
    if (start === -1) {
      results.push({ requirement, passed: false, reason: 'R4 response: no heading carries this requirement' })
      failures.push(`R4 response: missing section for ${JSON.stringify(requirement)}`)
      continue
    }
    const heading = headings[start]
    if (heading === undefined) continue
    const next = headings.slice(start + 1).find(candidate => candidate.level <= heading.level)
    const section = lines.slice(heading.line + 1, next?.line ?? lines.length).join('\n').trim()
    if (section === '') {
      results.push({ requirement, passed: false, reason: 'R4 response: the section has no content' })
      failures.push(`R4 response: empty section for ${JSON.stringify(requirement)}`)
      continue
    }
    results.push({ requirement, passed: true, reason: 'ok' })
  }

  return { passed: failures.length === 0, results, failures }
}
