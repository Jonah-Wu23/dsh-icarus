// Outbox: the three delivery outcomes (sent / delivery_unknown / failed) and how a retry
// looks on the same row. Uses the real `/api/bot` delivery path against a fake host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOutboxService, createRunStore } from '../lib/execution/index.js'
import { CHIEF_SESSION, baseMission, makeDue, openHarness } from './helpers/execution-harness.js'

const RETRY_DELAY = 60_000
const LEASE = 60_000

/** A claimed Run with a committed deliverable and one pending Outbox row. */
function pendingOutbox(harness, bot = 'Chief') {
  const store = createRunStore(harness.database, { missions: harness.missions, now: harness.now })
  const mission = harness.missions.create(baseMission({ ownerBotId: bot === 'Chief' ? CHIEF_SESSION : bot }))
  makeDue(harness.database, mission.id, harness.now())
  const run = store.enqueueDue(mission.id)
  store.claim(run.id, 'instance-a', LEASE)
  const committed = store.commit(run.id, 'instance-a', {
    deliverable: { id: 'deliverable-1', content: '成果正文', contentHash: 'hash-1', requirementResults: { passed: true }, artifactRefs: ['runs/x/body.md'], evidenceRefs: [] },
    outboxId: 'outbox-1',
    channel: 'bot',
    usage: null,
  })
  const outbox = createOutboxService({
    database: harness.database,
    ctx: harness.ctx,
    bot,
    dshHome: harness.dshHome,
    now: harness.now,
    retryDelayMs: RETRY_DELAY,
    timeoutMs: 40,
  })
  return { store, mission, run, outbox, ...committed }
}

test('a confirmed delivery settles the row as sent and is not repeated', async t => {
  const harness = openHarness(t)
  const { outbox, outboxId, deliverableId } = pendingOutbox(harness)

  const attempt = await outbox.attempt(outboxId)
  assert.deepEqual({ ...attempt }, { outboxId, status: 'sent', destinationRef: CHIEF_SESSION, attempted: true })
  assert.deepEqual({ ...outbox.get(outboxId) }, {
    id: outboxId,
    deliverableId,
    channel: 'bot',
    destinationRef: CHIEF_SESSION,
    status: 'sent',
    attemptCount: 1,
    receiptRef: null,
    nextAttemptAt: null,
  })

  const again = await outbox.attempt(outboxId)
  assert.equal(again.attempted, false)
  assert.equal(again.status, 'sent')
  assert.equal(harness.host.prompts.filter(request => request.sessionId === CHIEF_SESSION).length, 1)
})

test('an unconfirmed delivery remains delivery_unknown without an automatic retry', async t => {
  const harness = openHarness(t, {
    onPrompt: async request => (request.sessionId === CHIEF_SESSION ? new Promise(() => {}) : { accepted: true }),
  })
  const { outbox, outboxId, mission } = pendingOutbox(harness)

  const attempt = await outbox.attempt(outboxId)
  assert.equal(attempt.status, 'delivery_unknown')
  const row = outbox.get(outboxId)
  assert.equal(row.status, 'delivery_unknown')
  assert.equal(row.attemptCount, 1)
  assert.equal(row.nextAttemptAt, null)
  assert.match(harness.host.logged('warn').join('\n'), /unconfirmed/)
  assert.equal(harness.missions.get(mission.id).status, 'active', 'an unconfirmed send does not complete a Mission')
})

test('a refused delivery becomes failed and keeps the raw error in the log', async t => {
  const harness = openHarness(t)
  const { outbox, outboxId } = pendingOutbox(harness, 'Nobody')

  const attempt = await outbox.attempt(outboxId)
  assert.equal(attempt.status, 'failed')
  const row = outbox.get(outboxId)
  assert.equal(row.attemptCount, 1)
  assert.equal(row.nextAttemptAt, harness.now() + RETRY_DELAY)
  assert.match(harness.host.logged('error').join('\n'), /no Bot "Nobody"/)
})

test('a failed attempt can be retried as a new attempt on the same row', async t => {
  let deliveries = 0
  const harness = openHarness(t, {
    onPrompt: async request => {
      if (request.sessionId !== CHIEF_SESSION) return { accepted: true }
      deliveries += 1
      if (deliveries === 1) throw new Error('channel down')
      return { accepted: true }
    },
  })
  const { outbox, outboxId } = pendingOutbox(harness)

  assert.equal((await outbox.attempt(outboxId)).status, 'failed')
  assert.match(harness.host.logged('error').join('\n'), /channel down/)
  const retry = await outbox.attempt(outboxId)
  assert.equal(retry.status, 'sent')
  const row = outbox.get(outboxId)
  assert.equal(row.attemptCount, 2)
  assert.equal(row.nextAttemptAt, null)
})

test('an unknown Outbox id is refused, and the cascade keeps dangling rows impossible', async t => {
  const harness = openHarness(t)
  const { outbox } = pendingOutbox(harness)
  await assert.rejects(outbox.attempt('outbox-missing'), /no Outbox row/)
  assert.throws(() => outbox.get('outbox-missing'), /no Outbox row/)
  harness.database.db.prepare('DELETE FROM Deliverable WHERE id = ?').run('deliverable-1')
  assert.equal(harness.database.db.prepare('SELECT COUNT(*) AS n FROM Outbox').get().n, 0)
  await assert.rejects(outbox.attempt('outbox-1'), /no Outbox row/)
})
