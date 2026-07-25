# ports

Interfaces and DI tokens only. Imports domain types only. Concrete implementations live under
`src/features/{common,venue,trading,strategy}/`.

Organized by the same domain buckets as features:

| Bucket | Ports |
| ------ | ----- |
| `common/` | app-config, clock, db-health, observability |
| `venue/` | exchange, streams, market-data, feed ports, funding-payments |
| `trading/` | execution, risk, mode-control, promotion |
| `strategy/` | strategy, agentic-strategy, sentiment/fear-greed feeds |
