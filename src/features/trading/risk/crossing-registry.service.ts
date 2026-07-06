import { Injectable } from '@nestjs/common';
import { wouldCross, type RestingOrder, type CrossingProbe } from '../../../domain/risk/crossing';
import type { ClientOrderId, StrategyId, SymbolId } from '../../../domain/types/ids';
import type { Price } from '../../../domain/types/money';

// Symbol-level open-interest registry (resting + in-flight orders), keyed by
// clientOrderId so an order can be added on approval and removed on terminal report.
// Crossing detection (§5 X1) delegates to the pure domain helper.
@Injectable()
export class CrossingRegistryService {
  private readonly orders = new Map<ClientOrderId, RestingOrder>();

  add(id: ClientOrderId, order: RestingOrder): void {
    this.orders.set(id, order);
  }

  remove(id: ClientOrderId): void {
    this.orders.delete(id);
  }

  wouldCross(
    strategyId: StrategyId,
    symbol: SymbolId,
    side: 'BUY' | 'SELL',
    limitPrice: Price | undefined,
  ): boolean {
    const probe: CrossingProbe = { strategyId, symbol, side, limitPrice };
    return wouldCross(probe, Array.from(this.orders.values()));
  }
}
