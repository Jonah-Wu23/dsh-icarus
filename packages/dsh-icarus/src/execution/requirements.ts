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

const HEADING = /^(#{1,6})\s*(.+?)\s*$/
const SOURCE_LINE = /^\s*(来源|source)\s*[:：]/i
const LINK = /https?:\/\/\S+/i

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

function headingsOf(lines: readonly string[]): Heading[] {
  const headings: Heading[] = []
  lines.forEach((line, index) => {
    const match = HEADING.exec(line)
    if (match === null) return
    const level = match[1]?.length ?? 1
    const text = match[2] ?? ''
    headings.push({ level, text, line: index })
  })
  return headings
}

export function checkDeliverable(text: string, requirements: readonly string[]): CheckReport {
  const failures: string[] = []
  const results: RequirementResult[] = []
  const lines = text.split('\n')
  const body = text.trim()

  if (body === '') failures.push('R1 non-empty: the result is empty')
  if (body.length < MIN_RESULT_CHARS) failures.push(`R2 length floor: ${body.length} of ${MIN_RESULT_CHARS} characters`)
  if (!LINK.test(text) && !lines.some(line => SOURCE_LINE.test(line))) failures.push('R3 source marker: no http(s) link and no 来源: line')

  const headings = headingsOf(lines)
  for (const requirement of requirements) {
    const wanted = normalize(requirement)
    const start = headings.findIndex(heading => normalize(heading.text).includes(wanted))
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
