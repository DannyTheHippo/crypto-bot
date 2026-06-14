import { describe, it, expect } from 'vitest';
import { InMemoryExecOutbox } from '../../../src/modules/execution/in-memory-outbox';
import type { ExecReport } from '../../../src/domain/types/exec-report';
import { encodeClientOrderId, intentId, venueId, symbolId, epochMs } from '../../../src/domain/types/ids';

const coid = encodeClientOrderId(intentId('0190abcd-1234-7abc-89ab-0123456789ab'), 'paper');
const report = (id: string): ExecReport => ({
  kind: 'ACK', reportId: id, clientOrderId: coid, venue: venueId('binance'), symbol: symbolId('BTC/USDT'),
  eventTime: epochMs(1), ingestTime: epochMs(1), venueOrderId: 'v1',
});

describe('InMemoryExecOutbox', () => {
  it('assigns increasing cursors and is idempotent on reportId', async () => {
    const ob = new InMemoryExecOutbox();
    const c1 = await ob.append({ reportId: 'r1', report: report('r1') });
    const c2 = await ob.append({ reportId: 'r2', report: report('r2') });
    const c1dup = await ob.append({ reportId: 'r1', report: report('r1') });
    expect(c1).toBe(1);
    expect(c2).toBe(2);
    expect(c1dup).toBe(1); // dedup returns existing cursor, no new row
  });

  it('consume returns rows past max(fromCursor, lastAck); ack is monotone', async () => {
    const ob = new InMemoryExecOutbox();
    await ob.append({ reportId: 'r1', report: report('r1') });
    await ob.append({ reportId: 'r2', report: report('r2') });
    await ob.append({ reportId: 'r3', report: report('r3') });

    expect((await ob.consume('c', 0)).map((r) => r.cursor)).toEqual([1, 2, 3]);
    await ob.ack('c', 2);
    expect((await ob.consume('c', 0)).map((r) => r.cursor)).toEqual([3]); // ack wins over fromCursor 0
    await ob.ack('c', 1); // non-monotone ack ignored
    expect((await ob.consume('c', 0)).map((r) => r.cursor)).toEqual([3]);
    expect((await ob.consume('c', 2)).map((r) => r.cursor)).toEqual([3]); // fromCursor matches ack
  });
});
