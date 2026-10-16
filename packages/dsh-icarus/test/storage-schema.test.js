// Storage foundation: data locations, connection pragmas, migration idempotency, and the
// eight PRD §8.1 tables' fields. Runs against the built plugin: `pnpm build` first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIGRATIONS,
  artifactsDirOf,
  dataDirOf,
  databasePathOf,
  icarusPaths,
  openDatabase,
  workspaceDirOf,
} from '../lib/storage/index.js'

// PRD §8.1 fields, table by table. `lease` is the one PRD field carried by two columns:
// M2 plan §M2.1/§M2.3 name the pair the lease is read by (leaseOwner, leaseUntil).
const PRD_FIELDS = {
  Mission: ['id', 'ownerBotId', 'kind', 'objective', 'requirements', 'revision', 'status', 'schedule', 'timezone', 'budget', 'authorizationRef'],
  Source: ['id', 'missionId', 'adapter', 'locator', 'cursor', 'lastCheckedAt', 'lastSucceededAt', 'health'],
  Run: ['id', 'missionId', 'missionRevision', 'preferenceRevision', 'status', 'sessionId', 'lease', 'inputRefs', 'usage', 'errorRef'],
  Observation: ['id', 'sourceId', 'nativeId', 'contentHash', 'publishedAt', 'observedAt', 'evidenceRef'],
  Deliverable: ['id', 'runId', 'requirementResults', 'evidenceRefs', 'artifactRefs', 'content', 'createdAt'],
  Feedback: ['id', 'deliverableId', 'itemId', 'action', 'comment', 'createdAt', 'supersedes'],
  PreferenceRevision: ['missionId', 'revision', 'explicitRequirements', 'inferredPreferences', 'feedbackRefs', 'createdAt'],
  Outbox: ['id', 'deliverableId', 'channel', 'destinationRef', 'status', 'attemptCount', 'receiptRef', 'nextAttemptAt'],
}

function tempHome(t) {
  const dshHome = mkdtempSync(join(tmpdir(), 'icarus-storage-'))
  return { dshHome, drop: () => rmSync(dshHome, { recursive: true, force: true }) }
}

// One hook so the connection is always closed before the directory disappears.
function openHome(t) {
  const { dshHome, drop } = tempHome(t)
  const database = openDatabase({ dshHome })
  t.after(() => {
    database.close()
    drop()
  })
  return { dshHome, database }
}

function schemaDump(db) {
  return db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name, sql")
    .all()
    .map(row => `${row.type}|${row.name}|${row.sql}`)
    .join('\n')
}

function migrationsOf(db) {
  return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version)
}

function columnsOf(db, table) {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(row => row.name)
}

test('data locations resolve under $DSH_HOME/icarus', () => {
  const home = join(tmpdir(), 'icarus-paths-fake')
  assert.equal(dataDirOf({ dshHome: home }), join(home, 'icarus'))
  assert.equal(databasePathOf({ dshHome: home }), join(home, 'icarus', 'icarus.sqlite'))
  assert.equal(artifactsDirOf({ dshHome: home }), join(home, 'icarus', 'artifacts'))
  assert.equal(workspaceDirOf({ dshHome: home }), join(home, 'icarus', 'workspace'))
  assert.deepEqual({ ...icarusPaths({ dshHome: home }) }, {
    dshHome: home,
    dataDir: join(home, 'icarus'),
    databasePath: join(home, 'icarus', 'icarus.sqlite'),
    artifactsDir: join(home, 'icarus', 'artifacts'),
    workspaceDir: join(home, 'icarus', 'workspace'),
  })
  assert.equal(dataDirOf({ env: { DSH_HOME: 'E:\\fake-dsh' } }), join('E:\\fake-dsh', 'icarus'))
  assert.match(dataDirOf({ env: {} }), /\.dsh[\\/]icarus$/)
})

test('opening creates the data spaces and sets WAL, busy_timeout and foreign keys', t => {
  const { database } = openHome(t)

  assert.equal(database.schemaVersion, MIGRATIONS.length)
  assert.equal(database.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(database.db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
  assert.equal(database.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  // foreign_keys is what makes the cascade deletion real, so prove it is enforced.
  assert.throws(
    () => database.db.prepare('INSERT INTO Source (id, missionId, adapter, locator, createdAt) VALUES (?, ?, ?, ?, ?)').run('s', 'missing', 'rss', 'x', 1),
    /FOREIGN KEY/,
  )
})

test('reopening the same file applies nothing and leaves the schema identical', t => {
  const { dshHome, drop } = tempHome(t)
  const first = openDatabase({ dshHome })
  const firstDump = schemaDump(first.db)
  const firstMigrations = migrationsOf(first.db)
  first.close()

  const second = openDatabase({ dshHome })
  t.after(() => {
    second.close()
    drop()
  })
  assert.equal(schemaDump(second.db), firstDump)
  assert.deepEqual(firstMigrations, MIGRATIONS.map(migration => migration.version))
  assert.deepEqual(migrationsOf(second.db), MIGRATIONS.map(migration => migration.version))
  assert.equal(second.schemaVersion, MIGRATIONS.length)
})

test('upgrading a 0001 database adds the approval chain without touching existing Runs', t => {
  const { dshHome, drop } = tempHome(t)
  // A database written by the M2.4 build: 0001 only, plus one Run that predates approvals.
  const legacy = openDatabase({ dshHome, migrations: [MIGRATIONS[0]] })
  legacy.db.prepare(`INSERT INTO Mission (id, ownerBotId, kind, objective, requirements, revision, status, schedule, timezone, budget, authorizationRef, budgetUsed, nextDueAt, createdAt, updatedAt)
    VALUES ('mission_legacy', 'session-bot-1', 'recurring', 'legacy', '[]', 1, 'active', '{"kind":"daily","time":"21:00"}', 'Asia/Singapore', 1000, NULL, 0, NULL, 1, 1)`).run()
  legacy.db.prepare(`INSERT INTO Run (id, missionId, missionRevision, preferenceRevision, status, sessionId, leaseOwner, leaseUntil, inputRefs, usage, errorRef, generation, createdAt, startedAt, endedAt)
    VALUES ('run_legacy', 'mission_legacy', 1, NULL, 'succeeded', NULL, NULL, NULL, '[]', NULL, NULL, 1, 1, 1, 2)`).run()
  assert.equal(legacy.schemaVersion, 1)
  legacy.close()

  const upgraded = openDatabase({ dshHome })
  t.after(() => {
    upgraded.close()
    drop()
  })
  assert.equal(upgraded.schemaVersion, MIGRATIONS.length)
  assert.deepEqual(migrationsOf(upgraded.db), MIGRATIONS.map(migration => migration.version))
  assert.deepEqual(columnsOf(upgraded.db, 'Run').filter(name => name.startsWith('approval')), ['approvalRefs'])
  // The default is what keeps a pre-approval Run readable as an empty chain, not a null.
  const row = upgraded.db.prepare('SELECT approvalRefs, status FROM Run WHERE id = ?').get('run_legacy')
  assert.equal(row.approvalRefs, '[]')
  assert.equal(row.status, 'succeeded')
})

test('the eight PRD §8.1 tables carry every PRD field', t => {
  const { database } = openHome(t)

  assert.equal(Object.keys(PRD_FIELDS).length, 8)
  for (const [table, fields] of Object.entries(PRD_FIELDS)) {
    const columns = columnsOf(database.db, table)
    assert.ok(columns.length > 0, `table ${table} is missing`)
    for (const field of fields) {
      const expected = field === 'lease' ? ['leaseOwner', 'leaseUntil'] : [field]
      for (const column of expected) assert.ok(columns.includes(column), `${table}.${column} is missing (PRD field ${field})`)
    }
  }
  assert.deepEqual(columnsOf(database.db, 'Run').filter(name => name.startsWith('lease')).sort(), ['leaseOwner', 'leaseUntil'])
})
