import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';

// Per-asset fee accumulation (§6.6). Third-asset fees (e.g. BNB) land here and never touch
// position or quote-cash math. Write-only today (research/studies/fee-truth-2026-08-03.md):
// total()/all() have no callers anywhere in src/ — no balance-reconciliation or PnL-reporting
// consumer has been built yet, despite this class's name suggesting one exists. Nothing depends on
// its accumulated value; it is fed but never read.
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
