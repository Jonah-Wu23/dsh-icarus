// Recovery and re-arming (M2 wrap-up):
//   * recovery runs on EVERY pass, so a Run whose owner died is healed without waiting for a
//     restart — and the same pass that healed it runs the fresh attempt;
//   * a `once` Mission edited while its Run is in flight is superseded AND re-armed, so the new
//     revision actually runs instead of leaving an `active` Mission with nothing due.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExecution } from '../lib/execution/index.js'
import { baseMission, completeTurn, goodResult, makeDue, openHarness } from './helpers/execution-harness.js'

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

test('a pass heals an expired in-flight Run and runs the fresh one, without a restart', async t => {
  const harness = openHarness(t, { text: goodResult(['含来源引用']) })
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ requirements: ['含来源引用'] }))
  makeDue(harness.database, mission.id, harness.now())
  const run = execution.store.enqueueDue(mission.id)
  // An owner that is gone: the lease is set but nothing will ever renew it.
  execution.store.claim(run.id, 'instance-dead', 1_000)
  harness.clock.at += 2_000

  const report = await execution.runs.tick()
  assert.deepEqual([...report.recovered.superseded], [run.id])
  assert.equal(report.recovered.requeued.length, 1)
  assert.equal(execution.store.get(run.id).status, 'superseded')
  assert.deepEqual(report.outcomes.map(outcome => outcome.status), ['succeeded'], 'the healing pass runs the fresh Run')
  const fresh = execution.store.get(report.recovered.requeued[0])
  assert.equal(fresh.status, 'succeeded')
  assert.equal(fresh.generation, 2)
  assert.equal(fresh.missionRevision, mission.revision)
})

test('a lease this instance still holds is never healed by its own pass', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({ budget: 1_000 }))
  makeDue(harness.database, mission.id, harness.now())
  const run = execution.store.enqueueDue(mission.id)
  execution.store.claim(run.id, execution.instanceId, 60_000)
  harness.clock.at += 30_000

  const report = await execution.runs.tick()
  assert.deepEqual([...report.recovered.superseded], [])
  assert.equal(execution.store.get(run.id).status, 'running', 'renewal protects the live Run')
  assert.equal(execution.store.get(run.id).leaseOwner, execution.instanceId)
})

test('editing an in-flight once Mission re-arms it, and the next pass runs the new revision', async t => {
  const harness = openHarness(t, {})
  const execution = executionOf(harness)
  const mission = harness.missions.create(baseMission({
    kind: 'once',
    schedule: { kind: 'once', at: harness.now() + 1_000 },
    objective: '第一版目标',
    requirements: ['旧要求'],
  }))
  makeDue(harness.database, mission.id, harness.now())

  let firstTurn = true
  harness.host.onPrompt = async (request, host) => {
    if (!request.sessionId.startsWith('session-run-')) return { accepted: true }
    if (firstTurn) {
      firstTurn = false
      harness.missions.modify(mission.id, { objective: '第二版目标', requirements: ['含来源引用'] })
    }
    queueMicrotask(() => completeTurn(host, request.sessionId, goodResult(['含来源引用'])))
    return { accepted: true }
  }

  const first = await execution.runs.tick()
  assert.deepEqual(first.outcomes.map(outcome => outcome.status), ['superseded'], 'the old revision cannot commit')
  assert.equal(harness.missions.get(mission.id).awaitingReschedule, false, 'the edit re-armed the Mission')

  harness.clock.at += 5_000
  const second = await execution.runs.tick()
  assert.deepEqual(second.outcomes.map(outcome => outcome.status), ['succeeded'])
  await execution.outbox.tick()
  const runs = execution.runs.list({ missionId: mission.id })
  assert.deepEqual(runs.map(run => [run.status, run.missionRevision, run.generation]), [
    ['superseded', 1, 1],
    ['succeeded', 2, 2],
  ])
  assert.equal(harness.missions.get(mission.id).status, 'completed', 'a once Mission completes on its new revision')
})
