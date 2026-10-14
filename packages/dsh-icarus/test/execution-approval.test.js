// Approval binding (M2.5): the host's audit pair folded onto the Run, the suspension status, the
// lease that has to survive a slow human, and the settlement that must not change because a Run
// waited. The host vocabulary is `allowed-once` / `rejected` / `cancelled` / `unavailable`, and
// only a grant changes what the model may do — the rest is evidence, never a rewritable outcome.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SupersededError, createExecution, createRunStore } from '../lib/execution/index.js'
import {
  CHIEF_SESSION,
  approvalAskedEvent,
  approvalDecidedEvent,
  assistantEvent,
  baseMission,
  completeTurn,
  goodResult,
  makeDue,
  openHarness,
  runIdOfSession,
  turnEndEvent,
} from './helpers/execution-harness.js'

function executionOf(harness, options = {}) {
  return createExecution({
    ctx: harness.ctx,
    database: harness.database,
    missions: harness.missions,
    bot: 'Chief',
    dshHome: harness.dshHome,
    now: harness.now,
    deliveryTimeoutMs: 500,
    ...options,
  })
}

test('an asked approval suspends the Run, and a grant resumes it to success', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  const seen = []
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    queueMicrotask(() => {
      const runId = runIdOfSession(harness, request.sessionId)
      host.emit(request.sessionId, approvalAskedEvent({ id: 'req-1', toolName: 'bash', callId: 'call-1', reason: 'sandbox escalation' }))
      const waiting = execution.store.get(runId)
      seen.push({ status: waiting.status, chain: waiting.approvalRefs.length, budgetUsed: harness.missions.get(waiting.missionId).budgetUsed })
      host.emit(request.sessionId, approvalDecidedEvent('req-1', 'allowed-once'))
      seen.push({ status: execution.store.get(runId).status })
      host.emit(request.sessionId, assistantEvent(goodResult(['含来源引用']), { inputTokens: 30, outputTokens: 20 }))
      host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
    })
    return { accepted: true }
  }
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  // Waiting is an executing status: it is visible, it records the request, and it charges nothing.
  assert.deepEqual(seen, [{ status: 'awaiting_approval', chain: 1, budgetUsed: 0 }, { status: 'running' }])

  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'succeeded')
  assert.equal(run.errorRef, null)
  assert.equal(run.approvalRefs.length, 1)
  const entry = run.approvalRefs[0]
  assert.equal(entry.requestId, 'req-1')
  assert.equal(entry.toolName, 'bash')
  assert.equal(entry.callId, 'call-1')
  assert.equal(entry.reason, 'sandbox escalation')
  assert.equal(entry.outcome, 'allowed-once')
  assert.ok(entry.askedAt > 0)
  assert.ok(entry.decidedAt >= entry.askedAt)
  assert.equal(harness.missions.get(mission.id).budgetUsed, 50)
  assert.equal(run.deliverables[0].outbox[0].status, 'sent')
})

test('a refused approval that still produces a good result is delivered with the refusal spelled out', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    queueMicrotask(() => {
      host.emit(request.sessionId, approvalAskedEvent({ id: 'req-r', toolName: 'pwsh', reason: 'write outside the workspace' }))
      host.emit(request.sessionId, approvalDecidedEvent('req-r', 'rejected'))
      host.emit(request.sessionId, assistantEvent(goodResult(['含来源引用']), { inputTokens: 20, outputTokens: 20 }))
      host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
    })
    return { accepted: true }
  }
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'succeeded', 'a refusal is not a reason to destroy a paid-for result')
  assert.equal(run.errorRef, null)
  assert.equal(run.approvalRefs[0].outcome, 'rejected')
  assert.match(run.deliverables[0].content, /⚠ 本次执行有 1 次审批未获通过：pwsh（rejected）；成果据此产出。/)
  const delivered = harness.host.prompts.filter(request => request.sessionId === CHIEF_SESSION)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].content[0].text, /审批未获通过/)
})

test('cancelled and unavailable decisions are recorded as decisions, not as run failures', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  let afterStatus = null
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    queueMicrotask(() => {
      host.emit(request.sessionId, approvalAskedEvent({ id: 'req-c', toolName: 'bash' }))
      host.emit(request.sessionId, approvalDecidedEvent('req-c', 'cancelled'))
      host.emit(request.sessionId, approvalAskedEvent({ id: 'req-u', toolName: 'bash' }))
      host.emit(request.sessionId, approvalDecidedEvent('req-u', 'unavailable'))
      afterStatus = execution.store.get(runIdOfSession(harness, request.sessionId)).status
      host.emit(request.sessionId, assistantEvent(goodResult(['含来源引用']), { inputTokens: 10, outputTokens: 10 }))
      host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
    })
    return { accepted: true }
  }
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  assert.equal(afterStatus, 'running', 'the last decision returns the Run to running')
  const run = execution.runs.get(report.enqueued[0])
  assert.deepEqual(run.approvalRefs.map(entry => [entry.requestId, entry.outcome]), [['req-c', 'cancelled'], ['req-u', 'unavailable']])
  assert.match(run.deliverables[0].content, /2 次审批未获通过：bash（cancelled）、bash（unavailable）/)
})

test('an approval wait keeps its lease, so a slow answer can still commit', t => {
  const harness = openHarness(t)
  const store = createRunStore(harness.database, { missions: harness.missions, now: harness.now })
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  store.claim(run.id, 'instance-a', 1_000)
  store.attachSession(run.id, 'instance-a', 'session-run-1')
  assert.equal(store.markAwaitingApproval(run.id, 'instance-a', { requestId: 'req-1', toolName: 'bash' }), true)

  // The answering human takes longer than one lease: renewal has to cover the wait.
  harness.clock.at += 900
  assert.equal(store.renew(run.id, 'instance-a', 1_000), true, 'a waiting Run renews its lease')
  harness.clock.at += 900
  assert.equal(store.get(run.id).status, 'awaiting_approval')

  assert.equal(store.recordApproval(run.id, 'instance-a', { requestId: 'req-1', outcome: 'allowed-once' }), true)
  assert.equal(store.get(run.id).status, 'running')
  store.recordUsage(run.id, 'instance-a', { inputTokens: 10, outputTokens: 5 })
  store.commit(run.id, 'instance-a', {
    deliverable: { id: 'del-1', content: '成果', contentHash: 'h', requirementResults: {}, artifactRefs: [], evidenceRefs: [] },
    outboxId: 'out-1',
    channel: 'bot',
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  assert.equal(store.get(run.id).status, 'succeeded')
  assert.equal(harness.missions.get(mission.id).budgetUsed, 15)
})

test('an expired approval wait is superseded and requeued; a late decision cannot commit', t => {
  const harness = openHarness(t)
  const store = createRunStore(harness.database, { missions: harness.missions, now: harness.now })
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  store.claim(run.id, 'instance-a', 1_000)
  store.attachSession(run.id, 'instance-a', 'session-run-1')
  store.markAwaitingApproval(run.id, 'instance-a', { requestId: 'req-1', toolName: 'bash' })

  harness.clock.at += 2_000
  const report = store.recoverExpired()
  assert.deepEqual([...report.superseded], [run.id])
  assert.equal(report.requeued.length, 1, 'a fresh attempt is queued at the current revision')
  assert.equal(store.get(run.id).status, 'superseded')
  assert.equal(store.recordApproval(run.id, 'instance-a', { requestId: 'req-1', outcome: 'allowed-once' }), false, 'the late answer is not recorded as live')
  assert.deepEqual(store.get(run.id).approvalRefs.map(entry => entry.outcome), [null], 'the chain keeps the open request as it was')
  assert.throws(
    () => store.commit(run.id, 'instance-a', {
      deliverable: { id: 'del-1', content: '成果', contentHash: 'h', requirementResults: {}, artifactRefs: [], evidenceRefs: [] },
      outboxId: 'out-1',
      channel: 'bot',
      usage: null,
    }),
    SupersededError,
  )
  assert.deepEqual(store.queuedIds(), report.requeued)
})

test('a suspension settles neither on the ask nor on the decision: once, at the end', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  let waitingBudgetUsed = null
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    queueMicrotask(() => {
      const runId = runIdOfSession(harness, request.sessionId)
      host.emit(request.sessionId, approvalAskedEvent({ id: 'req-1', toolName: 'bash' }))
      waitingBudgetUsed = harness.missions.get(harness.missions.list()[0].id).budgetUsed
      host.emit(request.sessionId, approvalDecidedEvent('req-1', 'rejected'))
      host.emit(request.sessionId, assistantEvent(goodResult(['含来源引用']), { inputTokens: 60, outputTokens: 40 }))
      host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
    })
    return { accepted: true }
  }
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  assert.equal(waitingBudgetUsed, 0, 'an open approval charges nothing')
  assert.equal(harness.missions.get(mission.id).budgetUsed, 100)

  // The terminal write is still conditional: a second one changes nothing and charges nothing.
  assert.throws(
    () => execution.store.finish(report.enqueued[0], execution.instanceId, { status: 'failed', usage: { inputTokens: 60, outputTokens: 40 } }),
    SupersededError,
  )
  assert.equal(harness.missions.get(mission.id).budgetUsed, 100, 'the decision path never settles twice')
})

test('a waiting Run still records partial usage, so an abandoned wait settles what it spent', t => {
  const harness = openHarness(t)
  const store = createRunStore(harness.database, { missions: harness.missions, now: harness.now })
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  store.claim(run.id, 'instance-a', 1_000)
  store.markAwaitingApproval(run.id, 'instance-a', { requestId: 'req-1', toolName: 'bash' })

  assert.equal(store.recordUsage(run.id, 'instance-a', { inputTokens: 7, outputTokens: 3 }), true, 'usage keeps landing while the Run waits')
  harness.clock.at += 2_000
  const report = store.recoverExpired()
  assert.deepEqual([...report.superseded], [run.id])
  assert.equal(harness.missions.get(mission.id).budgetUsed, 10, 'a superseded wait charges what it had recorded')
})

test('the approval chain is exposed on get and list', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    queueMicrotask(() => {
      host.emit(request.sessionId, approvalAskedEvent({ id: 'req-list', toolName: 'bash' }))
      host.emit(request.sessionId, approvalDecidedEvent('req-list', 'allowed-once'))
      completeTurn(host, request.sessionId, goodResult(['含来源引用']), { inputTokens: 5, outputTokens: 5 })
    })
    return { accepted: true }
  }
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())
  const report = await execution.runs.tick()

  const listed = execution.runs.list({ missionId: mission.id })[0]
  assert.equal(listed.id, report.enqueued[0])
  assert.deepEqual(listed.approvalRefs.map(entry => entry.requestId), ['req-list'])
  assert.deepEqual(execution.runs.get(listed.id).approvalRefs.map(entry => entry.toolName), ['bash'])
})
