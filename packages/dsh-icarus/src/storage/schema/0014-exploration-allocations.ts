import type { Migration } from '../migrations.js'

// 0014 — exploration allocations (M4.7). A proposal is tied to the observation (and after delivery
// to the item) it came from; one allocation records the weekly quota reservation and the child
// investigation Mission it launched, so replaying the same proposal cannot start a second one.
export const explorationAllocations: Migration = {
  version: 14,
  name: 'exploration-allocations',
  sql: `
CREATE TABLE ExplorationProposal (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  missionRevision INTEGER NOT NULL,
  observationId TEXT,
  itemId TEXT,
  deliverableId TEXT,
  question TEXT NOT NULL,
  value TEXT NOT NULL,
  relation TEXT NOT NULL,
  deliverableSpec TEXT NOT NULL,
  inScope INTEGER NOT NULL CHECK(inScope IN (0,1)),
  scopeReason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','launched','deferred','rejected')),
  decidedReason TEXT,
  allocationId TEXT,
  investigationMissionId TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX ExplorationProposal_mission ON ExplorationProposal(missionId, createdAt);
CREATE TABLE ExplorationAllocation (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  proposalId TEXT NOT NULL UNIQUE REFERENCES ExplorationProposal(id) ON DELETE CASCADE,
  parentRevision INTEGER NOT NULL,
  weekStart INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  allocatedTokens INTEGER NOT NULL CHECK(allocatedTokens >= 0),
  usedTokens INTEGER NOT NULL DEFAULT 0 CHECK(usedTokens >= 0),
  status TEXT NOT NULL CHECK(status IN ('reserved','settled','released','unknown')),
  childMissionId TEXT NOT NULL,
  childRunId TEXT,
  createdAt INTEGER NOT NULL,
  settledAt INTEGER
);
CREATE INDEX ExplorationAllocation_week ON ExplorationAllocation(missionId, weekStart);
CREATE INDEX ExplorationAllocation_child ON ExplorationAllocation(childMissionId);
`,
}
