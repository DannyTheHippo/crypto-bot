import type {
  TickerEvent,
  OrderBookSnapshotEvent,
  TradeEvent,
  CandleEvent,
} from '../../../domain/venue/types/market-events';

// ── Ticker conflation cell ───────────────────────────────────────────────────
// Latest-wins; conflatedCount tracks how many events were merged since last read.

export interface TickerCell {
  event: TickerEvent | undefined;
  conflatedCount: number;
}

export function makeTickerCell(): TickerCell {
  return { event: undefined, conflatedCount: 0 };
}

export function tickerCellPut(cell: TickerCell, event: TickerEvent): void {
  if (cell.event !== undefined) {
    cell.conflatedCount++;
  }
  cell.event = event;
}

export function tickerCellTake(cell: TickerCell): TickerEvent | undefined {
  const ev = cell.event;
  cell.event = undefined;
  cell.conflatedCount = 0;
  return ev;
}

// ── Book conflation cell ─────────────────────────────────────────────────────
// Consumers always receive the current maintained-book snapshot.

export interface BookCell {
  event: OrderBookSnapshotEvent | undefined;
  conflatedCount: number;
}

export function makeBookCell(): BookCell {
  return { event: undefined, conflatedCount: 0 };
}

export function bookCellPut(cell: BookCell, event: OrderBookSnapshotEvent): void {
  if (cell.event !== undefined) {
    cell.conflatedCount++;
  }
  cell.event = event;
}

export function bookCellTake(cell: BookCell): OrderBookSnapshotEvent | undefined {
  const ev = cell.event;
  cell.event = undefined;
  cell.conflatedCount = 0;
  return ev;
}

// ── Trade ring buffer ────────────────────────────────────────────────────────
// Bounded 1024 entries. Drop-oldest on overflow.
// The next delivery after a drop sets gapBefore: true on the oldest retained event.

const TRADE_RING_CAPACITY = 1024;

export interface TradeRing {
  readonly buf: (TradeEvent | undefined)[];
  head: number; // index of oldest item
  count: number;
  dropped: boolean;
}

export function makeTradeRing(): TradeRing {
  return {
    buf: new Array<TradeEvent | undefined>(TRADE_RING_CAPACITY).fill(undefined),
    head: 0,
    count: 0,
    dropped: false,
  };
}

export function tradeRingPush(ring: TradeRing, event: TradeEvent): void {
  if (ring.count === TRADE_RING_CAPACITY) {
    // Drop oldest to make room
    ring.head = (ring.head + 1) % TRADE_RING_CAPACITY;
    ring.count--;
    ring.dropped = true;
  }
  const tail = (ring.head + ring.count) % TRADE_RING_CAPACITY;
  ring.buf[tail] = event;
  ring.count++;
}

export function tradeRingDrain(ring: TradeRing): TradeEvent[] {
  const result: TradeEvent[] = [];
  const wasDropped = ring.dropped;
  ring.dropped = false;

  for (let i = 0; i < ring.count; i++) {
    const idx = (ring.head + i) % TRADE_RING_CAPACITY;
    const ev = ring.buf[idx]!;
    if (i === 0 && wasDropped) {
      // Stamp gapBefore on the oldest surviving event to signal the consumer missed prints
      result.push({ ...ev, gapBefore: true });
    } else {
      result.push(ev);
    }
  }

  ring.head = 0;
  ring.count = 0;
  return result;
}

// ── Candle queue ─────────────────────────────────────────────────────────────
// Bounded 256. Losing a CLOSED candle is a FeedHealth GAP — never silent.

const CANDLE_QUEUE_CAPACITY = 256;

export interface CandleQueue {
  readonly buf: (CandleEvent | undefined)[];
  head: number;
  count: number;
  closedCandleLost: boolean;
}

export function makeCandleQueue(): CandleQueue {
  return {
    buf: new Array<CandleEvent | undefined>(CANDLE_QUEUE_CAPACITY).fill(undefined),
    head: 0,
    count: 0,
    closedCandleLost: false,
  };
}

export function candleQueuePush(queue: CandleQueue, event: CandleEvent): void {
  if (queue.count === CANDLE_QUEUE_CAPACITY) {
    // Drop oldest to make room
    const dropIdx = queue.head;
    const dropped = queue.buf[dropIdx];
    if (dropped?.closed) {
      // Closed candle lost — this is a GAP incident
      queue.closedCandleLost = true;
    }
    queue.head = (queue.head + 1) % CANDLE_QUEUE_CAPACITY;
    queue.count--;
  }
  const tail = (queue.head + queue.count) % CANDLE_QUEUE_CAPACITY;
  queue.buf[tail] = event;
  queue.count++;
}

export function candleQueueDrain(queue: CandleQueue): {
  events: CandleEvent[];
  gapDetected: boolean;
} {
  const gapDetected = queue.closedCandleLost;
  queue.closedCandleLost = false;

  const events: CandleEvent[] = [];
  for (let i = 0; i < queue.count; i++) {
    const idx = (queue.head + i) % CANDLE_QUEUE_CAPACITY;
    events.push(queue.buf[idx]!);
  }
  queue.head = 0;
  queue.count = 0;
  return { events, gapDetected };
}
