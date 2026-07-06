import { describe, it, expect } from 'vitest';
import {
  DATABASE_POOL,
  DRIZZLE_DB,
  ORDER_REPO,
  FILL_REPO,
  SIGNAL_REPO,
  RISK_DECISION_REPO,
  AGENT_DECISION_REPO,
  PLAYBOOK_VERSION_REPO,
  OUTBOX,
  JOURNAL,
  CONFIG_SNAPSHOT_REPO,
  EQUITY_REPO,
  RECONCILIATION_REPO,
  MODE_TRANSITION_REPO,
  INTENT_REPO,
  DB_TRANSACTION,
} from '../../../src/database/database.tokens';

describe('persistence DI tokens', () => {
  it('all tokens are unique symbols', () => {
    const tokens = [
      DATABASE_POOL,
      DRIZZLE_DB,
      ORDER_REPO,
      FILL_REPO,
      SIGNAL_REPO,
      RISK_DECISION_REPO,
      AGENT_DECISION_REPO,
      PLAYBOOK_VERSION_REPO,
      OUTBOX,
      JOURNAL,
      CONFIG_SNAPSHOT_REPO,
      EQUITY_REPO,
      RECONCILIATION_REPO,
      MODE_TRANSITION_REPO,
      INTENT_REPO,
      DB_TRANSACTION,
    ];
    const set = new Set(tokens);
    expect(set.size).toBe(tokens.length);
  });

  it('every token is a Symbol', () => {
    expect(typeof DATABASE_POOL).toBe('symbol');
    expect(typeof DRIZZLE_DB).toBe('symbol');
    expect(typeof JOURNAL).toBe('symbol');
    expect(typeof OUTBOX).toBe('symbol');
  });
});
