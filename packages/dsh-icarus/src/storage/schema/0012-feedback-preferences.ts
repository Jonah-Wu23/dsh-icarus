import type { Migration } from '../migrations.js'

// 0012 — feedback and preference versions (M4.3/M4.4).
//
// Feedback gains its channel identity and processing state; PreferenceEntry holds the versioned
// preference statements themselves. A revision is the set of entries where introducedIn <= r and
// (retiredIn IS NULL OR retiredIn > r), so retiring an entry never rewrites history. Run gains the
// purpose that decides how the executor handles it and the structured input refs a preference
// consolidation Run reads.
export const feedbackPreferences: Migration = {
  version: 12,
  name: 'feedback-preferences',
  sql: `
CREATE TABLE ReadEvent (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  itemId TEXT NOT NULL REFERENCES DeliverableItem(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  channelEventRef TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX ReadEvent_item ON ReadEvent(itemId);
CREATE UNIQUE INDEX ReadEvent_channel_event ON ReadEvent(channel, channelEventRef) WHERE channelEventRef IS NOT NULL;

ALTER TABLE Feedback ADD COLUMN source TEXT NOT NULL DEFAULT 'bot' CHECK(source IN ('bot','qq','ui'));
ALTER TABLE Feedback ADD COLUMN channelEventRef TEXT;
ALTER TABLE Feedback ADD COLUMN sessionId TEXT;
ALTER TABLE Feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','applied','superseded','withdrawn'));
ALTER TABLE Feedback ADD COLUMN preferenceRevision INTEGER;
CREATE UNIQUE INDEX Feedback_channel_event ON Feedback(source, channelEventRef) WHERE channelEventRef IS NOT NULL;
CREATE INDEX Feedback_item ON Feedback(itemId);
CREATE INDEX Feedback_status ON Feedback(status);

ALTER TABLE PreferenceRevision ADD COLUMN basedOn INTEGER;
ALTER TABLE PreferenceRevision ADD COLUMN changeRef TEXT;
ALTER TABLE PreferenceRevision ADD COLUMN publishedAt INTEGER NOT NULL DEFAULT 0;

CREATE TABLE PreferenceEntry (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  introducedIn INTEGER NOT NULL,
  retiredIn INTEGER,
  origin TEXT NOT NULL CHECK(origin IN ('explicit','inferred')),
  statement TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{}',
  quote TEXT,
  feedbackIds TEXT NOT NULL DEFAULT '[]',
  explanation TEXT,
  expiresAt INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE INDEX PreferenceEntry_mission ON PreferenceEntry(missionId, introducedIn, retiredIn);

ALTER TABLE ObservationAssessment ADD COLUMN preferenceRefs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE Run ADD COLUMN purpose TEXT NOT NULL DEFAULT 'execution' CHECK(purpose IN ('execution','preference','investigation'));
ALTER TABLE Run ADD COLUMN purposeRefs TEXT NOT NULL DEFAULT '[]';
`,
}
