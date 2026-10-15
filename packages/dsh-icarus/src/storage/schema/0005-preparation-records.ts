import type { Migration } from '../migrations.js'

export const preparationRecords: Migration = {
  version: 5,
  name: 'preparation-records',
  sql: `
ALTER TABLE SourceAttempt ADD COLUMN responseRef TEXT;
ALTER TABLE Run ADD COLUMN phase TEXT;
ALTER TABLE DeliveryWindow ADD COLUMN preferenceRevision INTEGER;
CREATE TABLE RunStep (
  runId TEXT NOT NULL REFERENCES Run(id) ON DELETE CASCADE,
  stepKey TEXT NOT NULL,
  requestId TEXT NOT NULL UNIQUE,
  promptRef TEXT NOT NULL,
  responseRef TEXT,
  createdAt INTEGER NOT NULL,
  completedAt INTEGER,
  PRIMARY KEY(runId, stepKey)
);
CREATE TABLE Reading (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES Run(id) ON DELETE CASCADE,
  observationId TEXT REFERENCES Observation(id) ON DELETE CASCADE,
  evidenceRef TEXT NOT NULL,
  scope TEXT NOT NULL,
  startOffset INTEGER NOT NULL,
  endOffset INTEGER NOT NULL,
  totalLength INTEGER NOT NULL,
  truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
  continuation TEXT,
  createdAt INTEGER NOT NULL
);
CREATE TABLE ToolReading (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  runId TEXT REFERENCES Run(id) ON DELETE CASCADE,
  sessionId TEXT NOT NULL,
  callId TEXT NOT NULL,
  tool TEXT NOT NULL,
  evidenceRef TEXT NOT NULL,
  isError INTEGER NOT NULL CHECK(isError IN (0,1)),
  createdAt INTEGER NOT NULL,
  UNIQUE(sessionId, callId)
);
CREATE TABLE CapabilityRecommendation (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  missionRevision INTEGER NOT NULL,
  evidenceRef TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
`,
}
