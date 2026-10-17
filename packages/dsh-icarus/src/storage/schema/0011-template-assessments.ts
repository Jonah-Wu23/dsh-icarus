import type { Migration } from '../migrations.js'

// 0011 — template assessments (M4.2). One JSON column for the merge relations the application
// template needs: null, or { duplicateOf?: observationId, sameSubjectAs?: observationId, reason }.
// A repost merged into one item keeps every source record in the item fields; this column only
// records which earlier observation an assessment was judged to duplicate or share a subject with.
export const templateAssessments: Migration = {
  version: 11,
  name: 'template-assessments',
  sql: `ALTER TABLE ObservationAssessment ADD COLUMN relation TEXT NOT NULL DEFAULT 'null'`,
}
