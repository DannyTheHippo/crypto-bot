# domain

Pure ring. No I/O, no `@nestjs/*`, no ccxt, no `Date.now()`, no `process.env`. All imports must
resolve within `src/domain` only.

Bucketed like features/ports (group → concern):

| Bucket | Contents |
| ------ | -------- |
| `common/` | types/money, types/ids, rng |
| `venue/` | types/{symbol,venue-map,subscription,market-events} |
| `trading/` | types/{order-intent,exec-report,portfolio,risk-decision,mode}, risk/, oms/, paper/, mode/ |
| `strategy/` | types/signal, indicators/ |
