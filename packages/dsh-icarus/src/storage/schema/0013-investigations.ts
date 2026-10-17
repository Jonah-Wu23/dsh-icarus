import type { Migration } from '../migrations.js'

// 0013 — investigations (M4.5/M4.6). Checkpoints are the resumable progress of one investigation
// Run; RunCommand is the host-visible record of every shell command actually executed. Deliverable
// items gain their source rule: curation items still need selected assessments, while investigation
// items carry the origin item snapshot and the checkpoint that produced them.
export const investigations: Migration = {
  version: 13,
  name: 'investigations',
  sql: `
ALTER TABLE DeliverableItem ADD COLUMN sourceType TEXT NOT NULL DEFAULT 'curation' CHECK(sourceType IN ('curation','investigation'));
ALTER TABLE DeliverableItem ADD COLUMN originItemId TEXT;
ALTER TABLE DeliverableItem ADD COLUMN originSnapshotRef TEXT;
ALTER TABLE DeliverableItem ADD COLUMN checkpointId TEXT;
ALTER TABLE Run ADD COLUMN resumedFromRunId TEXT REFERENCES Run(id);
CREATE TABLE InvestigationCheckpoint (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES Run(id) ON DELETE CASCADE,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK(seq >= 1),
  phase TEXT NOT NULL,
  summaryRef TEXT NOT NULL,
  traceRef TEXT NOT NULL,
  artifactRefs TEXT NOT NULL DEFAULT '[]',
  done INTEGER NOT NULL CHECK(done IN (0,1)),
  createdAt INTEGER NOT NULL,
  UNIQUE(runId, seq)
);
CREATE INDEX InvestigationCheckpoint_mission ON InvestigationCheckpoint(missionId, createdAt);
CREATE TABLE RunCommand (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES Run(id) ON DELETE CASCADE,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  sessionId TEXT NOT NULL,
  callId TEXT NOT NULL,
  tool TEXT NOT NULL,
  cwd TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','unknown','rejected')),
  exitCode INTEGER,
  stdoutRef TEXT,
  stderrRef TEXT,
  worktreeRef TEXT,
  startedAt INTEGER NOT NULL,
  endedAt INTEGER,
  UNIQUE(sessionId, callId)
);
CREATE INDEX RunCommand_run ON RunCommand(runId, startedAt);
`,
}
