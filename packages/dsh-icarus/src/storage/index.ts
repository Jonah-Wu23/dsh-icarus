// Storage surface of the Icarus plugin (M2.1). M2.2 wires it into the plugin and builds
// the Mission service on top; nothing else in the plugin imports these modules yet.
export { openDatabase, DEFAULT_BUSY_TIMEOUT_MS } from './database.js'
export type { IcarusDatabase, OpenDatabaseOptions } from './database.js'
export {
  ARTIFACTS_DIR,
  DATABASE_FILE,
  ICARUS_DIR,
  WORKSPACE_DIR,
  artifactsDirOf,
  dataDirOf,
  databasePathOf,
  icarusPaths,
  workspaceDirOf,
} from './paths.js'
export type { DataDirOptions, IcarusPaths } from './paths.js'
export { currentSchemaVersion, runMigrations } from './migrations.js'
export type { Migration, MigrationState } from './migrations.js'
export { MIGRATIONS } from './schema/index.js'
export { deleteBotData, deleteMissionData, exportMissionData } from './data.js'
export type { DeleteResult } from './data.js'
