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

export interface MissionBindings {
  readonly workspaceRef?: string
  readonly contextRefs?: readonly ContextRef[]
  readonly capabilityRequirements?: readonly CapabilityRequirement[]
  readonly deliveryPolicy?: {
    readonly mode: 'digest' | 'changes'
    readonly prepareAheadMs: number
    readonly deliverEmpty: boolean
  }
}

export function parseBindings(value: MissionBindings): MissionBindings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('icarus: invalid bindings')
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
  return JSON.parse(JSON.stringify(value)) as MissionBindings
}
