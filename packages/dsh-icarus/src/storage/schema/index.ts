// Ordered migration list. Append new migrations; never edit an applied one.
import type { Migration } from '../migrations.js'
import { coreRecords } from './0001-core-records.js'
import { runApprovals } from './0002-run-approvals.js'
import { modelCalls } from './0003-model-calls.js'
import { continuousSources } from './0004-continuous-sources.js'
import { preparationRecords } from './0005-preparation-records.js'
import { deliveryAttempts } from './0006-delivery-attempts.js'
import { faultNotifications } from './0007-fault-notifications.js'
import { sourceRequestBudgets } from './0008-source-request-budgets.js'
import { webSearch } from './0009-web-search.js'
import { deliverableItems } from './0010-deliverable-items.js'
import { templateAssessments } from './0011-template-assessments.js'
import { feedbackPreferences } from './0012-feedback-preferences.js'
import { investigations } from './0013-investigations.js'
import { explorationAllocations } from './0014-exploration-allocations.js'

export const MIGRATIONS: readonly Migration[] = [
  coreRecords, runApprovals, modelCalls, continuousSources, preparationRecords, deliveryAttempts, faultNotifications, sourceRequestBudgets, webSearch, deliverableItems,
  templateAssessments, feedbackPreferences, investigations, explorationAllocations,
]
