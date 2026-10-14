import type { Migration } from '../migrations.js'

export const modelCalls: Migration = {
  version: 3,
  name: 'model-calls',
  sql: `
CREATE TABLE ModelCall (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES Run(id) ON DELETE CASCADE,
  sessionId TEXT NOT NULL,
  purpose TEXT NOT NULL,
  reservedTokens INTEGER NOT NULL CHECK(reservedTokens >= 0),
  chargedTokens INTEGER NOT NULL DEFAULT 0 CHECK(chargedTokens >= 0),
  usage TEXT,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'settled', 'unknown')),
  createdAt INTEGER NOT NULL,
  endedAt INTEGER
);
CREATE INDEX ModelCall_run ON ModelCall(runId);
`,
}
