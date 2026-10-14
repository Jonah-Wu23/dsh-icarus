// 0001 — core records (PRD §8.1), plus the constraints fixed by M2 plan §M2.1.
//
// Conventions
//   * ids are TEXT, minted by the domain layer (M2.2); storage never invents one.
//   * timestamps are INTEGER epoch milliseconds, UTC.
//   * contract fields shaped as lists/objects are TEXT holding JSON.
//   * Mission is the only deletion root: every other record reaches it through an
//     ON DELETE CASCADE chain, so one DELETE empties the whole subtree (feedback tables
//     included) without a hand-written order of statements.
//
// PRD field mapping worth naming explicitly: PRD §8.1 lists `lease` as one Run field.
// M2 plan §M2.1/§M2.3 name the two columns the lease is actually read by — `leaseOwner`
// and `leaseUntil` — so they are stored separately instead of duplicating the same state
// inside a JSON blob. `generation` accompanies them for the (missionId, generation) guard.
//
// Columns that PRD §8.1 does not list but implementation needs (marked "impl" below):
//   Mission.budgetUsed        settled token total (M2.4); Mission.budget is the hard cap
//   Mission.nextDueAt         due time Icarus owns and scans (M2.2/M2.3); PRD §8.3 forbids
//                             handing this to the host schedule service
//   Mission.createdAt/updatedAt, Source.createdAt, Run.createdAt/startedAt/endedAt,
//   Observation.createdAt, Outbox.createdAt/updatedAt
//                             lifecycle ordering and duration reporting
//   Deliverable.contentHash   the fingerprint M2.1 requires next to the summary in `content`
//
// Statuses are CHECKed to the sets PRD §8.2 and M2 plan §M2.1 enumerate. These are value
// domains, not the M2.2 state machine: which transition is legal stays in the domain layer.
import type { Migration } from '../migrations.js'

export const coreRecords: Migration = {
  version: 1,
  name: 'core-records',
  sql: `
CREATE TABLE Mission (
  id TEXT PRIMARY KEY,
  ownerBotId TEXT NOT NULL,
  kind TEXT NOT NULL,
  objective TEXT NOT NULL,
  requirements TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  budget INTEGER,                                  -- impl: token hard cap; NULL = no cap
  authorizationRef TEXT,
  budgetUsed INTEGER NOT NULL DEFAULT 0,           -- impl
  nextDueAt INTEGER,                               -- impl
  createdAt INTEGER NOT NULL,                      -- impl
  updatedAt INTEGER NOT NULL                       -- impl
);

CREATE INDEX Mission_due ON Mission (status, nextDueAt);
CREATE INDEX Mission_owner ON Mission (ownerBotId);

-- One immutable snapshot per Mission revision. Runtime state (status, budgetUsed,
-- nextDueAt) is deliberately not part of a revision's content.
CREATE TABLE MissionRevision (
  missionId TEXT NOT NULL REFERENCES Mission (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  kind TEXT NOT NULL,
  objective TEXT NOT NULL,
  requirements TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL,
  budget INTEGER,
  authorizationRef TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (missionId, revision)
);

-- The current revision may only move forward.
CREATE TRIGGER Mission_revision_forward
BEFORE UPDATE OF revision ON Mission
FOR EACH ROW WHEN NEW.revision <= OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'Mission.revision must increase');
END;

-- A written snapshot is history: revisions are added, never rewritten.
CREATE TRIGGER MissionRevision_immutable
BEFORE UPDATE ON MissionRevision
BEGIN
  SELECT RAISE(ABORT, 'MissionRevision rows are immutable');
END;

CREATE TABLE Source (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission (id) ON DELETE CASCADE,
  adapter TEXT NOT NULL,
  locator TEXT NOT NULL,
  cursor TEXT,
  lastCheckedAt INTEGER,
  lastSucceededAt INTEGER,
  health TEXT,
  createdAt INTEGER NOT NULL                      -- impl
);

CREATE INDEX Source_mission ON Source (missionId);

CREATE TABLE Run (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission (id) ON DELETE CASCADE,
  missionRevision INTEGER NOT NULL,
  preferenceRevision INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'superseded', 'budget_exhausted')),
  sessionId TEXT,
  leaseOwner TEXT,
  leaseUntil INTEGER,
  inputRefs TEXT NOT NULL DEFAULT '[]',
  usage TEXT,
  errorRef TEXT,
  generation INTEGER NOT NULL,                    -- impl: one attempt per (missionId, generation)
  createdAt INTEGER NOT NULL,                     -- impl
  startedAt INTEGER,                              -- impl
  endedAt INTEGER,                                -- impl
  UNIQUE (missionId, generation)
);

CREATE INDEX Run_mission ON Run (missionId, status);
CREATE INDEX Run_lease ON Run (status, leaseUntil);

CREATE TABLE Observation (
  id TEXT PRIMARY KEY,
  sourceId TEXT NOT NULL REFERENCES Source (id) ON DELETE CASCADE,
  nativeId TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  publishedAt INTEGER,
  observedAt INTEGER NOT NULL,
  evidenceRef TEXT,
  createdAt INTEGER NOT NULL,                     -- impl
  -- Dedupe per PRD §8.2: one observation per (source, native id, content fingerprint).
  -- An exact repeat is rejected; the same native id with a changed fingerprint is a new
  -- content version and arrives as its own row.
  UNIQUE (sourceId, nativeId, contentHash)
);

CREATE INDEX Observation_source ON Observation (sourceId, observedAt);

CREATE TABLE Deliverable (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES Run (id) ON DELETE CASCADE,
  requirementResults TEXT NOT NULL DEFAULT '[]',
  evidenceRefs TEXT NOT NULL DEFAULT '[]',
  artifactRefs TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  contentHash TEXT NOT NULL,                      -- impl
  createdAt INTEGER NOT NULL
);

CREATE INDEX Deliverable_run ON Deliverable (runId);

CREATE TABLE Feedback (
  id TEXT PRIMARY KEY,
  deliverableId TEXT NOT NULL REFERENCES Deliverable (id) ON DELETE CASCADE,
  itemId TEXT,
  action TEXT NOT NULL,
  comment TEXT,
  createdAt INTEGER NOT NULL,
  supersedes TEXT REFERENCES Feedback (id) ON DELETE SET NULL
);

CREATE INDEX Feedback_deliverable ON Feedback (deliverableId);

CREATE TABLE PreferenceRevision (
  missionId TEXT NOT NULL REFERENCES Mission (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  explicitRequirements TEXT NOT NULL DEFAULT '[]',
  inferredPreferences TEXT NOT NULL DEFAULT '[]',
  feedbackRefs TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (missionId, revision)
);

CREATE TABLE Outbox (
  id TEXT PRIMARY KEY,
  deliverableId TEXT NOT NULL REFERENCES Deliverable (id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  destinationRef TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'delivery_unknown', 'failed')),
  attemptCount INTEGER NOT NULL DEFAULT 0,
  receiptRef TEXT,
  nextAttemptAt INTEGER,
  createdAt INTEGER NOT NULL,                     -- impl
  updatedAt INTEGER NOT NULL,                     -- impl
  UNIQUE (deliverableId, channel)
);

CREATE INDEX Outbox_pending ON Outbox (status, nextAttemptAt);
`,
}
