// Budget (M2.4): the gate before a model call, the per-Run reservation, the transactional
// settlement of real spend, and the budget face of the Run view.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SupersededError, createExecution, createRunStore, spentTokens } from '../lib/execution/index.js'
import { CHIEF_SESSION, assistantEvent, baseMission, completeTurn, goodResult, makeDue, openHarness, turnEndEvent } from './helpers/execution-harness.js'

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

function budgetFile(harness, ref) {
  return readFileSync(join(harness.dshHome, 'icarus', 'artifacts', ...ref.split('/')), 'utf8')
}

test('spent tokens are input plus output; cache traffic is recorded but not charged', () => {
  assert.equal(spentTokens(null), 0)
  assert.equal(spentTokens({ inputTokens: 10, outputTokens: 4 }), 14)
  assert.equal(spentTokens({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 900, cacheWriteTokens: 300 }), 14)
})

test('a Mission with no budget left produces a budget_exhausted Run without any call', async t => {
  const harness = openHarness(t)
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ budget: 0 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['budget_exhausted'])
  assert.match(report.outcomes[0].detail, /no remaining budget \(0 of 0 settled\)/)
  assert.equal(harness.host.created.length, 0, 'no execution Session')
  assert.equal(harness.host.prompts.length, 0, 'no prompt at all')

  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'budget_exhausted')
  assert.equal(run.usage, null)
  assert.equal(run.sessionId, null)
  const note = budgetFile(harness, run.errorRef)
  assert.match(note, /kind: budget-exhausted/)
  assert.match(note, /reserved \(remaining at claim\): 0/)
  assert.match(note, /no model call was made/)
  assert.equal(harness.missions.get(mission.id).budgetUsed, 0)
  assert.deepEqual({ ...run.budget }, { budget: 0, budgetUsed: 0, remaining: 0 })
})

test('a Mission that used up its budget is refused at the next due time', async t => {
  const harness = openHarness(t, { text: goodResult(['含来源引用']), usage: { inputTokens: 60, outputTokens: 40 } })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ budget: 100 }))
  makeDue(harness.database, mission.id, harness.now())

  const first = await execution.runs.tick()
  assert.deepEqual(first.outcomes.map(outcome => outcome.status), ['succeeded'])
  assert.equal(harness.missions.get(mission.id).budgetUsed, 100)
  assert.equal(harness.host.created.length, 1)
  assert.equal(harness.host.prompts.length, 2, 'execution prompt plus delivery')

  const runs = createRunStore(harness.database, { missions: harness.missions, now: harness.now })
  makeDue(harness.database, mission.id, harness.now())
  const second = runs.enqueueDue(mission.id)
  const outcome = await execution.executor.execute(second.id)
  assert.equal(outcome.status, 'budget_exhausted')
  assert.equal(harness.host.created.length, 1, 'the second Run never created a Session')
  assert.equal(harness.host.prompts.length, 2, 'and never prompted')
  assert.equal(harness.missions.get(mission.id).budgetUsed, 100, 'an exhausted Run spends nothing')
  assert.deepEqual({ ...execution.runs.get(second.id).budget }, { budget: 100, budgetUsed: 100, remaining: 0 })
})

test('a Run that overshoots its reservation still delivers and records the overspend', async t => {
  const harness = openHarness(t, { text: goodResult(['含来源引用']), usage: { inputTokens: 900, outputTokens: 900 } })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  assert.match(report.outcomes[0].detail, /outbox sent/)

  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'succeeded')
  assert.deepEqual({ ...run.usage }, { inputTokens: 900, outputTokens: 900 })
  assert.equal(run.errorRef, null, 'an overspent Run is not a failure')
  assert.equal(run.deliverables.length, 1)

  // The result is persisted and delivered, with the overspend visible in the record.
  const deliverable = run.deliverables[0]
  assert.deepEqual([...deliverable.artifactRefs], ['runs/' + run.id + '/deliverable.md', 'runs/' + run.id + '/budget.txt'])
  assert.equal(deliverable.outbox[0].status, 'sent')
  assert.match(deliverable.content, /超出剩余预算：可用 1000 tokens，实际 1800（超出 800）/)
  const sent = harness.host.prompts.filter(request => request.sessionId === CHIEF_SESSION)
  assert.equal(sent.length, 1)
  assert.match(sent[0].content[0].text, /超出剩余预算/)

  const note = budgetFile(harness, 'runs/' + run.id + '/budget.txt')
  assert.match(note, /kind: budget-overrun/)
  assert.match(note, /reserved \(remaining at claim\): 1000/)
  assert.match(note, /spent this run: 1800 tokens/)
  assert.match(note, /overshoot: 800/)
  assert.match(note, /persisted and delivered/)

  assert.equal(harness.missions.get(mission.id).budgetUsed, 1_800, 'the real spend is settled')
  assert.deepEqual({ ...run.budget }, { budget: 1_000, budgetUsed: 1_800, remaining: -800 })
  assert.equal(harness.missions.get(mission.id).status, 'active')

  // The overspend shuts the gate for the next Run: it ends exhausted with no call.
  const store = createRunStore(harness.database, { missions: harness.missions, now: harness.now })
  makeDue(harness.database, mission.id, harness.now())
  const second = store.enqueueDue(mission.id)
  const sessionsBefore = harness.host.created.length
  const promptsBefore = harness.host.prompts.length
  const outcome = await execution.executor.execute(second.id)
  assert.equal(outcome.status, 'budget_exhausted')
  assert.equal(harness.host.created.length, sessionsBefore)
  assert.equal(harness.host.prompts.length, promptsBefore)
  assert.match(budgetFile(harness, execution.runs.get(second.id).errorRef), /kind: budget-exhausted/)
  assert.equal(harness.missions.get(mission.id).budgetUsed, 1_800, 'the refused Run adds nothing')
})

test('a failing requirement check stays failed even when the Run also overshoots', async t => {
  const harness = openHarness(t, { text: '太短了。', usage: { inputTokens: 50, outputTokens: 50 } })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ budget: 10 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['failed'])
  assert.match(report.outcomes[0].detail, /R2 length floor/)
  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.status, 'failed')
  assert.equal(harness.missions.get(mission.id).budgetUsed, 100, 'a failed Run settles what it spent')
})

test('every terminal branch settles once: succeeded, failed and superseded', async t => {
  const harness = openHarness(t, { text: goodResult(['含来源引用']), usage: { inputTokens: 60, outputTokens: 40 } })
  const execution = executionOf(harness)
  const store = createRunStore(harness.database, { missions: harness.missions, now: harness.now })

  // succeeded
  const succeeded = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, succeeded.id, harness.now())
  const succeededReport = await execution.runs.tick()
  assert.deepEqual(succeededReport.outcomes.map(outcome => outcome.status), ['succeeded'])
  assert.equal(harness.missions.get(succeeded.id).budgetUsed, 100)
  const succeededRunId = succeededReport.enqueued[0]

  // failed (turn error, with usage already reported)
  const failing = harness.missions.create(baseMission({ budget: 1_000, ownerBotId: 'session-bot-2' }))
  makeDue(harness.database, failing.id, harness.now())
  const failingRun = store.enqueueDue(failing.id)
  harness.host.onPrompt = async (request, host) => {
    if (request.sessionId.startsWith('session-run-')) {
      queueMicrotask(() => {
        host.emit(request.sessionId, assistantEvent('部分成果', { inputTokens: 30, outputTokens: 10 }))
        host.emit(request.sessionId, turnEndEvent({ kind: 'error', error: { message: 'boom', code: 'llm/error' } }))
      })
    }
    return { accepted: true }
  }
  const failedOutcome = await execution.executor.execute(failingRun.id)
  assert.equal(failedOutcome.status, 'failed')
  assert.equal(harness.missions.get(failing.id).budgetUsed, 40)

  // superseded (Mission modified mid-run: the spend still happened)
  const superseded = harness.missions.create(baseMission({ budget: 1_000, ownerBotId: 'session-bot-3' }))
  makeDue(harness.database, superseded.id, harness.now())
  const supersededRun = store.enqueueDue(superseded.id)
  harness.host.onPrompt = async (request, host) => {
    if (request.sessionId.startsWith('session-run-')) {
      queueMicrotask(() => {
        host.emit(request.sessionId, assistantEvent('旧版成果', { inputTokens: 70, outputTokens: 30 }))
        harness.missions.modify(superseded.id, { objective: '第二版目标' })
        host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
      })
    }
    return { accepted: true }
  }
  const supersededOutcome = await execution.executor.execute(supersededRun.id)
  assert.equal(supersededOutcome.status, 'superseded')
  assert.equal(harness.missions.get(superseded.id).budgetUsed, 100, 'a superseded Run settles what it spent')

  // a repeated finish changes nothing
  assert.throws(
    () => store.finish(succeededRunId, execution.instanceId, { status: 'failed', usage: { inputTokens: 60, outputTokens: 40 } }),
    SupersededError,
  )
  assert.equal(harness.missions.get(succeeded.id).budgetUsed, 100, 'a second terminal call does not charge twice')
})

test('a null budget has no gate and still accumulates usage', async t => {
  const harness = openHarness(t, { text: goodResult(['含来源引用']), usage: { inputTokens: 5_000, outputTokens: 5_000 } })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ budget: null }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  const run = execution.runs.get(report.enqueued[0])
  assert.equal(run.deliverables.length, 1)
  assert.equal(harness.missions.get(mission.id).budgetUsed, 10_000)
  assert.deepEqual({ ...run.budget }, { budget: null, budgetUsed: 10_000, remaining: null })
  assert.equal(harness.host.prompts.filter(request => request.sessionId === CHIEF_SESSION).length, 1)
})

test('a Run mid-flight records partial usage so its settle is complete', async t => {
  const harness = openHarness(t, {
    onPrompt: async (request, host) => {
      if (request.sessionId.startsWith('session-run-')) {
        queueMicrotask(() => {
          // The second message is the closing answer: text collection keeps only what follows
          // the last tool result, so a narration-first turn still delivers the real result.
          host.emit(request.sessionId, assistantEvent('先把这一轮的进度说一下。', { inputTokens: 20, outputTokens: 5 }))
          host.emit(request.sessionId, assistantEvent(goodResult(['含来源引用']), { inputTokens: 30, outputTokens: 15 }))
          host.emit(request.sessionId, turnEndEvent({ kind: 'completed' }))
        })
      }
      return { accepted: true }
    },
  })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())

  const report = await execution.runs.tick()
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'])
  const run = execution.runs.get(report.enqueued[0])
  assert.deepEqual({ ...run.usage }, { inputTokens: 50, outputTokens: 20 })
  assert.equal(harness.missions.get(mission.id).budgetUsed, 70)
})

test('a Run killed mid-flight settles what it had recorded before recovery supersedes it', t => {
  const harness = openHarness(t)
  const store = createRunStore(harness.database, { missions: harness.missions, now: harness.now })
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  store.claim(run.id, 'instance-a', 1_000)
  store.recordUsage(run.id, 'instance-a', { inputTokens: 40, outputTokens: 10 })
  harness.clock.at += 2_000

  const report = store.recoverExpired()
  assert.deepEqual([...report.superseded], [run.id])
  assert.equal(harness.missions.get(mission.id).budgetUsed, 50, 'a crashed Run still charges the Mission')
  assert.equal(store.get(run.id).usage.inputTokens, 40)
})

test('the Run view carries the Mission budget on get and list', async t => {
  const harness = openHarness(t, { text: goodResult(['含来源引用']), usage: { inputTokens: 10, outputTokens: 10 } })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())
  const report = await execution.runs.tick()

  const listed = execution.runs.list({ missionId: mission.id })[0]
  assert.equal(listed.id, report.enqueued[0])
  assert.deepEqual({ ...listed.budget }, { budget: 1_000, budgetUsed: 20, remaining: 980 })
  assert.deepEqual({ ...execution.runs.get(listed.id).budget }, { budget: 1_000, budgetUsed: 20, remaining: 980 })
})
