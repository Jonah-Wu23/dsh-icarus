import type { Migration } from '../migrations.js'

export const webSearch: Migration = {
  version: 9,
  name: 'web-search',
  sql: `
CREATE TABLE SearchProviderState (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('healthy','cooling','rate_limited','quota_exhausted','auth_failed','unconfigured')),
  until INTEGER,
  lastErrorRef TEXT,
  lastSucceededAt INTEGER,
  updatedAt INTEGER NOT NULL,
  selectionCredit REAL NOT NULL DEFAULT 0
);
CREATE TABLE SearchCall (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('search','fetch','test')),
  missionId TEXT REFERENCES Mission(id) ON DELETE CASCADE,
  runId TEXT REFERENCES Run(id) ON DELETE CASCADE,
  sessionId TEXT,
  purpose TEXT NOT NULL,
  query TEXT,
  url TEXT,
  status TEXT NOT NULL,
  httpStatus INTEGER,
  units REAL NOT NULL DEFAULT 0,
  costDollars REAL,
  reservedUnits REAL NOT NULL,
  reservedDollars REAL NOT NULL,
  resultCount INTEGER,
  responseRef TEXT,
  startedAt INTEGER NOT NULL,
  endedAt INTEGER
);
CREATE INDEX SearchCall_provider_month ON SearchCall(provider, startedAt);
CREATE INDEX SearchCall_mission_month ON SearchCall(missionId, startedAt);
CREATE INDEX SearchCall_run ON SearchCall(runId);
`,
}
