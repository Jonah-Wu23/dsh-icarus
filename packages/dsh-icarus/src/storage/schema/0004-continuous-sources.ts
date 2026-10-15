import type { Migration } from '../migrations.js'

export const continuousSources: Migration = {
  version: 4,
  name: 'continuous-sources',
  sql: `
ALTER TABLE Mission ADD COLUMN bindings TEXT NOT NULL DEFAULT '{}';
ALTER TABLE MissionRevision ADD COLUMN bindings TEXT NOT NULL DEFAULT '{}';
ALTER TABLE Source ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
ALTER TABLE Source ADD COLUMN nextPollAt INTEGER;
ALTER TABLE Run ADD COLUMN deliveryWindowId TEXT REFERENCES DeliveryWindow(id);
ALTER TABLE Run ADD COLUMN contextRef TEXT;
ALTER TABLE Run ADD COLUMN capabilityRef TEXT;
CREATE TABLE DeliveryWindow (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  missionRevision INTEGER NOT NULL,
  windowKey TEXT NOT NULL,
  prepareAt INTEGER NOT NULL,
  dueAt INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','prepared','suppressed','failed','superseded')),
  inputRefs TEXT NOT NULL DEFAULT '[]',
  deliverableId TEXT REFERENCES Deliverable(id) ON DELETE SET NULL,
  outcomeRef TEXT,
  createdAt INTEGER NOT NULL,
  UNIQUE(missionId, missionRevision, windowKey)
);
CREATE INDEX DeliveryWindow_due ON DeliveryWindow(status, prepareAt, dueAt);
CREATE TABLE ObservationAssessment (
  id TEXT PRIMARY KEY,
  observationId TEXT NOT NULL REFERENCES Observation(id) ON DELETE CASCADE,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  missionRevision INTEGER NOT NULL,
  preferenceRevision INTEGER NOT NULL DEFAULT 0,
  runId TEXT NOT NULL REFERENCES Run(id) ON DELETE CASCADE,
  selected INTEGER NOT NULL CHECK(selected IN (0,1)),
  reason TEXT NOT NULL,
  readingRefs TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  UNIQUE(observationId, missionId, missionRevision, preferenceRevision)
);
CREATE TABLE CapabilityCheck (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  missionRevision INTEGER NOT NULL,
  provider TEXT NOT NULL,
  tool TEXT NOT NULL,
  workspaceRef TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('available','missing','needs_auth','unavailable','unknown')),
  evidenceRef TEXT,
  checkedAt INTEGER NOT NULL
);
CREATE TABLE SourceAttempt (
  id TEXT PRIMARY KEY,
  sourceId TEXT NOT NULL REFERENCES Source(id) ON DELETE CASCADE,
  startedAt INTEGER NOT NULL,
  endedAt INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  httpStatus INTEGER,
  errorRef TEXT,
  added INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX Source_poll ON Source(nextPollAt);
`,
}
