// Execution lifecycle at the store level: due-time enqueue, claims, lease takeover,
// generation guards and startup recovery. No Sessions are involved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SupersededError, createRunStore } from '../lib/execution/index.js'
import { NOW, baseMission, makeDue, openHarness } from './helpers/execution-harness.js'

const LEASE = 60_000
const NEXT_DAILY = Date.parse('2026-10-14T13:00:00.000Z')

function storeOf(harness) {
  return createRunStore(harness.database, { missions: harness.missions, now: harness.now })
}

test('a due Mission yields one Run and rolls nextDueAt forward', t => {
  const harness = openHarness(t)
  const store = storeOf(harness)
  const mission = harness.missions.create(baseMission())
  assert.equal(mission.nextDueAt, NEXT_DAILY)
  assert.equal(store.enqueueDue(mission.id), null, 'not due yet')

  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  assert.equal(run.status, 'queued')
  assert.equal(run.missionRevision, 1)
  assert.equal(run.generation, 1)
  assert.equal(run.startedAt, null)
  assert.equal(harness.missions.get(mission.id).nextDueAt, NEXT_DAILY, 'the due time moves to the next cycle')
  assert.equal(store.enqueueDue(mission.id), null, 'a second pass creates nothing')
  assert.deepEqual(store.queuedIds(), [run.id])
})

test('a due once Mission clears its due time and never produces a second Run', t => {
  const harness = openHarness(t)
  const store = storeOf(harness)
  const mission = harness.missions.create(baseMission({ kind: 'once', schedule: { kind: 'once', at: NOW + 1_000 } }))
  harness.clock.at += 1_000

  const run = store.enqueueDue(mission.id)
  assert.equal(run.generation, 1)
  assert.equal(harness.missions.get(mission.id).nextDueAt, null)
  assert.equal(store.enqueueDue(mission.id), null)
  assert.equal(store.list({ missionId: mission.id }).length, 1)
})

test('claiming sets the lease and blocks a second claim', t => {
  const harness = openHarness(t)
  const store = storeOf(harness)
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)

  const claimed = store.claim(run.id, 'instance-a', LEASE)
  assert.equal(claimed.status, 'running')
  assert.equal(claimed.leaseOwner, 'instance-a')
  assert.equal(claimed.leaseUntil, harness.now() + LEASE)
  assert.equal(claimed.startedAt, harness.now())
  assert.equal(store.claim(run.id, 'instance-b', LEASE), null)
  assert.equal(store.get(run.id).sessionId, null)
})

test('a Run whose Mission was modified is superseded and re-queued at the new revision', t => {
  const harness = openHarness(t)
  const store = storeOf(harness)
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())
  const stale = store.enqueueDue(mission.id)

  harness.missions.modify(mission.id, { objective: '第二版目标' })
  assert.equal(store.claim(stale.id, 'instance-a', LEASE), null)
  assert.equal(store.get(stale.id).status, 'superseded')
  const queued = store.list({ missionId: mission.id, status: 'queued' })
  assert.equal(queued.length, 1)
  assert.equal(queued[0].missionRevision, 2)
  assert.equal(queued[0].generation, 2)
})

test('an expired lease is recovered as superseded plus a fresh queued Run', t => {
  const harness = openHarness(t)
  const store = storeOf(harness)
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  store.claim(run.id, 'instance-a', 1_000)
  harness.clock.at += 2_000

  const report = store.recoverExpired()
  assert.deepEqual([...report.superseded], [run.id])
  assert.equal(report.requeued.length, 1)
  assert.equal(store.get(run.id).status, 'superseded')
  const fresh = store.get(report.requeued[0])
  assert.equal(fresh.status, 'queued')
  assert.equal(fresh.generation, 2)
  assert.equal(fresh.missionRevision, 1)
})

test('a live lease survives recovery, and a paused Mission is not re-queued', t => {
  const harness = openHarness(t)
  const store = storeOf(harness)
  const live = harness.missions.create(baseMission())
  makeDue(harness.database, live.id, harness.now())
  const liveRun = store.enqueueDue(live.id)
  store.claim(liveRun.id, 'instance-a', LEASE)

  const paused = harness.missions.create(baseMission({ ownerBotId: 'session-bot-2' }))
  makeDue(harness.database, paused.id, harness.now())
  const pausedRun = store.enqueueDue(paused.id)
  store.claim(pausedRun.id, 'instance-a', 1_000)
  harness.missions.pause(paused.id)
  harness.clock.at += 2_000

  const report = store.recoverExpired()
  assert.deepEqual([...report.superseded], [pausedRun.id])
  assert.deepEqual([...report.requeued], [])
  assert.equal(store.get(liveRun.id).status, 'running')
  assert.equal(store.get(liveRun.id).leaseOwner, 'instance-a')
  assert.equal(store.get(pausedRun.id).status, 'superseded')
})

test('the old instance cannot commit after its lease expired', t => {
  const harness = openHarness(t)
  const store = storeOf(harness)
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  store.claim(run.id, 'instance-a', 1_000)
  harness.clock.at += 2_000

  assert.throws(() => store.finish(run.id, 'instance-a', { status: 'failed', usage: null }), SupersededError)
  assert.equal(store.get(run.id).status, 'superseded')
})

test('a Run taken over by another instance is not clobbered by its former owner', t => {
  const harness = openHarness(t)
  const store = storeOf(harness)
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  store.claim(run.id, 'instance-a', LEASE)
  harness.database.db.prepare('UPDATE Run SET leaseOwner = ?, leaseUntil = ? WHERE id = ?').run('instance-b', harness.now() + LEASE, run.id)

  assert.throws(() => store.committable(run.id, 'instance-a'), SupersededError)
  const current = store.get(run.id)
  assert.equal(current.status, 'running')
  assert.equal(current.leaseOwner, 'instance-b')
  assert.equal(store.renew(run.id, 'instance-b', LEASE), true)
  assert.equal(store.renew(run.id, 'instance-a', LEASE), false)
})

test('a committed Run cannot be finished again', t => {
  const harness = openHarness(t)
  const store = storeOf(harness)
  const mission = harness.missions.create(baseMission())
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  store.claim(run.id, 'instance-a', LEASE)

  const committed = store.commit(run.id, 'instance-a', {
    deliverable: { id: 'deliverable-1', content: '正文', contentHash: 'hash', requirementResults: { passed: true }, artifactRefs: ['runs/x/body.md'], evidenceRefs: [] },
    outboxId: 'outbox-1',
    channel: 'bot',
    usage: { inputTokens: 3, outputTokens: 4 },
  })
  assert.deepEqual({ ...committed }, { deliverableId: 'deliverable-1', outboxId: 'outbox-1' })
  const stored = store.get(run.id)
  assert.equal(stored.status, 'succeeded')
  assert.deepEqual({ ...stored.usage }, { inputTokens: 3, outputTokens: 4 })
  assert.equal(stored.deliverables.length, 1)
  assert.deepEqual({ ...stored.deliverables[0].outbox[0] }, {
    id: 'outbox-1',
    deliverableId: 'deliverable-1',
    channel: 'bot',
    destinationRef: null,
    status: 'pending',
    attemptCount: 0,
    receiptRef: null,
    // The row is due as soon as it is committed; a windowed Run waits for its window instead.
    nextAttemptAt: NOW,
    purpose: 'deliverable',
  })
  assert.throws(() => store.finish(run.id, 'instance-a', { status: 'failed', usage: null }), SupersededError)
  assert.equal(store.get(run.id).status, 'succeeded')
})

test('runs list filters by Mission and status', t => {
  const harness = openHarness(t)
  const store = storeOf(harness)
  const first = harness.missions.create(baseMission())
  const second = harness.missions.create(baseMission({ ownerBotId: 'session-bot-2' }))
  makeDue(harness.database, first.id, harness.now())
  makeDue(harness.database, second.id, harness.now())
  const runA = store.enqueueDue(first.id)
  store.enqueueDue(second.id)

  assert.equal(store.list().length, 2)
  assert.deepEqual(store.list({ missionId: first.id }).map(run => run.id), [runA.id])
  assert.equal(store.list({ status: 'queued' }).length, 2)
  assert.equal(store.list({ status: 'succeeded' }).length, 0)
  assert.equal(store.list({ limit: 1 }).length, 1)
  assert.throws(() => store.list({ status: 'sleeping' }), TypeError)
})
