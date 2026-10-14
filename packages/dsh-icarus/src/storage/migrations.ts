// Numbered SQLite migrations.
//
// The framework owns `schema_migrations(version INTEGER PRIMARY KEY, appliedAt INTEGER)`
// and applies every migration exactly once, in version order, each inside its own
// transaction: a failing migration rolls back completely and leaves the recorded version
// untouched. Migration SQL is data, never a file the build has to copy.
import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  /** 1-based, contiguous across the list. */
  readonly version: number
  /** Short label, used in error messages and logs. */
  readonly name: string
  /** One or more statements, run in a single transaction. */
  readonly sql: string
}

export interface MigrationState {
  /** Versions applied by this call, in order. */
  readonly applied: readonly number[]
  /** Schema version after this call: the highest applied version, 0 for an empty schema. */
  readonly version: number
}

const CREATE_MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  appliedAt INTEGER NOT NULL
)`

/** Highest recorded migration version; 0 when the schema is empty. */
export function currentSchemaVersion(db: DatabaseSync): number {
  db.exec(CREATE_MIGRATION_TABLE)
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get<{ version: number | null }>()
  return row?.version ?? 0
}

/**
 * Apply every migration the database has not recorded yet.
 *
 * Idempotent: opening the same file again applies nothing and leaves the schema alone.
 * A version recorded in the database but absent from `migrations` fails loudly — an older
 * build must not silently keep running against a newer schema.
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[]): MigrationState {
  const ordered = [...migrations].sort((left, right) => left.version - right.version)
  ordered.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`icarus: migrations must be numbered 1..N without gaps; found ${migration.version} at position ${index + 1}`)
  })
  db.exec(CREATE_MIGRATION_TABLE)
  const recorded = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all<{ version: number }>()
  const known = new Set(ordered.map(migration => migration.version))
  for (const { version } of recorded) {
    if (!known.has(version)) throw new Error(`icarus: database records migration ${version} that this build does not have; update the plugin before opening it`)
  }
  const done = new Set(recorded.map(row => row.version))
  const applied: number[] = []
  for (const migration of ordered) {
    if (done.has(migration.version)) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(migration.version, Date.now())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`icarus: migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    applied.push(migration.version)
  }
  return { applied, version: applied.at(-1) ?? currentSchemaVersion(db) }
}
