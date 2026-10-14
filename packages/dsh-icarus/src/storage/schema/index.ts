// Ordered migration list. Append new migrations; never edit an applied one.
import type { Migration } from '../migrations.js'
import { coreRecords } from './0001-core-records.js'

export const MIGRATIONS: readonly Migration[] = [coreRecords]
