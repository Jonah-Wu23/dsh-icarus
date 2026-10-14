// 0002 — Run.approvalRefs (M2.5).
//
// The approval chain of one Run: what the host asked its execution Session to approve, and how
// each request settled. One JSON array ordered by arrival, each entry:
// `{ requestId, toolName, callId?, reason?, outcome, askedAt, decidedAt }`, `outcome` null while
// the request is still open (which is exactly when the Run is `awaiting_approval`).
//
// A new column with a NOT NULL DEFAULT, so upgrading an existing database leaves every Run with
// an empty chain instead of a null the readers would have to treat as a second kind of empty.
import type { Migration } from '../migrations.js'

export const runApprovals: Migration = {
  version: 2,
  name: 'run-approvals',
  sql: `ALTER TABLE Run ADD COLUMN approvalRefs TEXT NOT NULL DEFAULT '[]'`,
}
