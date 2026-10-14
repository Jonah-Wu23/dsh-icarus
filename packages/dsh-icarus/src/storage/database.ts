// The Icarus database handle: one file under the data directory, opened with the
// pragmas the M2 plan fixes, migrated to the current schema on open.
//
// Single writer: WAL plus a busy timeout make concurrent readers safe, but Icarus assumes
// one writer process (the host plugin), the same assumption DS Bot makes for state.json.
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from './migrations.js'
import { MIGRATIONS } from './schema/index.js'
import { icarusPaths } from './paths.js'
import type { Migration } from './migrations.js'
import type { DataDirOptions, IcarusPaths } from './paths.js'

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000

export interface OpenDatabaseOptions extends DataDirOptions {
  /** SQLite busy timeout for this connection; defaults to 5000 ms. */
  readonly busyTimeoutMs?: number | undefined
  /** Migration list; defaults to the shipped one, overridable in tests. */
  readonly migrations?: readonly Migration[] | undefined
}

export interface IcarusDatabase {
  readonly db: DatabaseSync
  readonly paths: IcarusPaths
  /** Highest applied migration version. */
  readonly schemaVersion: number
  close(): void
}

/**
 * Open (creating when absent) the Icarus database and bring it to the current schema.
 * Creates the data directory, `artifacts/` and `workspace/` on the way.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): IcarusDatabase {
  const timeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('icarus: busyTimeoutMs must be a positive integer')
  const paths = icarusPaths(options)
  mkdirSync(paths.dataDir, { recursive: true })
  mkdirSync(paths.artifactsDir, { recursive: true })
  mkdirSync(paths.workspaceDir, { recursive: true })
  const db = new DatabaseSync(paths.databasePath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(`PRAGMA busy_timeout = ${timeoutMs}`)
    db.exec('PRAGMA foreign_keys = ON')
    const state = runMigrations(db, options.migrations ?? MIGRATIONS)
    return { db, paths, schemaVersion: state.version, close: () => db.close() }
  } catch (error) {
    db.close()
    throw error
  }
}
