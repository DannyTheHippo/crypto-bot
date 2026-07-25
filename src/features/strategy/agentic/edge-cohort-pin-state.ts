/** Shared pin set so UniverseScanner keeps EdgePolicy cohort symbols on the active menu. */
export class EdgeCohortPinState {
  private pins = new Set<string>();

  set(symbols: readonly string[]): void {
    this.pins = new Set(symbols);
  }

  clear(): void {
    this.pins = new Set();
  }

  has(symbol: string): boolean {
    return this.pins.has(symbol);
  }

  symbols(): readonly string[] {
    return [...this.pins];
  }
}
