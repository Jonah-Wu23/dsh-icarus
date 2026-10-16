// Executor: the full Run flow with a fake host — Session creation, the prompt built from the
// pinned revision, turn collection, the requirement check the model answers, the deliverable,
// the delivery scan and the Mission status that follows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createExecution, createRunStore } from '../lib/execution/index.js'
import { CHIEF_SESSION, NOW, assistantEvent, baseMission, completeTurn, goodResult, makeDue, openHarness, toolCallEvent, toolResultEvent, turnEndEvent } from './helpers/execution-harness.js'

const USAGE = { inputTokens: 120, outputTokens: 45 }

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

function artifactFile(harness, ref) {
  return join(harness.dshHome, 'icarus', 'artifacts', ...ref.split('/'))
}

function deliveredPrompts(harness) {
  return harness.host.prompts.filter(request => request.sessionId === CHIEF_SESSION)
}

test('a completed turn becomes a deliverable, an artifact, an outbox row and a Bot message', async t => {
  const requirements = ['含来源引用']
  const text = goodResult(requirements)
  const harness = openHarness(t, { text, usage: USAGE })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ requirements }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.errors, [])
  assert.equal(report.enqueued.length, 1)
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  // Delivery has its own scan: a committed Run leaves the Outbox row pending until it runs.
  await execution.outbox.tick()

  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'succeeded')
  assert.equal(run.sessionId, 'session-run-1')
  assert.deepEqual({ ...run.usage }, USAGE)
  assert.equal(run.endedAt, harness.now())
  assert.equal(run.errorRef, null)
  assert.equal(run.deliverables.length, 1)

  const deliverable = run.deliverables[0]
  assert.equal(deliverable.artifactRefs.length, 1)
  const body = artifactFile(harness, deliverable.artifactRefs[0])
  assert.ok(existsSync(body))
  assert.equal(readFileSync(body, 'utf8'), text.trim())
  assert.match(deliverable.content, /Icarus｜Run/)
  assert.match(deliverable.content, /https:\/\/arxiv\.org\/abs\/2610\.00001/)
  assert.equal(deliverable.contentHash.length, 64)
  assert.deepEqual([...deliverable.evidenceRefs], ['https://arxiv.org/abs/2610.00001'])
  assert.equal(deliverable.requirementResults.passed, true)
  const { receiptRef, ...outboxRow } = deliverable.outbox[0]
  assert.deepEqual(outboxRow, {
    id: deliverable.outbox[0].id,
    deliverableId: deliverable.id,
    channel: 'bot',
    destinationRef: CHIEF_SESSION,
    status: 'sent',
    attemptCount: 1,
    nextAttemptAt: null,
    purpose: 'deliverable',
  })
  assert.match(receiptRef, new RegExp(`^deliveries/${deliverable.outbox[0].id}/.+-receipt\\.json$`))
  assert.equal(execution.outbox.receipt(deliverable.outbox[0].id).meaning, 'host_prompt_accepted')

  const sent = deliveredPrompts(harness)
  assert.equal(sent.length, 1)
  assert.match(sent[0].content[0].text, /Icarus｜Run/)
  assert.equal(harness.missions.get(mission.id).status, 'active', 'a recurring Mission stays active')
  assert.equal(harness.missions.get(mission.id).revision, 1)
})

test('the execution Session runs in the workspace and is prompted with the pinned revision', async t => {
  const harness = openHarness(t, { text: goodResult(['含来源引用']) })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ requirements: ['含来源引用'] }))
  makeDue(harness.database, mission.id, harness.now())
  await execution.runs.tick()

  assert.deepEqual({ ...harness.host.created[0] }, { cwd: join(harness.dshHome, 'icarus', 'workspace') })
  const prompt = harness.host.prompts[0]
  assert.equal(prompt.mode, 'queue')
  assert.match(prompt.requestId, /^[0-9a-f-]{36}$/)
  assert.match(prompt.content[0].text, /委托目标：arXiv cs.AI 每日摘要/)
  assert.match(prompt.content[0].text, /1\. 含来源引用/)
  assert.match(prompt.content[0].text, /（Mission revision 1）/)
  assert.match(prompt.content[0].text, /Asia\/Singapore/)
})

test('a once Mission completes after a confirmed delivery', async t => {
  const harness = openHarness(t, { text: goodResult(['含来源引用']), usage: USAGE })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ kind: 'once', schedule: { kind: 'once', at: NOW + 1_000 } }))
  harness.clock.at += 1_000

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  await execution.outbox.tick()
  assert.equal(harness.missions.get(mission.id).status, 'completed')
  assert.equal(harness.missions.get(mission.id).nextDueAt, null)
  assert.equal(execution.runs.get(report.enqueued[0]).usage.outputTokens, 45)
})

test('a result that fails the requirement check fails the Run and keeps the raw text', async t => {
  const harness = openHarness(t, {
    text: '太短了。',
    verification: JSON.stringify({
      objective: { passed: true, reason: '成果表达了委托目标。', evidenceRefs: [] },
      results: [{ requirement: '含来源引用', passed: false, reason: '正文没有给出可访问的来源链接。', evidenceRefs: [] }],
      evidenceRefs: [],
      readingClaims: [],
    }),
  })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.equal(report.outcomes[0].status, 'failed')
  assert.match(report.outcomes[0].detail, /含来源引用：正文没有给出可访问的来源链接。/)
  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'failed')
  assert.deepEqual(run.deliverables.map(item => item.outbox[0].purpose), ['fault'], 'the failure announces itself with a fault notice, not with a result')
  const raw = readFileSync(artifactFile(harness, run.errorRef), 'utf8')
  assert.match(raw, /kind: requirement-check/)
  assert.match(raw, /正文没有给出可访问的来源链接。/)
  assert.match(raw, /太短了。/)
  assert.equal(harness.database.db.prepare("SELECT COUNT(*) AS n FROM Outbox WHERE purpose = 'deliverable'").get().n, 0)
  assert.equal(deliveredPrompts(harness).length, 0)
  assert.equal(harness.missions.get(mission.id).status, 'active')
})

test('a turn error fails the Run with the host failure preserved raw', async t => {
  const harness = openHarness(t, {
    onPrompt: async (request, host) => {
      queueMicrotask(() => host.emit(request.sessionId, turnEndEvent({
        kind: 'error',
        error: { message: 'provider exploded', code: 'llm/error', status: 503, requestId: 'req-9' },
      })))
      return { accepted: true }
    },
  })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.equal(report.outcomes[0].status, 'failed')
  const run = execution.runs.get(report.enqueued[0])
  const raw = readFileSync(artifactFile(harness, run.errorRef), 'utf8')
  assert.match(raw, /kind: turn-error/)
  assert.match(raw, /provider exploded/)
  assert.match(raw, /"code": "llm\/error"/)
  assert.match(raw, /"status": 503/)
  assert.match(raw, /"requestId": "req-9"/)
})

test('a turn that never ends fails the Run on the execution timeout', async t => {
  const harness = openHarness(t, { onPrompt: async () => ({ accepted: true }) })
  const execution = executionOf(harness, { timeoutMs: 40 })
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.equal(report.outcomes[0].status, 'failed')
  assert.match(report.outcomes[0].detail, /no turn\/end within 40 ms/)
  const run = execution.runs.get(report.enqueued[0])
  assert.match(readFileSync(artifactFile(harness, run.errorRef), 'utf8'), /kind: turn-timeout/)
})

test('events from Sessions this executor did not create are ignored', async t => {
  const requirements = ['含来源引用']
  const text = goodResult(requirements)
  const harness = openHarness(t, {
    onPrompt: async (request, host) => {
      queueMicrotask(() => {
        completeTurn(host, 'session-other', '外部会话的文本不应该进入成果。'.repeat(20))
        host.emit(request.sessionId, toolCallEvent('call-1', 'web_search'))
        host.emit(request.sessionId, toolResultEvent('call-1'))
        completeTurn(host, request.sessionId, text, USAGE)
      })
      return { accepted: true }
    },
  })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ requirements }))
  makeDue(harness.database, mission.id, harness.now())
  await execution.runs.tick()

  const run = execution.runs.list({ missionId: mission.id })[0]
  const body = readFileSync(artifactFile(harness, run.deliverables[0].artifactRefs[0]), 'utf8')
  assert.equal(body, text.trim())
  assert.equal(body.includes('外部会话的文本'), false)
})

test('the deliverable is the closing answer, not the narration between tool calls', async t => {
  const requirements = ['含来源引用']
  const text = goodResult(requirements)
  const harness = openHarness(t, {
    onPrompt: async (request, host) => {
      queueMicrotask(() => {
        host.emit(request.sessionId, assistantEvent('作者信息已补齐，现在把完整摘要落盘并输出。'))
        host.emit(request.sessionId, toolCallEvent('call-1', 'write_file'))
        host.emit(request.sessionId, toolResultEvent('call-1', 'written'))
        host.emit(request.sessionId, assistantEvent('落盘完成，接着核一下来源。'))
        host.emit(request.sessionId, toolCallEvent('call-2', 'web_search'))
        host.emit(request.sessionId, toolResultEvent('call-2', 'ok'))
        host.emit(request.sessionId, assistantEvent(text, USAGE))
        host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
      })
      return { accepted: true }
    },
  })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ requirements }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  const run = execution.runs.get(report.enqueued[0])
  const body = readFileSync(artifactFile(harness, run.deliverables[0].artifactRefs[0]), 'utf8')
  assert.equal(body, text.trim(), 'only the segment after the last tool result is the deliverable')
  assert.equal(body.includes('作者信息已补齐'), false)
  assert.equal(body.includes('落盘完成'), false)
})

test('a turn with no tool call keeps its last assistant message, not every one of them', async t => {
  const text = goodResult(['含来源引用'])
  const harness = openHarness(t, {
    onPrompt: async (request, host) => {
      queueMicrotask(() => {
        host.emit(request.sessionId, assistantEvent('先想一下怎么写。'))
        host.emit(request.sessionId, assistantEvent('再补一句过渡。'))
        host.emit(request.sessionId, assistantEvent(text, USAGE))
        host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
      })
      return { accepted: true }
    },
  })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ requirements: ['含来源引用'] }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  const run = execution.runs.get(report.enqueued[0])
  const body = readFileSync(artifactFile(harness, run.deliverables[0].artifactRefs[0]), 'utf8')
  assert.equal(body, text.trim())
  assert.deepEqual({ ...run.usage }, USAGE, 'usage still accumulates across every assistant message')
})

test('a Mission modified while the Run is in flight supersedes it and rejects the result', async t => {
  const harness = openHarness(t, {
    onPrompt: async (request, host) => {
      queueMicrotask(() => {
        harness.missions.modify(mission.id, { objective: '第二版目标' })
        completeTurn(host, request.sessionId, goodResult(['含来源引用']))
      })
      return { accepted: true }
    },
  })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['superseded'])
  assert.match(harness.host.prompts[0].content[0].text, /委托目标：arXiv cs.AI 每日摘要/, 'the prompt keeps the pinned revision')
  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'superseded')
  assert.equal(run.deliverables.length, 0)
  assert.equal(run.errorRef, null)
  assert.equal(harness.database.db.prepare('SELECT COUNT(*) AS n FROM Deliverable').get().n, 0)
  assert.equal(harness.missions.get(mission.id).revision, 2)
})

test('a Mission cancelled while the Run is in flight leaves the result undelivered', async t => {
  const harness = openHarness(t, {
    onPrompt: async (request, host) => {
      queueMicrotask(() => {
        harness.missions.cancel(mission.id)
        completeTurn(host, request.sessionId, goodResult(['含来源引用']))
      })
      return { accepted: true }
    },
  })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['cancelled'])
  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'cancelled')
  assert.equal(run.deliverables.length, 0)
  assert.equal(deliveredPrompts(harness).length, 0)
  assert.equal(harness.missions.get(mission.id).status, 'cancelled')
})

test('a Run left queued by a previous process is claimed by the next pass', async t => {
  const harness = openHarness(t, { text: goodResult(['含来源引用']) })
  const store = createRunStore(harness.database, { missions: harness.missions, now: harness.now })
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())
  const queued = store.enqueueDue(mission.id)

  const execution = executionOf(harness)
  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.runId), [queued.id])
  assert.equal(execution.runs.get(queued.id).status, 'succeeded')
})
