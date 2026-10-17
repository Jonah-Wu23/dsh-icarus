// Proactive exploration: proposals above the quota, allocations below it (M4.7).
//
// A proposal is the model stating what it would investigate and why that is worth a bounded run.
// Launching one is a quota reservation first and a Mission second, because Mission creation opens
// its own transaction: the reservation row is written inside this module's transaction, the child
// Mission is created after it commits, and the allocation is released if the create fails.
// A proposal's deliverable item does not exist when it is proposed, so linkItem attaches it later.
import { newId } from '../domain/ids.js'
import { inTransaction } from '../domain/missions.js'
import { instantOf, wallClockOf } from '../domain/timezone.js'
import { DELIVERABLE_SPECS } from './index.js'
import type { DeliverableSpec, InvestigationService } from './index.js'
import type { Mission, MissionService } from '../domain/index.js'
import type { IcarusDatabase } from '../storage/index.js'

const DEFAULT_ALLOCATION_TOKENS = 200_000
const COUNTED_ALLOCATIONS = `'reserved', 'settled', 'unknown'`

export const PROPOSAL_STATUSES = ['proposed', 'launched', 'deferred', 'rejected'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export const ALLOCATION_STATUSES = ['reserved', 'settled', 'released', 'unknown'] as const
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number]

export interface ExplorationProposalRecord {
  readonly id: string
  readonly missionId: string
  readonly missionRevision: number
  readonly observationId: string | null
  readonly itemId: string | null
  readonly deliverableId: string | null
  readonly question: string
  readonly value: string
  readonly relation: string
  readonly deliverableSpec: string
  readonly inScope: boolean
  readonly scopeReason: string
  readonly status: ProposalStatus
  readonly decidedReason: string | null
  readonly allocationId: string | null
  readonly investigationMissionId: string | null
  readonly createdAt: number
}

export interface ExplorationAllocationRecord {
  readonly id: string
  readonly missionId: string
  readonly proposalId: string
  readonly parentRevision: number
  readonly weekStart: number
  readonly timezone: string
  readonly allocatedTokens: number
  readonly usedTokens: number
  readonly status: AllocationStatus
  readonly childMissionId: string
  readonly childRunId: string | null
  readonly createdAt: number
  readonly settledAt: number | null
}

export interface ExplorationServiceOptions {
  readonly database: IcarusDatabase
  readonly missions: MissionService
  readonly now?: (() => number) | undefined
  readonly newId?: ((prefix: string) => string) | undefined
}

interface ProposeInput {
  readonly missionId: string
  readonly missionRevision: number
  readonly observationId: string
  readonly question: string
  readonly value: string
  readonly relation: string
  readonly deliverableSpec: readonly DeliverableSpec[]
  readonly inScope: boolean
  readonly scopeReason: string
}

interface DecideInput {
  readonly proposalId: string
  readonly authorized: boolean
  readonly reason: string
}

interface LaunchInput {
  readonly proposalId: string
  readonly investigation: InvestigationService
  readonly allocatedTokens?: number
  readonly authorizationRef?: string | null
}

export interface ExplorationService {
  remaining(missionId: string): { weekStart: number; runsLeft: number; tokensLeft: number }
  propose(input: ProposeInput): ExplorationProposalRecord
  decide(input: DecideInput): ExplorationProposalRecord
  launch(input: LaunchInput): { proposal: ExplorationProposalRecord; allocation: ExplorationAllocationRecord; mission: Mission } | { proposal: ExplorationProposalRecord; reason: string }
  settle(childMissionId: string): void
  proposals(missionId: string): ExplorationProposalRecord[]
  allocations(missionId: string): ExplorationAllocationRecord[]
  linkItem(proposalId: string, itemId: string, deliverableId: string): void
  /** The allocation whose child Mission this is; undefined when the Mission was not launched as exploration. */
  findLaunch(childMissionId: string): ExplorationAllocationRecord | undefined
}

interface ProposalRow {
  readonly id: string
  readonly missionId: string
  readonly missionRevision: number
  readonly observationId: string | null
  readonly itemId: string | null
  readonly deliverableId: string | null
  readonly question: string
  readonly value: string
  readonly relation: string
  readonly deliverableSpec: string
  readonly inScope: number
  readonly scopeReason: string
  readonly status: string
  readonly decidedReason: string | null
  readonly allocationId: string | null
  readonly investigationMissionId: string | null
  readonly createdAt: number
}

interface AllocationRow {
  readonly id: string
  readonly missionId: string
  readonly proposalId: string
  readonly parentRevision: number
  readonly weekStart: number
  readonly timezone: string
  readonly allocatedTokens: number
  readonly usedTokens: number
  readonly status: string
  readonly childMissionId: string
  readonly childRunId: string | null
  readonly createdAt: number
  readonly settledAt: number | null
}

type LaunchState =
  | { readonly state: 'existing'; readonly proposal: ExplorationProposalRecord; readonly allocation: ExplorationAllocationRecord }
  | { readonly state: 'deferred'; readonly proposal: ExplorationProposalRecord; readonly reason: string }
  | {
    readonly state: 'reserved'
    readonly proposal: ExplorationProposalRecord
    readonly allocation: ExplorationAllocationRecord
    readonly parentMissionId: string
    readonly itemId: string | null
  }

/** Monday 00:00 local time of the week containing the instant, as a UTC instant. */
export function weekStartOf(instant: number, timezone: string): number {
  const wall = wallClockOf(instant, timezone)
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day))
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return instantOf({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: 0, minute: 0, second: 0 }, timezone)
}

export function createExplorationService(options: ExplorationServiceOptions): ExplorationService {
  const { database, missions } = options
  const { db } = database
  const now = options.now ?? (() => Date.now())
  const mintId = options.newId ?? newId

  function toProposal(row: ProposalRow): ExplorationProposalRecord {
    return {
      id: row.id,
      missionId: row.missionId,
      missionRevision: row.missionRevision,
      observationId: row.observationId,
      itemId: row.itemId,
      deliverableId: row.deliverableId,
      question: row.question,
      value: row.value,
      relation: row.relation,
      deliverableSpec: row.deliverableSpec,
      inScope: row.inScope === 1,
      scopeReason: row.scopeReason,
      status: proposalStatusOf(row.status),
      decidedReason: row.decidedReason,
      allocationId: row.allocationId,
      investigationMissionId: row.investigationMissionId,
      createdAt: row.createdAt,
    }
  }

  function toAllocation(row: AllocationRow): ExplorationAllocationRecord {
    return {
      id: row.id,
      missionId: row.missionId,
      proposalId: row.proposalId,
      parentRevision: row.parentRevision,
      weekStart: row.weekStart,
      timezone: row.timezone,
      allocatedTokens: row.allocatedTokens,
      usedTokens: row.usedTokens,
      status: allocationStatusOf(row.status),
      childMissionId: row.childMissionId,
      childRunId: row.childRunId,
      createdAt: row.createdAt,
      settledAt: row.settledAt,
    }
  }

  function proposalOf(proposalId: string): ExplorationProposalRecord {
    const row = db.prepare('SELECT * FROM ExplorationProposal WHERE id = ?').get<ProposalRow>(proposalId)
    if (row === undefined) throw new Error(`icarus: no exploration proposal ${JSON.stringify(proposalId)}`)
    return toProposal(row)
  }

  function allocationOf(allocationId: string): ExplorationAllocationRecord {
    const row = db.prepare('SELECT * FROM ExplorationAllocation WHERE id = ?').get<AllocationRow>(allocationId)
    if (row === undefined) throw new Error(`icarus: no exploration allocation ${JSON.stringify(allocationId)}`)
    return toAllocation(row)
  }

  function allocationByProposal(proposalId: string): ExplorationAllocationRecord | undefined {
    const row = db.prepare('SELECT * FROM ExplorationAllocation WHERE proposalId = ?').get<AllocationRow>(proposalId)
    return row === undefined ? undefined : toAllocation(row)
  }

  function weekTotals(missionId: string, weekStart: number): { runs: number; tokens: number } {
    const row = db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(allocatedTokens), 0) AS tokens FROM ExplorationAllocation
      WHERE missionId = ? AND weekStart = ? AND status IN (${COUNTED_ALLOCATIONS})`).get<{ runs: number; tokens: number }>(missionId, weekStart)
    return { runs: row?.runs ?? 0, tokens: row?.tokens ?? 0 }
  }

  function defer(proposalId: string, reason: string): LaunchState {
    db.prepare(`UPDATE ExplorationProposal SET status = 'deferred', decidedReason = ? WHERE id = ?`).run(reason, proposalId)
    return { state: 'deferred', proposal: proposalOf(proposalId), reason }
  }

  /** Create the child Mission after the reservation committed; release the row when it refuses. */
  function createChild(
    investigation: InvestigationService,
    state: Extract<LaunchState, { state: 'reserved' }>,
    authorizationRef: string | null | undefined,
  ): ReturnType<InvestigationService['create']> {
    try {
      return investigation.create({
        ownerMissionId: state.parentMissionId,
        ...(state.itemId === null ? {} : { itemId: state.itemId }),
        question: state.proposal.question,
        deliverableSpec: specsOf(state.proposal.deliverableSpec),
        stopCondition: '满足成果要求后结束',
        budget: state.allocation.allocatedTokens,
        ...(authorizationRef === undefined || authorizationRef === null ? {} : { authorizationRef }),
      })
    } catch (error) {
      inTransaction(database, () => {
        db.prepare(`UPDATE ExplorationAllocation SET status = 'released' WHERE id = ? AND status = 'reserved'`).run(state.allocation.id)
        db.prepare(`UPDATE ExplorationProposal SET status = 'deferred', decidedReason = 'launch-failed', allocationId = NULL WHERE id = ?`).run(state.proposal.id)
      })
      throw error
    }
  }

  return {
    remaining(missionId: string): { weekStart: number; runsLeft: number; tokensLeft: number } {
      const mission = missions.get(missionId)
      const weekStart = weekStartOf(now(), mission.timezone)
      const policy = mission.explorationPolicy
      const totals = weekTotals(mission.id, weekStart)
      if (policy === undefined || !policy.enabled) return { weekStart, runsLeft: 0, tokensLeft: 0 }
      return {
        weekStart,
        runsLeft: Math.max(0, policy.weeklyRuns - totals.runs),
        tokensLeft: Math.max(0, policy.weeklyTokens - totals.tokens),
      }
    },
    propose(input: ProposeInput): ExplorationProposalRecord {
      const mission = missions.get(input.missionId)
      if (!Number.isSafeInteger(input.missionRevision) || input.missionRevision < 1) throw new TypeError('icarus: exploration proposal requires a positive Mission revision')
      if (typeof input.inScope !== 'boolean') throw new TypeError('icarus: exploration inScope must be boolean')
      const specs = parseSpecs(input.deliverableSpec)
      const question = nonEmptyString(input.question, 'question')
      const value = nonEmptyString(input.value, 'value')
      const relation = nonEmptyString(input.relation, 'relation')
      const scopeReason = nonEmptyString(input.scopeReason, 'scopeReason')
      const observation = db.prepare(`SELECT Observation.id FROM Observation JOIN Source ON Source.id = Observation.sourceId
        WHERE Observation.id = ? AND Source.missionId = ?`).get<{ id: string }>(input.observationId, mission.id)
      if (observation === undefined) throw new Error('icarus: exploration observation is outside the Mission')
      const id = mintId('proposal')
      db.prepare(`INSERT INTO ExplorationProposal (id, missionId, missionRevision, observationId, itemId, deliverableId,
        question, value, relation, deliverableSpec, inScope, scopeReason, status, decidedReason, allocationId,
        investigationMissionId, createdAt) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'proposed', NULL, NULL, NULL, ?)`)
        .run(id, mission.id, input.missionRevision, observation.id, question, value, relation, JSON.stringify(specs), input.inScope ? 1 : 0, scopeReason, now())
      return proposalOf(id)
    },
    decide(input: DecideInput): ExplorationProposalRecord {
      const proposal = proposalOf(input.proposalId)
      if (proposal.status === 'launched') throw new Error(`icarus: exploration proposal ${JSON.stringify(proposal.id)} is already launched`)
      if (typeof input.authorized !== 'boolean') throw new TypeError('icarus: exploration decision requires authorization')
      const reason = nonEmptyString(input.reason, 'reason')
      db.prepare('UPDATE ExplorationProposal SET status = ?, decidedReason = ? WHERE id = ?')
        .run(input.authorized ? 'proposed' : 'rejected', reason, proposal.id)
      return proposalOf(proposal.id)
    },
    launch(input: LaunchInput): { proposal: ExplorationProposalRecord; allocation: ExplorationAllocationRecord; mission: Mission } | { proposal: ExplorationProposalRecord; reason: string } {
      const at = now()
      const initial = proposalOf(input.proposalId)
      if (initial.status === 'launched') {
        const allocation = allocationByProposal(initial.id)
        if (allocation === undefined) throw new Error(`icarus: launched proposal ${JSON.stringify(initial.id)} has no allocation`)
        return { proposal: initial, allocation, mission: missions.get(allocation.childMissionId) }
      }
      const reservation = inTransaction(database, (): LaunchState => {
        const proposal = proposalOf(input.proposalId)
        if (proposal.status === 'launched') {
          const allocation = allocationByProposal(proposal.id)
          if (allocation === undefined) throw new Error(`icarus: launched proposal ${JSON.stringify(proposal.id)} has no allocation`)
          return { state: 'existing', proposal, allocation }
        }
        if (proposal.status === 'rejected') return { state: 'deferred', proposal, reason: 'proposal-rejected' }
        const parent = missions.get(proposal.missionId)
        if (parent.status !== 'active' && parent.status !== 'completed') return defer(proposal.id, 'owner-mission-inactive')
        const policy = parent.explorationPolicy
        if (policy === undefined || !policy.enabled) return defer(proposal.id, 'policy-disabled')
        const specs = specsOf(proposal.deliverableSpec)
        if (!specs.every(spec => policy.deliverableSpecs.includes(spec))) return defer(proposal.id, 'deliverable-spec-out-of-policy')
        const weekStart = weekStartOf(at, parent.timezone)
        const totals = weekTotals(proposal.missionId, weekStart)
        const runsLeft = policy.weeklyRuns - totals.runs
        const tokensLeft = policy.weeklyTokens - totals.tokens
        if (runsLeft <= 0) return defer(proposal.id, 'weekly-runs-exhausted')
        if (tokensLeft <= 0) return defer(proposal.id, 'weekly-tokens-exhausted')
        const allocated = input.allocatedTokens === undefined ? Math.min(tokensLeft, DEFAULT_ALLOCATION_TOKENS) : input.allocatedTokens
        if (!Number.isSafeInteger(allocated) || allocated < 1) throw new TypeError('icarus: allocated tokens must be a positive integer')
        if (allocated > tokensLeft) return defer(proposal.id, 'weekly-tokens-exhausted')
        if (allocationByProposal(proposal.id) !== undefined) throw new Error('icarus: an exploration allocation is already reserved for this proposal')
        const allocation: ExplorationAllocationRecord = {
          id: mintId('allocation'), missionId: proposal.missionId, proposalId: proposal.id, parentRevision: parent.revision,
          weekStart, timezone: parent.timezone, allocatedTokens: allocated, usedTokens: 0, status: 'reserved',
          childMissionId: 'pending', childRunId: null, createdAt: at, settledAt: null,
        }
        db.prepare(`INSERT INTO ExplorationAllocation (id, missionId, proposalId, parentRevision, weekStart, timezone,
          allocatedTokens, usedTokens, status, childMissionId, childRunId, createdAt, settledAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'reserved', ?, NULL, ?, NULL)`)
          .run(allocation.id, allocation.missionId, allocation.proposalId, allocation.parentRevision, allocation.weekStart,
            allocation.timezone, allocation.allocatedTokens, allocation.childMissionId, allocation.createdAt)
        db.prepare('UPDATE ExplorationProposal SET allocationId = ? WHERE id = ?').run(allocation.id, proposal.id)
        return { state: 'reserved', proposal: proposalOf(proposal.id), allocation, parentMissionId: parent.id, itemId: proposal.itemId }
      })
      if (reservation.state === 'existing') {
        return { proposal: reservation.proposal, allocation: reservation.allocation, mission: missions.get(reservation.allocation.childMissionId) }
      }
      if (reservation.state === 'deferred') return { proposal: reservation.proposal, reason: reservation.reason }
      const created = createChild(input.investigation, reservation, input.authorizationRef)
      const finished = inTransaction(database, () => {
        db.prepare('UPDATE ExplorationAllocation SET childMissionId = ? WHERE id = ?').run(created.mission.id, reservation.allocation.id)
        db.prepare(`UPDATE ExplorationProposal SET status = 'launched', investigationMissionId = ?, allocationId = ? WHERE id = ?`)
          .run(created.mission.id, reservation.allocation.id, input.proposalId)
        return { proposal: proposalOf(input.proposalId), allocation: allocationOf(reservation.allocation.id) }
      })
      return { proposal: finished.proposal, allocation: finished.allocation, mission: created.mission }
    },
    settle(childMissionId: string): void {
      const row = db.prepare('SELECT * FROM ExplorationAllocation WHERE childMissionId = ? ORDER BY createdAt DESC, id DESC LIMIT 1')
        .get<AllocationRow>(childMissionId)
      if (row === undefined) throw new Error(`icarus: no exploration allocation for child Mission ${JSON.stringify(childMissionId)}`)
      const mission = missions.get(childMissionId)
      const usedTokens = Math.min(mission.budgetUsed, row.allocatedTokens)
      db.prepare(`UPDATE ExplorationAllocation SET status = 'settled', usedTokens = ?, settledAt = ? WHERE id = ?`)
        .run(usedTokens, now(), row.id)
    },
    proposals(missionId: string): ExplorationProposalRecord[] {
      return db.prepare('SELECT * FROM ExplorationProposal WHERE missionId = ? ORDER BY createdAt, id').all<ProposalRow>(missionId).map(toProposal)
    },
    allocations(missionId: string): ExplorationAllocationRecord[] {
      return db.prepare('SELECT * FROM ExplorationAllocation WHERE missionId = ? ORDER BY createdAt, id').all<AllocationRow>(missionId).map(toAllocation)
    },
    linkItem(proposalId: string, itemId: string, deliverableId: string): void {
      proposalOf(proposalId)
      const item = db.prepare('SELECT id FROM DeliverableItem WHERE id = ? AND deliverableId = ?').get<{ id: string }>(itemId, deliverableId)
      if (item === undefined) throw new Error('icarus: exploration item does not belong to the deliverable')
      db.prepare('UPDATE ExplorationProposal SET itemId = ?, deliverableId = ? WHERE id = ?').run(itemId, deliverableId, proposalId)
    },
    findLaunch(childMissionId: string): ExplorationAllocationRecord | undefined {
      const row = db.prepare('SELECT * FROM ExplorationAllocation WHERE childMissionId = ? ORDER BY createdAt DESC, id DESC LIMIT 1')
        .get<AllocationRow>(childMissionId)
      return row === undefined ? undefined : toAllocation(row)
    },
  }
}

function proposalStatusOf(value: string): ProposalStatus {
  if (!(PROPOSAL_STATUSES as readonly string[]).includes(value)) throw new Error(`icarus: stored exploration proposal status ${JSON.stringify(value)} is unknown`)
  return value as ProposalStatus
}

function allocationStatusOf(value: string): AllocationStatus {
  if (!(ALLOCATION_STATUSES as readonly string[]).includes(value)) throw new Error(`icarus: stored exploration allocation status ${JSON.stringify(value)} is unknown`)
  return value as AllocationStatus
}

function parseSpecs(value: readonly DeliverableSpec[]): DeliverableSpec[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('icarus: deliverableSpec must list at least one deliverable type')
  const specs: DeliverableSpec[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !(DELIVERABLE_SPECS as readonly string[]).includes(item)) throw new TypeError(`icarus: unknown deliverable type ${JSON.stringify(item)}`)
    const spec = item as DeliverableSpec
    if (!specs.includes(spec)) specs.push(spec)
  }
  return specs
}

function specsOf(json: string): DeliverableSpec[] {
  return parseSpecs(JSON.parse(json) as readonly DeliverableSpec[])
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`icarus: ${field} must be a non-empty string`)
  return value.trim()
}
