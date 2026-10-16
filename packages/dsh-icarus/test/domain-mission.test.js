// Mission domain: the state machine, CRUD, the revision snapshot chain, and the
// transactionality of create/modify. Runs against the built plugin: `pnpm build` first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS, openDatabase } from '../lib/storage/index.js'
import {
  IllegalMissionTransitionError,
  MissionNotFoundError,
  MissionStateError,
  MISSION_STATUSES,
  RESCHEDULE_DELAY_MS,
  canTransition,
  createMissionService,
} from '../lib/domain/index.js'

const NOW = Date.parse('2026-10-14T12:00:00.000Z')

function openDomain(t) {
  const dshHome = mkdtempSync(join(tmpdir(), 'icarus-domain-'))
  const database = openDatabase({ dshHome })
  const missions = createMissionService(database, { now: () => NOW })
  t.after(() => {
    database.close()
    rmSync(dshHome, { recursive: true, force: true })
  })
  return { dshHome, database, missions }
}

function baseMission(overrides = {}) {
  return {
    ownerBotId: 'session-bot-1',
    kind: 'recurring',
    objective: 'arXiv cs.AI 每日摘要',
    requirements: ['每条含来源引用'],
    schedule: { kind: 'daily', time: '21:00' },
    timezone: 'Asia/Singapore',
    budget: 100_000,
    ...overrides,
  }
}

test('the transition table allows exactly the listed moves', () => {
  const legal = new Set(['active>paused', 'active>completed', 'active>cancelled', 'paused>active', 'paused>completed', 'paused>cancelled'])
  for (const from of MISSION_STATUSES) {
    for (const to of MISSION_STATUSES) {
      assert.equal(canTransition(from, to), legal.has(`${from}>${to}`), `${from} -> ${to}`)
    }
  }
})

test('pause, resume and cancel follow the table and refuse everything else', t => {
  const { missions } = openDomain(t)
  const created = missions.create(baseMission())
  assert.equal(created.status, 'active')
  assert.equal(created.revision, 1)
  assert.equal(created.nextDueAt, Date.parse('2026-10-14T13:00:00.000Z'))

  assert.throws(() => missions.resume(created.id), /cannot move from active to active/)
  const paused = missions.pause(created.id)
  assert.equal(paused.status, 'paused')
  assert.throws(() => missions.pause(created.id), IllegalMissionTransitionError)
  assert.equal(missions.resume(created.id).status, 'active')
  const cancelled = missions.cancel(created.id)
  assert.equal(cancelled.status, 'cancelled')
  // Terminal: nothing brings it back and its definition can no longer change.
  assert.throws(() => missions.resume(created.id), IllegalMissionTransitionError)
  assert.throws(() => missions.pause(created.id), IllegalMissionTransitionError)
  assert.throws(() => missions.cancel(created.id), IllegalMissionTransitionError)
  assert.throws(() => missions.modify(created.id, { objective: 'x' }), MissionStateError)
  assert.equal(missions.get(created.id).status, 'cancelled')
})

test('a recurring Mission survives delivery, a once Mission completes exactly once', t => {
  const { missions } = openDomain(t)
  const recurring = missions.create(baseMission())
  assert.equal(missions.recordDelivery(recurring.id), 'active')
  assert.equal(missions.get(recurring.id).status, 'active')
  assert.equal(missions.get(recurring.id).revision, 1)
  // A paused recurring Mission stays paused: delivery is not a status change.
  missions.pause(recurring.id)
  assert.equal(missions.recordDelivery(recurring.id), 'paused')
  assert.equal(missions.get(recurring.id).status, 'paused')
  missions.resume(recurring.id)

  const once = missions.create(baseMission({ kind: 'once', schedule: { kind: 'once', at: NOW + 3_600_000 } }))
  missions.pause(once.id)
  assert.equal(missions.recordDelivery(once.id), 'completed')
  assert.equal(missions.get(once.id).status, 'completed')
  assert.throws(() => missions.recordDelivery(once.id), /cannot move from completed to completed/)
  assert.throws(() => missions.modify(once.id, { objective: 'later' }), MissionStateError)
  assert.throws(() => missions.resume(once.id), IllegalMissionTransitionError)
})

test('get and modify refuse an unknown Mission with a named error', t => {
  const { missions } = openDomain(t)
  assert.throws(() => missions.get('mission_missing'), MissionNotFoundError)
  assert.throws(() => missions.modify('mission_missing', { objective: 'x' }), error => error.code === 'not-found')
  assert.throws(() => missions.history('mission_missing'), error => error.code === 'not-found')
})

test('create then two modifies leave a three-snapshot chain that cannot be rewritten', t => {
  const { database, missions } = openDomain(t)
  const created = missions.create(baseMission({ requirements: ['r1'] }))
  const second = missions.modify(created.id, { objective: '第二版目标', requirements: ['r1', '含来源引用'] })
  assert.equal(second.revision, 2)
  const third = missions.modify(created.id, { schedule: { kind: 'daily', time: '07:30' }, budget: 50_000 })
  assert.equal(third.revision, 3)
  assert.equal(third.objective, '第二版目标')
  assert.deepEqual([...third.requirements], ['r1', '含来源引用'])
  assert.equal(third.budget, 50_000)
  assert.equal(third.nextDueAt, Date.parse('2026-10-14T23:30:00.000Z'))

  const chain = missions.history(created.id)
  assert.deepEqual(chain.map(entry => entry.revision), [1, 2, 3])
  assert.equal(chain[0].objective, 'arXiv cs.AI 每日摘要')
  assert.equal(chain[0].budget, 100_000)
  assert.equal(chain[1].objective, '第二版目标')
  assert.equal(chain[2].budget, 50_000)
  assert.deepEqual(chain[2].schedule, { kind: 'daily', time: '07:30' })
  assert.equal(missions.get(created.id).revision, 3)

  assert.throws(() => database.db.prepare('UPDATE MissionRevision SET objective = ? WHERE missionId = ? AND revision = 1').run('rewritten', created.id), /immutable/)
  assert.equal(missions.history(created.id)[0].objective, 'arXiv cs.AI 每日摘要')
})

test('modify without a timing change keeps nextDueAt, with one it recomputes', t => {
  const { missions } = openDomain(t)
  const created = missions.create(baseMission())
  const objectiveOnly = missions.modify(created.id, { objective: '换个说法' })
  assert.equal(objectiveOnly.nextDueAt, created.nextDueAt)
  const retimed = missions.modify(created.id, { schedule: { kind: 'daily', time: '06:00' } })
  assert.equal(retimed.nextDueAt, Date.parse('2026-10-14T22:00:00.000Z'))
})

test('budget accepts a non-negative integer or null and refuses anything else', t => {
  const { missions } = openDomain(t)
  assert.equal(missions.create(baseMission({ budget: null })).budget, null)
  assert.equal(missions.create(baseMission({ budget: 0 })).budget, 0)
  assert.equal(missions.create(baseMission({ budget: undefined })).budget, null)
  for (const bad of [-1, 1.5, '100', Number.NaN]) {
    assert.throws(() => missions.create(baseMission({ budget: bad })), TypeError, `budget ${JSON.stringify(bad)}`)
  }
  const created = missions.create(baseMission())
  assert.equal(missions.modify(created.id, { budget: null }).budget, null)
})

test('create and modify validate kind, objective, requirements and the kind/schedule pair', t => {
  const { missions } = openDomain(t)
  assert.throws(() => missions.create(baseMission({ ownerBotId: '' })), /ownerBotId must be a non-empty string/)
  assert.throws(() => missions.create(baseMission({ objective: '   ' })), /objective must be a non-empty string/)
  assert.throws(() => missions.create(baseMission({ kind: 'sometimes' })), /kind must be one of/)
  assert.throws(() => missions.create(baseMission({ requirements: ['ok', ''] })), /requirements item must be a non-empty string/)
  assert.throws(() => missions.create(baseMission({ kind: 'once' })), /kind "once" needs a once schedule/)
  assert.throws(() => missions.create(baseMission({ schedule: { kind: 'once', at: NOW + 1000 } })), /kind "recurring" needs a daily or cron schedule/)
  assert.throws(() => missions.create(baseMission({ timezone: 'Mars/Phobos' })), /is not a valid IANA time zone/)
  assert.throws(() => missions.create(baseMission({ schedule: { kind: 'daily', time: '25:00' } })), /needs time "HH:mm"/)
  assert.throws(() => missions.create(baseMission({ schedule: { kind: 'weekly' } })), /unknown schedule kind/)
})

test('an explicit id is accepted and duplicates are refused by the schema', t => {
  const { missions } = openDomain(t)
  assert.equal(missions.create(baseMission({ id: 'mission_fixed' })).id, 'mission_fixed')
  assert.throws(() => missions.create(baseMission({ id: 'mission_fixed' })), /UNIQUE/)
})

test('list filters by owner, status and kind and orders by creation', t => {
  const { missions } = openDomain(t)
  const first = missions.create(baseMission({ id: 'mission_a' }))
  const second = missions.create(baseMission({ id: 'mission_b', ownerBotId: 'session-bot-2', objective: '另一个委托' }))
  missions.pause(second.id)
  assert.deepEqual(missions.list().map(mission => mission.id), [first.id, second.id])
  assert.deepEqual(missions.list({ ownerBotId: 'session-bot-2' }).map(mission => mission.id), [second.id])
  assert.deepEqual(missions.list({ status: 'paused' }).map(mission => mission.id), [second.id])
  assert.deepEqual(missions.list({ kind: 'recurring' }).map(mission => mission.id), [first.id, second.id])
  assert.deepEqual(missions.list({ status: 'completed' }), [])
  assert.throws(() => missions.list({ status: 'sleeping' }), TypeError)
})

test('a failing snapshot write rolls create and modify back completely', t => {
  const dshHome = mkdtempSync(join(tmpdir(), 'icarus-tx-'))
  const blocking = {
    version: MIGRATIONS.length + 1,
    name: 'test-block-revisions',
    sql: "CREATE TRIGGER test_block_revision BEFORE INSERT ON MissionRevision BEGIN SELECT RAISE(ABORT, 'blocked for test'); END;",
  }
  const database = openDatabase({ dshHome, migrations: [...MIGRATIONS, blocking] })
  const missions = createMissionService(database, { now: () => NOW })
  t.after(() => {
    database.close()
    rmSync(dshHome, { recursive: true, force: true })
  })
  const missionRows = () => database.db.prepare('SELECT COUNT(*) AS n FROM Mission').get().n
  const revisionRows = () => database.db.prepare('SELECT COUNT(*) AS n FROM MissionRevision').get().n

  assert.throws(() => missions.create(baseMission()), /blocked for test/)
  assert.equal(missionRows(), 0, 'the Mission insert must not survive a failed snapshot')

  // Seed the row by hand, then let modify fail on its snapshot write.
  database.db.prepare(`INSERT INTO Mission (id, ownerBotId, kind, objective, requirements, revision, status, schedule, timezone, budget, authorizationRef, budgetUsed, nextDueAt, createdAt, updatedAt)
    VALUES ('mission_seed', 'session-bot-1', 'recurring', 'seed', '[]', 1, 'active', '{"kind":"daily","time":"21:00"}', 'Asia/Singapore', NULL, NULL, 0, ?, ?, ?)`)
    .run(NOW, NOW, NOW)
  assert.throws(() => missions.modify('mission_seed', { objective: 'changed' }), /blocked for test/)
  assert.equal(revisionRows(), 0)
  const row = database.db.prepare('SELECT objective, revision FROM Mission WHERE id = ?').get('mission_seed')
  assert.deepEqual({ ...row }, { objective: 'seed', revision: 1 }, 'the revision bump must roll back with the snapshot')
  assert.deepEqual(missions.list().map(mission => mission.objective), ['seed'])
})

// A `once` Mission has one occurrence. When that occurrence is consumed without delivering, the
// Mission is `active` with nothing due — a dead end the view must show and `modify` must reopen.
function consumeDueTime(database, missionId) {
  database.db.prepare('UPDATE Mission SET nextDueAt = NULL WHERE id = ?').run(missionId)
}

function onceMission(missions, overrides = {}) {
  return missions.create(baseMission({ kind: 'once', schedule: { kind: 'once', at: NOW + 60_000 }, ...overrides }))
}

test('modify re-arms a consumed once Mission and the snapshot carries the new instant', t => {
  const { database, missions } = openDomain(t)
  const created = onceMission(missions)
  consumeDueTime(database, created.id)

  assert.equal(missions.get(created.id).awaitingReschedule, true, 'the dead end is visible before the edit')

  const rearmed = missions.modify(created.id, { objective: '换个目标再来一次' })
  assert.equal(rearmed.revision, 2)
  assert.equal(rearmed.nextDueAt, NOW + RESCHEDULE_DELAY_MS)
  assert.deepEqual(rearmed.schedule, { kind: 'once', at: NOW + RESCHEDULE_DELAY_MS })
  assert.equal(rearmed.awaitingReschedule, false)
  assert.deepEqual(missions.history(created.id)[1].schedule, { kind: 'once', at: NOW + RESCHEDULE_DELAY_MS })
})

test('a recurring Mission is never re-armed: its own next occurrence is the retry', t => {
  const { database, missions } = openDomain(t)
  const created = missions.create(baseMission())
  const kept = created.nextDueAt
  consumeDueTime(database, created.id)

  const modified = missions.modify(created.id, { objective: '改一下' })
  assert.equal(modified.nextDueAt, null)
  assert.equal(missions.get(created.id).awaitingReschedule, false, 'the flag is about once Missions only')
  assert.equal(kept, Date.parse('2026-10-14T13:00:00.000Z'))
})

test('a once Mission whose Run is still in flight is not waiting for a reschedule', t => {
  const { database, missions } = openDomain(t)
  const created = onceMission(missions)
  consumeDueTime(database, created.id)
  database.db.prepare(`INSERT INTO Run (id, missionId, missionRevision, status, inputRefs, approvalRefs, generation, createdAt)
    VALUES ('run_live', ?, 1, 'running', '[]', '[]', 1, ?)`).run(created.id, NOW)

  assert.equal(missions.get(created.id).awaitingReschedule, false)
})

test('editing an active once Mission schedules its new revision after an earlier result', t => {
  const { database, missions } = openDomain(t)
  const created = onceMission(missions)
  consumeDueTime(database, created.id)
  database.db.prepare(`INSERT INTO Run (id, missionId, missionRevision, status, inputRefs, approvalRefs, generation, createdAt)
    VALUES ('run_done', ?, 1, 'succeeded', '[]', '[]', 1, ?)`).run(created.id, NOW)
  database.db.prepare(`INSERT INTO Deliverable (id, runId, requirementResults, evidenceRefs, artifactRefs, content, contentHash, createdAt)
    VALUES ('del_done', 'run_done', '{}', '[]', '[]', '成果', 'hash', ?)`).run(NOW)
  // A commit writes the Outbox row in the same transaction as its Deliverable, and the
  // delivered check reads both: a Deliverable alone is not a delivery.
  database.db.prepare(`INSERT INTO Outbox (id, deliverableId, channel, status, purpose, createdAt, updatedAt)
    VALUES ('out_done', 'del_done', 'bot', 'sent', 'deliverable', ?, ?)`).run(NOW, NOW)

  assert.equal(missions.get(created.id).awaitingReschedule, false)
  const edited = missions.modify(created.id, { objective: '按新的要求执行' })
  assert.equal(edited.nextDueAt, NOW + RESCHEDULE_DELAY_MS)
  assert.equal(edited.revision, 2)
})

test('a failed once Mission is listed as waiting for a reschedule', t => {
  const { database, missions } = openDomain(t)
  const created = onceMission(missions)
  consumeDueTime(database, created.id)
  database.db.prepare(`INSERT INTO Run (id, missionId, missionRevision, status, inputRefs, approvalRefs, generation, createdAt)
    VALUES ('run_partial', ?, 1, 'failed', '[]', '[]', 1, ?)`).run(created.id, NOW)

  assert.deepEqual(missions.list({ kind: 'once' }).map(mission => mission.awaitingReschedule), [true])
})
