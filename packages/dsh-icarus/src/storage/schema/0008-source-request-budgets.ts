import type { Migration } from '../migrations.js'

export const sourceRequestBudgets: Migration = {
  version: 8,
  name: 'source-request-budgets',
  sql: `
CREATE TABLE SourceRequestBudget (
  budgetKey TEXT PRIMARY KEY,
  nextRequestAt INTEGER NOT NULL,
  requestLimit INTEGER,
  remaining INTEGER,
  resetAt INTEGER,
  lastResponseAt INTEGER
);
`,
}
