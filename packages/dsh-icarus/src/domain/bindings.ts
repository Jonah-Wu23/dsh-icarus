export interface ContextRef {
  readonly id: string
  readonly kind: 'file' | 'bot' | 'tool'
  readonly locator: string
  readonly purpose: string
  readonly startLine?: number
  readonly endLine?: number
  readonly arguments?: Readonly<Record<string, unknown>>
}

export interface CapabilityRequirement {
  readonly purpose: string
  readonly required: boolean
  readonly provider: string
  readonly tool: string
  readonly verificationArgs?: Readonly<Record<string, unknown>>
}

/** One of the three business templates, or the generic open-source/model-update shape. */
export type TemplateId = 'paper' | 'application' | 'interest' | 'generic'

export interface TemplateBinding {
  readonly id: TemplateId
}

export type DeliverableSpec = 'reading' | 'comparison' | 'document' | 'code'

/** What one investigation Mission was created to do, fixed in its first revision. */
export interface InvestigationBinding {
  readonly originMissionId: string
  readonly originItemId?: string
  readonly originDeliverableId?: string
  readonly originRunId?: string
  /** Self-contained copy of the origin item, deliverable excerpt and evidence. */
  readonly originSnapshotRef: string
  readonly question: string
  readonly deliverableSpec: readonly DeliverableSpec[]
  readonly stopCondition: string
  readonly verifyCommand?: string
  readonly baseCommit?: string
  readonly worktreeRef?: string
}

/** Pre-authorized limits for investigations the model may start on its own (M4.7). */
export interface ExplorationPolicy {
  readonly enabled: boolean
  readonly authorizedTopics: string
  readonly deliverableSpecs: readonly DeliverableSpec[]
  readonly weeklyRuns: number
  readonly weeklyTokens: number
}

export interface MissionBindings {
  readonly searchBudget?: SearchBudget
  readonly workspaceRef?: string
  readonly contextRefs?: readonly ContextRef[]
  readonly capabilityRequirements?: readonly CapabilityRequirement[]
  readonly deliveryPolicy?: {
    readonly mode: 'digest' | 'changes'
    readonly prepareAheadMs: number
    readonly deliverEmpty: boolean
  }
  readonly template?: TemplateBinding
  readonly investigation?: InvestigationBinding
  readonly explorationPolicy?: ExplorationPolicy
  readonly maxModelRequestsPerRun?: number
}

export interface SearchBudget {
  readonly perRun: number
  readonly perMonth: number
  readonly allowPaid?: boolean
}

const TEMPLATE_IDS: readonly string[] = ['paper', 'application', 'interest', 'generic']
const DELIVERABLE_SPECS: readonly string[] = ['reading', 'comparison', 'document', 'code']

export function parseBindings(value: MissionBindings): MissionBindings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('icarus: invalid bindings')
  if (value.searchBudget !== undefined) {
    for (const limit of [value.searchBudget.perRun, value.searchBudget.perMonth]) if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('icarus: search budgets must be non-negative integers')
    if (value.searchBudget.allowPaid !== undefined && typeof value.searchBudget.allowPaid !== 'boolean') throw new TypeError('icarus: searchBudget.allowPaid must be boolean')
  }
  if (value.workspaceRef !== undefined && (typeof value.workspaceRef !== 'string' || value.workspaceRef.trim() === '')) throw new TypeError('icarus: workspaceRef required')
  for (const ref of value.contextRefs ?? []) {
    if (!['file', 'bot', 'tool'].includes(ref.kind) || !ref.id || !ref.locator || !ref.purpose) throw new TypeError('icarus: invalid context reference')
    for (const line of [ref.startLine, ref.endLine]) if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new TypeError('icarus: invalid line range')
    if (ref.startLine !== undefined && ref.endLine !== undefined && ref.endLine < ref.startLine) throw new TypeError('icarus: reversed line range')
  }
  for (const item of value.capabilityRequirements ?? []) {
    if (!item.purpose || !item.provider || !item.tool || typeof item.required !== 'boolean') throw new TypeError('icarus: invalid capability requirement')
  }
  const policy = value.deliveryPolicy
  if (policy !== undefined && (!['digest', 'changes'].includes(policy.mode) || !Number.isSafeInteger(policy.prepareAheadMs) || policy.prepareAheadMs < 0 || typeof policy.deliverEmpty !== 'boolean')) throw new TypeError('icarus: invalid delivery policy')
  if (value.template !== undefined && !TEMPLATE_IDS.includes(value.template.id)) throw new TypeError(`icarus: unknown template ${JSON.stringify(value.template.id)}`)
  if (value.investigation !== undefined) validateInvestigation(value.investigation)
  if (value.explorationPolicy !== undefined) validateExploration(value.explorationPolicy)
  if (value.maxModelRequestsPerRun !== undefined && (!Number.isSafeInteger(value.maxModelRequestsPerRun) || value.maxModelRequestsPerRun < 1)) throw new TypeError('icarus: maxModelRequestsPerRun must be a positive integer')
  return JSON.parse(JSON.stringify(value)) as MissionBindings
}

function validateInvestigation(investigation: InvestigationBinding): void {
  const fields = investigation
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw new TypeError('icarus: invalid investigation binding')
  if (typeof fields.originMissionId !== 'string' || !fields.originMissionId) throw new TypeError('icarus: investigation requires originMissionId')
  if (typeof fields.originSnapshotRef !== 'string' || !fields.originSnapshotRef) throw new TypeError('icarus: investigation requires originSnapshotRef')
  if (typeof fields.question !== 'string' || !fields.question.trim()) throw new TypeError('icarus: investigation requires a question')
  if (typeof fields.stopCondition !== 'string' || !fields.stopCondition.trim()) throw new TypeError('icarus: investigation requires a stop condition')
  if (!Array.isArray(fields.deliverableSpec) || fields.deliverableSpec.length === 0 || fields.deliverableSpec.some(item => !DELIVERABLE_SPECS.includes(item))) throw new TypeError('icarus: investigation deliverableSpec must list reading, comparison, document or code')
  for (const optional of [fields.originItemId, fields.originDeliverableId, fields.originRunId, fields.verifyCommand, fields.baseCommit, fields.worktreeRef]) {
    if (optional !== undefined && (typeof optional !== 'string' || optional === '')) throw new TypeError('icarus: invalid investigation reference')
  }
  if (fields.deliverableSpec.includes('code')) {
    if (typeof fields.verifyCommand !== 'string' || !fields.verifyCommand.trim()) throw new TypeError('icarus: code investigation requires a verify command')
    if (typeof fields.worktreeRef !== 'string' || !fields.worktreeRef.trim()) throw new TypeError('icarus: code investigation requires a worktree')
  }
}

function validateExploration(policy: ExplorationPolicy): void {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) throw new TypeError('icarus: invalid exploration policy')
  if (typeof policy.enabled !== 'boolean') throw new TypeError('icarus: explorationPolicy.enabled must be boolean')
  if (typeof policy.authorizedTopics !== 'string' || !policy.authorizedTopics.trim()) throw new TypeError('icarus: explorationPolicy requires the authorized topic statement')
  if (!Array.isArray(policy.deliverableSpecs) || policy.deliverableSpecs.length === 0 || policy.deliverableSpecs.some(item => !DELIVERABLE_SPECS.includes(item))) throw new TypeError('icarus: explorationPolicy deliverableSpecs must list known deliverable types')
  for (const limit of [policy.weeklyRuns, policy.weeklyTokens]) if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('icarus: exploration weekly limits must be non-negative integers')
}
