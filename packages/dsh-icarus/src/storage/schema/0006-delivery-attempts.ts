import type { Migration } from '../migrations.js'

export const deliveryAttempts: Migration = {
  version: 6,
  name: 'delivery-attempts',
  sql: `
CREATE TABLE OutboxAttempt (
  id TEXT PRIMARY KEY,
  outboxId TEXT NOT NULL REFERENCES Outbox(id) ON DELETE CASCADE,
  attemptNumber INTEGER NOT NULL,
  requestId TEXT NOT NULL,
  sessionId TEXT,
  status TEXT NOT NULL CHECK(status IN ('sending','accepted','failed','unknown')),
  startedAt INTEGER NOT NULL,
  endedAt INTEGER,
  errorRef TEXT,
  receiptRef TEXT,
  UNIQUE(outboxId, attemptNumber)
);
`,
}
