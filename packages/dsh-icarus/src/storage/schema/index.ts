// Ordered migration list. Append new migrations; never edit an applied one.
import type { Migration } from '../migrations.js'
import { coreRecords } from './0001-core-records.js'
import { runApprovals } from './0002-run-approvals.js'
import { modelCalls } from './0003-model-calls.js'

export const MIGRATIONS: readonly Migration[] = [coreRecords, runApprovals, modelCalls]
