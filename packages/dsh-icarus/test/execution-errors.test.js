// The failure archive (M2.5): every failure keeps its own raw record — the approval chain in
// full, the tool errors the host reported, the turn reason as it arrived — and only a failure
// path may write it. A delivery that carries a refusal is still a delivery, with no archive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SupersededError, createExecution, createRunStore } from '../lib/execution/index.js'
import {
  approvalAskedEvent,
  approvalDecidedEvent,
  assistantEvent,
  baseMission,
  goodResult,
  makeDue,
  openHarness,
  toolCallEvent,
  toolErrorEvent,
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

function archivePath(harness, run) {
  return join(harness.dshHome, 'icarus', 'artifacts', ...run.errorRef.split('/'))
}

function archiveOf(harness, run) {
  return readFileSync(archivePath(harness, run), 'utf8')
}

test('a Run that delivers after a refusal writes no failure archive at all', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    queueMicrotask(() => {
      host.emit(request.sessionId, approvalAskedEvent({ id: 'req-1', toolName: 'bash' }))
      host.emit(request.sessionId, approvalDecidedEvent('req-1', 'rejected'))
      host.emit(request.sessionId, assistantEvent(goodResult(['含来源引用']), { inputTokens: 10, outputTokens: 10 }))
      host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
    })
    return { accepted: true }
  }
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'succeeded')
  assert.equal(run.errorRef, null)
  assert.equal(existsSync(join(harness.dshHome, 'icarus', 'artifacts', 'runs', run.id, 'error.txt')), false, 'the delivery path must not write a failure archive')
})

test('a failed Run keeps the whole approval chain and the raw tool error', async t => {
  const harness = openHarness(t, {
    verification: JSON.stringify({
      objective: { passed: false, reason: '成果没有完成委托目标。', evidenceRefs: [] },
      results: [{ requirement: '含来源引用', passed: false, reason: '成果没有给出可访问的来源链接。', evidenceRefs: [] }],
      evidenceRefs: [],
      readingClaims: [],
    }),
  })
  const execution = executionOf(harness)
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    queueMicrotask(() => {
      host.emit(request.sessionId, approvalAskedEvent({ id: 'req-9', toolName: 'bash', callId: 'call-9', reason: 'sandbox escalation' }))
      host.emit(request.sessionId, approvalDecidedEvent('req-9', 'rejected'))
      host.emit(request.sessionId, toolCallEvent('call-9', 'bash'))
      host.emit(request.sessionId, toolErrorEvent('call-9', 'Error: the user rejected tool "bash"', { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' }))
      // The model was told to stop and explain instead of working around the refusal, and what it
      // produced does not satisfy the Mission's requirements.
      host.emit(request.sessionId, assistantEvent('这次没能完成。', { inputTokens: 30, outputTokens: 10 }))
      host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
    })
    return { accepted: true }
  }
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['failed'])
  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'failed')
  assert.deepEqual(run.deliverables.map(item => item.outbox[0].purpose), ['fault'], 'a failed Run delivers no result, only its fault notice')

  const archive = archiveOf(harness, run)
  assert.match(archive, /^Icarus Run .* failure archive/)
  assert.match(archive, /kind: requirement-check/)
  assert.match(archive, /mission: .* revision 1 generation 1/)
  assert.match(archive, /usage: \{"inputTokens":30,"outputTokens":10\}/)
  // The asked/decided pair is complete: id, tool, call id, outcome and both timestamps.
  assert.match(archive, /approval chain \(1\):/)
  assert.match(archive, /requestId=req-9 tool=bash callId=call-9 outcome=rejected askedAt=\S+ decidedAt=\S+ reason="sandbox escalation"/)
  // Both halves of the tool error: what the model saw, and the host's structured info.
  assert.match(archive, /tool errors \(1\):/)
  assert.match(archive, /tool=bash callId=call-9 error="Error: the user rejected tool \\"bash\\"" info=\{"name":"ToolTimeoutError","code":"TOOL_TIMEOUT"\}/)
  assert.match(archive, /raw:/)
  assert.match(archive, /"passed": false/)
})

test('a turn error keeps the host code, status and request id verbatim', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    queueMicrotask(() => {
      host.emit(request.sessionId, assistantEvent('部分成果', { inputTokens: 4, outputTokens: 1 }))
      host.emit(request.sessionId, turnEndEvent({ kind: 'error', error: { message: 'boom', code: 'llm/error', status: 503, requestId: 'rid-1' } }))
    })
    return { accepted: true }
  }
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['failed'])
  const archive = archiveOf(harness, execution.runs.get(report.enqueued[0]))
  assert.match(archive, /kind: turn-error/)
  assert.match(archive, /detail: boom/)
  assert.match(archive, /"code": "llm\/error"/)
  assert.match(archive, /"status": 503/)
  assert.match(archive, /"requestId": "rid-1"/)
  assert.match(archive, /approval chain \(0\):\n  none/)
})

test('an execution error archives its name, a stack summary and the session', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  harness.host.onPrompt = async () => {
    throw new TypeError('the host refused the prompt')
  }
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['failed'])
  const run = execution.runs.get(report.enqueued[0])
  assert.match(run.errorRef, new RegExp(`^runs/${run.id}/error\\.txt$`))
  const archive = archiveOf(harness, run)
  assert.match(archive, /kind: execution-error/)
  assert.match(archive, /detail: TypeError: the host refused the prompt/)
  assert.match(archive, /session: session-run-1/)
  assert.match(archive, /"name": "TypeError"/)
  assert.match(archive, /"stack": "TypeError: the host refused the prompt\\n/)
})

test('a superseded Run keeps its failure out of the archive: no errorRef, no file', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  const store = createRunStore(harness.database, { missions: harness.missions, now: harness.now })
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  harness.host.onPrompt = async (request, host) => {
    if (request.sessionId.startsWith('session-run-')) {
      queueMicrotask(() => {
        host.emit(request.sessionId, assistantEvent(goodResult(['含来源引用']), { inputTokens: 10, outputTokens: 10 }))
        harness.missions.modify(mission.id, { objective: '第二版目标' })
        host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
      })
    }
    return { accepted: true }
  }

  const outcome = await execution.executor.execute(run.id)
  assert.equal(outcome.status, 'superseded')
  const stored = store.get(run.id)
  assert.equal(stored.status, 'superseded')
  assert.equal(stored.errorRef, null)
  assert.equal(existsSync(join(harness.dshHome, 'icarus', 'artifacts', 'runs', run.id, 'error.txt')), false)
  assert.equal(harness.missions.get(mission.id).budgetUsed, 20, 'the spent tokens still settle')
})

test('the archive keeps an open approval readable when the turn times out waiting', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness, { timeoutMs: 30 })
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    // Asked, never decided: the turn times out with the request still open.
    queueMicrotask(() => host.emit(request.sessionId, approvalAskedEvent({ id: 'req-open', toolName: 'bash', callId: 'call-open' })))
    return { accepted: true }
  }
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['failed'])
  const run = execution.runs.get(report.enqueued[0])
  const archive = archiveOf(harness, run)
  assert.match(archive, /kind: approval-timeout/)
  assert.match(archive, /detail: the turn was still waiting for an approval after 30 ms/)
  assert.match(archive, /requestId=req-open tool=bash callId=call-open outcome=open askedAt=\S+ decidedAt=open/)
  assert.equal(run.approvalRefs[0].outcome, null, 'an unanswered request stays open in the chain')
})

test('a superseded wait cannot be recorded as live, and writes no archive', t => {
  const harness = openHarness(t)
  const store = createRunStore(harness.database, { missions: harness.missions, now: harness.now })
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  store.claim(run.id, 'instance-a', 1_000)
  store.markAwaitingApproval(run.id, 'instance-a', { requestId: 'req-1', toolName: 'bash' })
  assert.equal(store.markSuperseded(run.id, 'instance-a'), true)

  assert.throws(() => store.committable(run.id, 'instance-a'), SupersededError)
  assert.equal(store.recordApproval(run.id, 'instance-a', { requestId: 'req-1', outcome: 'allowed-once' }), false)
  assert.equal(store.get(run.id).status, 'superseded')
  assert.equal(store.get(run.id).errorRef, null)
  assert.equal(existsSync(join(harness.dshHome, 'icarus', 'artifacts', 'runs', run.id, 'error.txt')), false)
})
