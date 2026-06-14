import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

// Per-asset fee accumulation (§6.6). Third-asset fees (e.g. BNB) land here and never touch
// position or quote-cash math; the asset participates in balance reconciliation, and PnL
// reporting converts at fill-time mark (flagged estimate) elsewhere.
@Injectable()
export class FeeLedgerService {
  private readonly byAsset = new Map<string, Decimal>();

  add(asset: string, amount: Decimal): void {
    this.byAsset.set(asset, (this.byAsset.get(asset) ?? new Decimal(0)).add(amount));
  }

  total(asset: string): Decimal {
    return this.byAsset.get(asset) ?? new Decimal(0);
  }

  all(): ReadonlyMap<string, Decimal> {
    return this.byAsset;
  }
}
