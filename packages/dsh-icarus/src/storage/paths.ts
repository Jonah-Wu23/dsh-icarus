// Icarus data locations under the DSH home (M2 plan §0.2): one SQLite file plus two
// directories. Nothing here creates anything; `openDatabase` does.
import { join } from 'node:path'
import { dshHomeOf } from '../dsh-home.js'
import type { DshHomeOptions } from '../dsh-home.js'

/** Directory Icarus owns under the DSH home. */
export const ICARUS_DIR = 'icarus'
export const DATABASE_FILE = 'icarus.sqlite'
/** Raw material, deliverable bodies and error records, referenced by DB paths. */
export const ARTIFACTS_DIR = 'artifacts'
/** Working directory of execution Sessions (M2.3). */
export const WORKSPACE_DIR = 'workspace'

export type DataDirOptions = DshHomeOptions

export interface IcarusPaths {
  readonly dshHome: string
  readonly dataDir: string
  readonly databasePath: string
  readonly artifactsDir: string
  readonly workspaceDir: string
}

/** `$DSH_HOME/icarus`, or `~/.dsh/icarus` without `$DSH_HOME`. */
export function dataDirOf(options: DataDirOptions = {}): string {
  return join(dshHomeOf(options), ICARUS_DIR)
}

/** The single Icarus database file. */
export function databasePathOf(options: DataDirOptions = {}): string {
  return join(dataDirOf(options), DATABASE_FILE)
}

/** Root of stored raw material, deliverable bodies and error records. */
export function artifactsDirOf(options: DataDirOptions = {}): string {
  return join(dataDirOf(options), ARTIFACTS_DIR)
}

/** Working directory handed to execution Sessions. */
export function workspaceDirOf(options: DataDirOptions = {}): string {
  return join(dataDirOf(options), WORKSPACE_DIR)
}

/** Every data location in one record. */
export function icarusPaths(options: DataDirOptions = {}): IcarusPaths {
  const dshHome = dshHomeOf(options)
  const dataDir = join(dshHome, ICARUS_DIR)
  return {
    dshHome,
    dataDir,
    databasePath: join(dataDir, DATABASE_FILE),
    artifactsDir: join(dataDir, ARTIFACTS_DIR),
    workspaceDir: join(dataDir, WORKSPACE_DIR),
  }
}
