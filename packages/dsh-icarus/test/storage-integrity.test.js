// Storage integrity: the revision snapshot chain, the uniqueness guards M2 plan §M2.1
// fixes, and deletion that really empties a Mission's subtree (rows and artifact files).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { deleteBotData, deleteMissionData, openDatabase } from '../lib/storage/index.js'

const NOW = 1_700_000_000_000
const TABLES = ['Mission', 'MissionRevision', 'Source', 'Observation', 'Run', 'Deliverable', 'Feedback', 'PreferenceRevision', 'Outbox']

function openHome(t) {
  const dshHome = mkdtempSync(join(tmpdir(), 'icarus-integrity-'))
  const database = openDatabase({ dshHome })
  t.after(() => {
    database.close()
    rmSync(dshHome, { recursive: true, force: true })
  })
  return { dshHome, database }
}

function counts(db) {
  const result = {}
  for (const table of TABLES) result[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  return result
}

function insertMission(db, id, ownerBotId) {
  db.prepare(`INSERT INTO Mission (id, ownerBotId, kind, objective, requirements, revision, status, schedule, timezone, budget, authorizationRef, budgetUsed, nextDueAt, createdAt, updatedAt)
    VALUES (?, ?, 'recurring', 'objective', '[]', 1, 'active', '{"kind":"daily","time":"21:00"}', 'Asia/Singapore', 100000, NULL, 0, ?, ?, ?)`)
    .run(id, ownerBotId, NOW, NOW, NOW)
  db.prepare(`INSERT INTO MissionRevision (missionId, revision, kind, objective, requirements, schedule, timezone, budget, authorizationRef, createdAt)
    VALUES (?, 1, 'recurring', 'objective', '[]', '{"kind":"daily"}', 'Asia/Singapore', 100000, NULL, ?)`).run(id, NOW)
}

// One Mission with one row in every table that hangs off it.
function seedGraph(db, missionId, ownerBotId, artifactRefs = []) {
  insertMission(db, missionId, ownerBotId)
  db.prepare('INSERT INTO Source (id, missionId, adapter, locator, cursor, lastCheckedAt, lastSucceededAt, health, createdAt) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)')
    .run(`${missionId}-src`, missionId, 'rss', 'https://example.com/feed', NOW, NOW, 'ok', NOW)
  db.prepare('INSERT INTO Observation (id, sourceId, nativeId, contentHash, publishedAt, observedAt, evidenceRef, createdAt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
    .run(`${missionId}-obs`, `${missionId}-src`, 'native-1', 'hash-1', NOW, NOW, NOW)
  db.prepare(`INSERT INTO Run (id, missionId, missionRevision, preferenceRevision, status, sessionId, leaseOwner, leaseUntil, inputRefs, usage, errorRef, generation, createdAt, startedAt, endedAt)
    VALUES (?, ?, 1, NULL, 'queued', NULL, NULL, NULL, '[]', NULL, NULL, 1, ?, NULL, NULL)`).run(`${missionId}-run`, missionId, NOW)
  db.prepare(`INSERT INTO Deliverable (id, runId, requirementResults, evidenceRefs, artifactRefs, content, contentHash, createdAt)
    VALUES (?, ?, '[]', '[]', ?, '摘要', 'content-hash', ?)`).run(`${missionId}-del`, `${missionId}-run`, JSON.stringify(artifactRefs), NOW)
  db.prepare('INSERT INTO Feedback (id, deliverableId, itemId, action, comment, createdAt, supersedes) VALUES (?, ?, ?, ?, ?, ?, NULL)')
    .run(`${missionId}-fb`, `${missionId}-del`, 'item-1', 'accepted', '好', NOW)
  db.prepare('INSERT INTO PreferenceRevision (missionId, revision, explicitRequirements, inferredPreferences, feedbackRefs, createdAt) VALUES (?, 1, ?, ?, ?, ?)')
    .run(missionId, '[]', '[]', JSON.stringify([`${missionId}-fb`]), NOW)
  db.prepare(`INSERT INTO Outbox (id, deliverableId, channel, destinationRef, status, attemptCount, receiptRef, nextAttemptAt, createdAt, updatedAt)
    VALUES (?, ?, 'bot', 'session-bot', 'pending', 0, NULL, ?, ?, ?)`).run(`${missionId}-out`, `${missionId}-del`, NOW, NOW, NOW)
}

function writeArtifact(dshHome, ref, text) {
  const target = join(dshHome, 'icarus', 'artifacts', ref)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
  return target
}

test('Mission revisions move forward only and written snapshots stay immutable', t => {
  const { database } = openHome(t)
  const db = database.db
  insertMission(db, 'A', 'bot-1')

  db.prepare('UPDATE Mission SET revision = 2, objective = ?, updatedAt = ? WHERE id = ?').run('objective v2', NOW + 1, 'A')
  db.prepare(`INSERT INTO MissionRevision (missionId, revision, kind, objective, requirements, schedule, timezone, budget, authorizationRef, createdAt)
    VALUES ('A', 2, 'recurring', 'objective v2', '[]', '{"kind":"daily"}', 'Asia/Singapore', 100000, NULL, ?)`).run(NOW + 1)

  assert.deepEqual(db.prepare('SELECT revision FROM MissionRevision WHERE missionId = ? ORDER BY revision').all('A').map(row => row.revision), [1, 2])
  assert.equal(db.prepare('SELECT revision, objective FROM Mission WHERE id = ?').get('A').revision, 2)
  assert.throws(() => db.prepare('UPDATE Mission SET revision = 2 WHERE id = ?').run('A'), /revision must increase/)
  assert.throws(() => db.prepare('UPDATE Mission SET revision = 1 WHERE id = ?').run('A'), /revision must increase/)
  assert.throws(() => db.prepare("UPDATE MissionRevision SET objective = 'rewritten' WHERE missionId = 'A' AND revision = 1").run(), /immutable/)
})

test('Run (missionId, generation) and Outbox (deliverableId, channel) refuse duplicates', t => {
  const { database } = openHome(t)
  const db = database.db
  seedGraph(db, 'A', 'bot-1')

  const insertRun = generation => db.prepare(`INSERT INTO Run (id, missionId, missionRevision, status, inputRefs, generation, createdAt)
    VALUES (?, 'A', 1, 'queued', '[]', ?, ?)`).run(`A-run-${generation}`, generation, NOW)
  assert.throws(() => insertRun(1), /UNIQUE/)
  insertRun(2)
  assert.deepEqual(db.prepare('SELECT generation FROM Run WHERE missionId = ? ORDER BY generation').all('A').map(row => row.generation), [1, 2])

  const insertOutbox = (channel, status = 'pending') => db.prepare(`INSERT INTO Outbox (id, deliverableId, channel, status, attemptCount, createdAt, updatedAt)
    VALUES (?, 'A-del', ?, ?, 0, ?, ?)`).run(`A-out-${channel}-${status}`, channel, status, NOW, NOW)
  assert.throws(() => insertOutbox('bot'), /UNIQUE/)
  insertOutbox('telegram')
  assert.throws(() => insertOutbox('bot', 'bogus'), /CHECK/)
})

test('Observation dedupes exact repeats and admits a changed content fingerprint', t => {
  const { database } = openHome(t)
  const db = database.db
  seedGraph(db, 'A', 'bot-1')

  const insertObservation = (nativeId, contentHash) => db.prepare(`INSERT INTO Observation (id, sourceId, nativeId, contentHash, observedAt, createdAt)
    VALUES (?, 'A-src', ?, ?, ?, ?)`).run(`A-obs-${nativeId}-${contentHash}`, nativeId, contentHash, NOW, NOW)
  insertObservation('paper-1', 'hash-a')
  assert.throws(() => insertObservation('paper-1', 'hash-a'), /UNIQUE/)
  insertObservation('paper-1', 'hash-b')
  assert.deepEqual(
    db.prepare('SELECT contentHash FROM Observation WHERE sourceId = ? AND nativeId = ? ORDER BY contentHash').all('A-src', 'paper-1').map(row => row.contentHash),
    ['hash-a', 'hash-b'],
  )
})

test('deleting a Mission removes every derived row and its artifact files', t => {
  const { dshHome, database } = openHome(t)
  const { db } = database
  const escapeTarget = join(dshHome, 'outside.md')
  writeFileSync(escapeTarget, 'not part of artifacts/')
  seedGraph(db, 'A', 'bot-1', ['missions/A/body.md', '../../outside.md', 'https://example.com/paper'])
  seedGraph(db, 'B', 'bot-2', ['missions/B/body.md'])
  const aFile = writeArtifact(dshHome, 'missions/A/body.md', 'A body')
  const bFile = writeArtifact(dshHome, 'missions/B/body.md', 'B body')
  // 'A' has one reachable artifact; the escape ref and the URL are not files we own.
  const before = counts(db)
  for (const table of TABLES) assert.ok(before[table] >= 2, `${table} was not seeded`)

  const result = deleteMissionData(database, 'A')
  assert.deepEqual({ ...result }, { missions: 1, artifacts: 1 })
  assert.deepEqual(db.prepare('SELECT id FROM Mission').all().map(row => row.id), ['B'])
  for (const table of TABLES) assert.equal(counts(db)[table], 1, `${table} still holds rows of the deleted Mission`)
  assert.equal(db.prepare('SELECT missionId FROM MissionRevision').get().missionId, 'B')
  assert.equal(existsSync(aFile), false)
  assert.equal(existsSync(bFile), true)
  assert.equal(existsSync(escapeTarget), true)
})

test('deleting a Bot removes exactly that Bot\'s Missions', t => {
  const { dshHome, database } = openHome(t)
  const { db } = database
  seedGraph(db, 'A', 'bot-1', ['missions/A/body.md'])
  seedGraph(db, 'B', 'bot-1', ['missions/B/body.md'])
  seedGraph(db, 'C', 'bot-2', ['missions/C/body.md'])
  const files = ['missions/A/body.md', 'missions/B/body.md', 'missions/C/body.md'].map(ref => writeArtifact(dshHome, ref, ref))

  const result = deleteBotData(database, 'bot-1')
  assert.deepEqual({ ...result }, { missions: 2, artifacts: 2 })
  assert.deepEqual(db.prepare('SELECT id FROM Mission ORDER BY id').all().map(row => row.id), ['C'])
  for (const table of TABLES) assert.equal(counts(db)[table], 1, `${table} should hold only the surviving Mission`)
  assert.deepEqual(files.map(file => existsSync(file)), [false, false, true])
  assert.deepEqual({ ...deleteBotData(database, 'bot-1') }, { missions: 0, artifacts: 0 })
})
