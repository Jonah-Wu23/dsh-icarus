import type { Migration } from '../migrations.js'

export const faultNotifications: Migration = {
  version: 7,
  name: 'fault-notifications',
  sql: `
ALTER TABLE Outbox ADD COLUMN purpose TEXT NOT NULL DEFAULT 'deliverable' CHECK(purpose IN ('deliverable','fault'));
ALTER TABLE DeliveryWindow ADD COLUMN sealedAt INTEGER;
CREATE TABLE Fault (
  id TEXT PRIMARY KEY,
  missionId TEXT NOT NULL REFERENCES Mission(id) ON DELETE CASCADE,
  missionRevision INTEGER NOT NULL,
  conditionKey TEXT NOT NULL,
  kind TEXT NOT NULL,
  sourceId TEXT REFERENCES Source(id) ON DELETE CASCADE,
  runId TEXT NOT NULL REFERENCES Run(id) ON DELETE CASCADE,
  detailsRef TEXT NOT NULL,
  deliverableId TEXT NOT NULL REFERENCES Deliverable(id) ON DELETE CASCADE,
  createdAt INTEGER NOT NULL,
  clearedAt INTEGER
);
CREATE UNIQUE INDEX Fault_active ON Fault(missionId, missionRevision, conditionKey) WHERE clearedAt IS NULL;
`,
}
