import MarkdownIt from 'markdown-it'

export interface RequirementResult {
  readonly requirement: string
  readonly passed: boolean
  readonly reason: string
  readonly evidenceRefs: readonly string[]
}

export interface ReadingFact {
  readonly scope: string
  readonly truncated: boolean | null
  readonly startOffset: number
  readonly endOffset: number
  readonly totalLength: number
  readonly isError?: boolean
}

export interface SemanticVerification {
  readonly objective: { readonly passed: boolean; readonly reason: string; readonly evidenceRefs: readonly string[] }
  readonly results: readonly RequirementResult[]
  readonly evidenceRefs: readonly string[]
  readonly readingClaims: readonly { readonly readingRef: string; readonly scope: string }[]
}

export interface CheckReport {
  readonly passed: boolean
  readonly results: readonly RequirementResult[]
  readonly failures: readonly string[]
  readonly verification: SemanticVerification
}

const markdown = new MarkdownIt()

export function modelJson(text: string): unknown {
  const tokens = markdown.parse(text, {})
  const fence = tokens.length === 1 && tokens[0]?.type === 'fence' ? tokens[0].content : text
  return JSON.parse(fence) as unknown
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('icarus: model response must be an object')
  return value as Record<string, unknown>
}

export function stringRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) throw new TypeError('icarus: evidence references must be a string array')
  return value as string[]
}

export function checkDeliverable(text: string, requirements: readonly string[], rawVerification: unknown, evidence: ReadonlyMap<string, ReadingFact>): CheckReport {
  const failures: string[] = []
  if (!text.trim()) failures.push('成果正文为空')
  const raw = requireObject(rawVerification)
  function decision(value: Record<string, unknown>) {
    if (typeof value.passed !== 'boolean' || typeof value.reason !== 'string' || !value.reason.trim()) throw new TypeError('icarus: verification requires a boolean decision and reason')
    const refs = stringRefs(value.evidenceRefs)
    for (const ref of refs) if (!evidence.has(ref)) throw new Error(`icarus: verification refers to missing evidence ${ref}`)
    return { passed: value.passed, reason: value.reason, evidenceRefs: refs }
  }
  const objectiveResult = decision(requireObject(raw.objective))
  if (!objectiveResult.passed) failures.push(`目标核对失败：${objectiveResult.reason}`)
  if (!Array.isArray(raw.results) || raw.results.length !== requirements.length) throw new TypeError('icarus: verification must address every requirement exactly once')
  const results = raw.results.map((value, index) => {
    const item = requireObject(value)
    if (item.requirement !== requirements[index]) throw new TypeError('icarus: verification requirement identity mismatch')
    const result: RequirementResult = { requirement: requirements[index]!, ...decision(item) }
    if (!result.passed) failures.push(`${result.requirement}：${result.reason}`)
    return result
  })
  const refs = stringRefs(raw.evidenceRefs)
  for (const ref of refs) if (!evidence.has(ref)) throw new Error(`icarus: missing evidence ${ref}`)
  if (!Array.isArray(raw.readingClaims)) throw new TypeError('icarus: verification must declare reading claims')
  const readingClaims = raw.readingClaims.map(value => {
    const item = requireObject(value)
    if (typeof item.readingRef !== 'string' || typeof item.scope !== 'string') throw new TypeError('icarus: invalid reading claim')
    const fact = evidence.get(item.readingRef)
    if (fact === undefined) throw new Error(`icarus: unknown reading ${item.readingRef}`)
    if (item.scope !== fact.scope) throw new Error(`icarus: reading ${item.readingRef} supports ${fact.scope}, claimed ${item.scope}`)
    if (item.scope === 'full' && (fact.truncated !== false || fact.startOffset !== 0 || fact.endOffset !== fact.totalLength)) throw new Error(`icarus: reading ${item.readingRef} does not cover the full content`)
    return { readingRef: item.readingRef, scope: item.scope }
  })
  return { passed: failures.length === 0, results, failures, verification: { objective: objectiveResult, results, evidenceRefs: refs, readingClaims } }
}
