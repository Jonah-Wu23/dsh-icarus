import type { Migration } from '../migrations.js'

export const deliverableItems: Migration = {
  version: 10,
  name: 'deliverable-items',
  sql: `
CREATE TABLE DeliverableItem (
  id TEXT PRIMARY KEY,
  deliverableId TEXT NOT NULL REFERENCES Deliverable(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 1),
  observationIds TEXT NOT NULL,
  assessmentIds TEXT NOT NULL,
  evidenceRefs TEXT NOT NULL,
  fields TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  preferenceRefs TEXT NOT NULL DEFAULT '[]',
  UNIQUE(deliverableId, ordinal)
);
CREATE TRIGGER DeliverableItem_immutable
BEFORE UPDATE ON DeliverableItem
BEGIN
  SELECT RAISE(ABORT, 'DeliverableItem rows are immutable');
END;
CREATE TRIGGER Deliverable_immutable
BEFORE UPDATE ON Deliverable
BEGIN
  SELECT RAISE(ABORT, 'Deliverable rows are immutable');
END;
`,
}
