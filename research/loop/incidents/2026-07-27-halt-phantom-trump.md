# Incident 2026-07-27 — 45h full halt on a phantom TRUMP position

Pre-restart forensic snapshot, captured 2026-07-27T07:52Z before the fix redeploy.
Boot `4ff1fbe6-e646-429e-ba9d-882f60967e17` (started 2026-07-25T16:20:36Z).

Summary: kill switch HALTED_DEGRADED on `RECONCILE_MISMATCH:POSITION_DRIFT:TRUMP/USDT:USDT`.
Local positions claimed `TRUMP/USDT:USDT -51.24`; a read-only venue `fetchPositions` with the
app's own credentials showed NO TRUMP position (only `BTC/USDT:USDT` long 0.0021).
Zero `agent_decisions` rows on this entire boot; last fill 2026-07-25T10:33:30Z.
Venue-side sweep verified healthy from inside the container: 24 spot symbols x 2 axes, ok=48 err=0.

---

## positions (all)

```json
[
 {
  "strategy_id": "agentic-7",
  "venue": "binance",
  "symbol": "AAVE/USDT",
  "signed_qty": "0.000649000000000000",
  "avg_entry": "96.339700081038195654",
  "realized_pnl": "-4.055773367180664197",
  "boot_id": "4ff1fbe6-e646-429e-ba9d-882f60967e17",
  "updated_at": "2026-07-27T08:25:09.021Z"
 },
 {
  "strategy_id": "agentic-1",
  "venue": "binance",
  "symbol": "BTC/USDT",
  "signed_qty": "0.001218780000000000",
  "avg_entry": "65181.590000000000000000",
  "realized_pnl": "0.000000000000000000",
  "boot_id": "4ff1fbe6-e646-429e-ba9d-882f60967e17",
  "updated_at": "2026-07-27T08:25:09.021Z"
 },
 {
  "strategy_id": "agentic-25",
  "venue": "binanceusdm",
  "symbol": "BTC/USDT:USDT",
  "signed_qty": "0.002100000000000000",
  "avg_entry": "65427.200000000000000000",
  "realized_pnl": "-0.054958840000000000",
  "boot_id": "4ff1fbe6-e646-429e-ba9d-882f60967e17",
  "updated_at": "2026-07-27T08:25:09.021Z"
 },
 {
  "strategy_id": "agentic-3",
  "venue": "binance",
  "symbol": "SOL/USDT",
  "signed_qty": "0.523476000000000000",
  "avg_entry": "76.210000000000000000",
  "realized_pnl": "0.000000000000000000",
  "boot_id": "4ff1fbe6-e646-429e-ba9d-882f60967e17",
  "updated_at": "2026-07-27T08:25:09.021Z"
 },
 {
  "strategy_id": "agentic-33",
  "venue": "binanceusdm",
  "symbol": "TRUMP/USDT:USDT",
  "signed_qty": "-51.240000000000000000",
  "avg_entry": "1.561000000000000000",
  "realized_pnl": "-0.015997060000000000",
  "boot_id": "4ff1fbe6-e646-429e-ba9d-882f60967e17",
  "updated_at": "2026-07-27T08:25:09.021Z"
 },
 {
  "strategy_id": "agentic-6",
  "venue": "binance",
  "symbol": "ZEC/USDT",
  "signed_qty": "0.000903000000000000",
  "avg_entry": "513.420000000000000000",
  "realized_pnl": "-0.806929920000000000",
  "boot_id": "4ff1fbe6-e646-429e-ba9d-882f60967e17",
  "updated_at": "2026-07-27T08:25:09.021Z"
 }
]
```

## orders in RECONCILE_REQUIRED

```json
[
 {
  "client_order_id": "cbt019f9865a44878b4b0d2da45bea9a750",
  "venue": "binanceusdm",
  "symbol": "TRUMP/USDT:USDT",
  "side": "BUY",
  "type": "LIMIT",
  "qty": "51.240000000000000000",
  "state": "RECONCILE_REQUIRED",
  "submitted_at": "1784968225874",
  "updated_at": "2026-07-25T17:36:31.051Z"
 },
 {
  "client_order_id": "cbt019f977c563c7acf8779af23c169d950",
  "venue": "binanceusdm",
  "symbol": "BTC/USDT:USDT",
  "side": "SELL",
  "type": "LIMIT",
  "qty": "0.002100000000000000",
  "state": "RECONCILE_REQUIRED",
  "submitted_at": "1784952936009",
  "updated_at": "2026-07-25T17:36:30.904Z"
 },
 {
  "client_order_id": "cbt019f977bd1f97a32b465fc9b18455724",
  "venue": "binance",
  "symbol": "BTC/USDT",
  "side": "SELL",
  "type": "LIMIT",
  "qty": "0.001210000000000000",
  "state": "RECONCILE_REQUIRED",
  "submitted_at": "1784952902145",
  "updated_at": "2026-07-25T17:36:29.627Z"
 },
 {
  "client_order_id": "cbt019f977bcd3777b4b132c5a2a0b93dfd",
  "venue": "binance",
  "symbol": "SOL/USDT",
  "side": "SELL",
  "type": "LIMIT",
  "qty": "0.523000000000000000",
  "state": "RECONCILE_REQUIRED",
  "submitted_at": "1784952900930",
  "updated_at": "2026-07-25T17:36:29.622Z"
 },
 {
  "client_order_id": "cbt019f977bd45974a3a0f00f49fd2ff228",
  "venue": "binance",
  "symbol": "BTC/USDT",
  "side": "SELL",
  "type": "STOP_LOSS_LIMIT",
  "qty": "0.001210000000000000",
  "state": "RECONCILE_REQUIRED",
  "submitted_at": "1784952902749",
  "updated_at": "2026-07-25T17:19:02.904Z"
 },
 {
  "client_order_id": "cbt019f98d339f57e569b8fecc2ada89544",
  "venue": "binanceusdm",
  "symbol": "KAITO/USDT:USDT",
  "side": "SELL",
  "type": "STOP_MARKET",
  "qty": "52.000000000000000000",
  "state": "ACKED",
  "submitted_at": "1784975407610",
  "updated_at": "2026-07-25T10:30:32.567Z"
 },
 {
  "client_order_id": "cbt019f9865c0b17dce8bf2202c82edb13a",
  "venue": "binanceusdm",
  "symbol": "TRUMP/USDT:USDT",
  "side": "BUY",
  "type": "STOP_MARKET",
  "qty": "51.240000000000000000",
  "state": "ACKED",
  "submitted_at": "1784968233141",
  "updated_at": "2026-07-25T08:30:34.479Z"
 },
 {
  "client_order_id": "cbt019f9865bdd279ce8fae70d2ef77f73a",
  "venue": "binanceusdm",
  "symbol": "HYPE/USDT:USDT",
  "side": "BUY",
  "type": "STOP_MARKET",
  "qty": "1.400000000000000000",
  "state": "ACKED",
  "submitted_at": "1784968232409",
  "updated_at": "2026-07-25T08:30:33.832Z"
 },
 {
  "client_order_id": "cbt019f977c5b2a7a54951ffbe9e92ad702",
  "venue": "binanceusdm",
  "symbol": "BTC/USDT:USDT",
  "side": "SELL",
  "type": "STOP_MARKET",
  "qty": "0.002100000000000000",
  "state": "ACKED",
  "submitted_at": "1784952937273",
  "updated_at": "2026-07-25T04:15:38.439Z"
 },
 {
  "client_order_id": "cbt019f976ea89f7a3eb98e2fc085ec7334",
  "venue": "binanceusdm",
  "symbol": "TRUMP/USDT:USDT",
  "side": "BUY",
  "type": "STOP_MARKET",
  "qty": "51.240000000000000000",
  "state": "ACKED",
  "submitted_at": "1784952039589",
  "updated_at": "2026-07-25T04:00:40.832Z"
 },
 {
  "client_order_id": "cbt019f976e785e720a851554db550f5bd9",
  "venue": "binanceusdm",
  "symbol": "KAITO/USDT:USDT",
  "side": "SELL",
  "type": "STOP_MARKET",
  "qty": "52.000000000000000000",
  "state": "ACKED",
  "submitted_at": "1784952027238",
  "updated_at": "2026-07-25T04:00:36.183Z"
 },
 {
  "client_order_id": "cbt019f9496a22b794e81007d02195d436e",
  "venue": "binanceusdm",
  "symbol": "NEAR/USDT:USDT",
  "side": "SELL",
  "type": "LIMIT_MAKER",
  "qty": "55.000000000000000000",
  "state": "NEW",
  "submitted_at": "1784904327738",
  "updated_at": "2026-07-24T14:45:37.318Z"
 },
 {
  "client_order_id": "cbt019f94963eee759d91c4476538a5faa5",
  "venue": "binanceusdm",
  "symbol": "KAITO/USDT:USDT",
  "side": "BUY",
  "type": "LIMIT",
  "qty": "122.000000000000000000",
  "state": "NEW",
  "submitted_at": "1784904302328",
  "updated_at": "2026-07-24T14:45:35.382Z"
 },
 {
  "client_order_id": "cbt019f9444400f7f75bbf472ffa16a864f",
  "venue": "binanceusdm",
  "symbol": "SOL/USDT:USDT",
  "side": "SELL",
  "type": "LIMIT_MAKER",
  "qty": "0.640000000000000000",
  "state": "NEW",
  "submitted_at": "1784898928674",
  "updated_at": "2026-07-24T13:15:36.243Z"
 },
 {
  "client_order_id": "cbt019f9444400d7f9e94c233b58e885d5f",
  "venue": "binanceusdm",
  "symbol": "ZEC/USDT:USDT",
  "side": "SELL",
  "type": "LIMIT_MAKER",
  "qty": "0.097000000000000000",
  "state": "NEW",
  "submitted_at": "1784898928674",
  "updated_at": "2026-07-24T13:15:35.096Z"
 }
]
```

## order_events for the stuck orders

```json
[
 {
  "order_id": "019f9865-a448-78b4-b0d2-da45bea9a750",
  "event_type": "QUERY_INCONCLUSIVE",
  "payload": "{\"type\": \"QUERY_INCONCLUSIVE\"}",
  "ts": "2026-07-25T17:36:31.051Z"
 },
 {
  "order_id": "019f977c-563c-7acf-8779-af23c169d950",
  "event_type": "QUERY_INCONCLUSIVE",
  "payload": "{\"type\": \"QUERY_INCONCLUSIVE\"}",
  "ts": "2026-07-25T17:36:30.903Z"
 },
 {
  "order_id": "019f977b-d1f9-7a32-b465-fc9b18455724",
  "event_type": "QUERY_INCONCLUSIVE",
  "payload": "{\"type\": \"QUERY_INCONCLUSIVE\"}",
  "ts": "2026-07-25T17:36:29.626Z"
 },
 {
  "order_id": "019f977b-cd37-77b4-b132-c5a2a0b93dfd",
  "event_type": "QUERY_INCONCLUSIVE",
  "payload": "{\"type\": \"QUERY_INCONCLUSIVE\"}",
  "ts": "2026-07-25T17:36:29.621Z"
 },
 {
  "order_id": "019f977b-d459-74a3-a0f0-0f49fd2ff228",
  "event_type": "QUERY_INCONCLUSIVE",
  "payload": "{\"type\": \"QUERY_INCONCLUSIVE\"}",
  "ts": "2026-07-25T17:19:02.902Z"
 },
 {
  "order_id": "019f9865-a448-78b4-b0d2-da45bea9a750",
  "event_type": "CANCEL_REJECT_UNKNOWN",
  "payload": "{\"type\": \"CANCEL_REJECT_UNKNOWN\", \"reason\": \"HALT\"}",
  "ts": "2026-07-25T17:18:54.496Z"
 },
 {
  "order_id": "019f9865-a448-78b4-b0d2-da45bea9a750",
  "event_type": "CANCEL_REQUESTED",
  "payload": "{\"type\": \"CANCEL_REQUESTED\", \"reason\": \"HALT\"}",
  "ts": "2026-07-25T17:18:54.393Z"
 },
 {
  "order_id": "019f977c-563c-7acf-8779-af23c169d950",
  "event_type": "CANCEL_REJECT_UNKNOWN",
  "payload": "{\"type\": \"CANCEL_REJECT_UNKNOWN\", \"reason\": \"HALT\"}",
  "ts": "2026-07-25T17:18:54.388Z"
 },
 {
  "order_id": "019f977c-563c-7acf-8779-af23c169d950",
  "event_type": "CANCEL_REQUESTED",
  "payload": "{\"type\": \"CANCEL_REQUESTED\", \"reason\": \"HALT\"}",
  "ts": "2026-07-25T17:18:51.906Z"
 },
 {
  "order_id": "019f977b-d459-74a3-a0f0-0f49fd2ff228",
  "event_type": "CANCEL_REJECT_UNKNOWN",
  "payload": "{\"type\": \"CANCEL_REJECT_UNKNOWN\", \"reason\": \"HALT\"}",
  "ts": "2026-07-25T17:18:51.904Z"
 },
 {
  "order_id": "019f977b-d459-74a3-a0f0-0f49fd2ff228",
  "event_type": "CANCEL_REQUESTED",
  "payload": "{\"type\": \"CANCEL_REQUESTED\", \"reason\": \"HALT\"}",
  "ts": "2026-07-25T17:18:51.902Z"
 },
 {
  "order_id": "019f977b-d1f9-7a32-b465-fc9b18455724",
  "event_type": "CANCEL_REJECT_UNKNOWN",
  "payload": "{\"type\": \"CANCEL_REJECT_UNKNOWN\", \"reason\": \"HALT\"}",
  "ts": "2026-07-25T17:18:51.899Z"
 },
 {
  "order_id": "019f977b-d1f9-7a32-b465-fc9b18455724",
  "event_type": "CANCEL_REQUESTED",
  "payload": "{\"type\": \"CANCEL_REQUESTED\", \"reason\": \"HALT\"}",
  "ts": "2026-07-25T17:18:51.897Z"
 },
 {
  "order_id": "019f977b-cd37-77b4-b132-c5a2a0b93dfd",
  "event_type": "CANCEL_REJECT_UNKNOWN",
  "payload": "{\"type\": \"CANCEL_REJECT_UNKNOWN\", \"reason\": \"HALT\"}",
  "ts": "2026-07-25T17:18:51.894Z"
 },
 {
  "order_id": "019f977b-cd37-77b4-b132-c5a2a0b93dfd",
  "event_type": "CANCEL_REQUESTED",
  "payload": "{\"type\": \"CANCEL_REQUESTED\", \"reason\": \"HALT\"}",
  "ts": "2026-07-25T17:18:51.886Z"
 },
 {
  "order_id": "019f9865-a448-78b4-b0d2-da45bea9a750",
  "event_type": "ACK",
  "payload": "{\"type\": \"ACK\", \"venueOrderId\": \"515338007\"}",
  "ts": "2026-07-25T08:30:33.135Z"
 },
 {
  "order_id": "019f9865-a448-78b4-b0d2-da45bea9a750",
  "event_type": "SUBMIT_SENT",
  "payload": "{\"type\": \"SUBMIT_SENT\"}",
  "ts": "2026-07-25T08:30:25.874Z"
 },
 {
  "order_id": "019f977c-563c-7acf-8779-af23c169d950",
  "event_type": "ACK",
  "payload": "{\"type\": \"ACK\", \"venueOrderId\": \"23876993788\"}",
  "ts": "2026-07-25T04:15:37.255Z"
 },
 {
  "order_id": "019f977c-563c-7acf-8779-af23c169d950",
  "event_type": "SUBMIT_SENT",
  "payload": "{\"type\": \"SUBMIT_SENT\"}",
  "ts": "2026-07-25T04:15:36.009Z"
 },
 {
  "order_id": "019f977b-d459-74a3-a0f0-0f49fd2ff228",
  "event_type": "ACK",
  "payload": "{\"type\": \"ACK\", \"venueOrderId\": \"51106789873\"}",
  "ts": "2026-07-25T04:15:03.195Z"
 },
 {
  "order_id": "019f977b-d459-74a3-a0f0-0f49fd2ff228",
  "event_type": "SUBMIT_SENT",
  "payload": "{\"type\": \"SUBMIT_SENT\"}",
  "ts": "2026-07-25T04:15:02.748Z"
 },
 {
  "order_id": "019f977b-d1f9-7a32-b465-fc9b18455724",
  "event_type": "ACK",
  "payload": "{\"type\": \"ACK\", \"venueOrderId\": \"51106786799\"}",
  "ts": "2026-07-25T04:15:02.743Z"
 },
 {
  "order_id": "019f977b-d1f9-7a32-b465-fc9b18455724",
  "event_type": "SUBMIT_SENT",
  "payload": "{\"type\": \"SUBMIT_SENT\"}",
  "ts": "2026-07-25T04:15:02.144Z"
 },
 {
  "order_id": "019f977b-cd37-77b4-b132-c5a2a0b93dfd",
  "event_type": "ACK",
  "payload": "{\"type\": \"ACK\", \"venueOrderId\": \"2621524613\"}",
  "ts": "2026-07-25T04:15:01.393Z"
 },
 {
  "order_id": "019f977b-cd37-77b4-b132-c5a2a0b93dfd",
  "event_type": "SUBMIT_SENT",
  "payload": "{\"type\": \"SUBMIT_SENT\"}",
  "ts": "2026-07-25T04:15:00.929Z"
 }
]
```

## reconciliations tail (both venues)

```json
[
 {
  "venue": "binance",
  "result": "MISMATCH",
  "discrepancies": "{\"detail\": \"clean\", \"mismatches\": 48}",
  "ts": "2026-07-27T08:25:05.197Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "discrepancies": "{\"detail\": \"POSITION_DRIFT:TRUMP/USDT:USDT\", \"mismatches\": 2}",
  "ts": "2026-07-27T08:24:48.992Z"
 },
 {
  "venue": "binance",
  "result": "MISMATCH",
  "discrepancies": "{\"detail\": \"clean\", \"mismatches\": 48}",
  "ts": "2026-07-27T08:24:35.199Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "discrepancies": "{\"detail\": \"POSITION_DRIFT:TRUMP/USDT:USDT\", \"mismatches\": 2}",
  "ts": "2026-07-27T08:24:19.298Z"
 },
 {
  "venue": "binance",
  "result": "MISMATCH",
  "discrepancies": "{\"detail\": \"clean\", \"mismatches\": 48}",
  "ts": "2026-07-27T08:24:05.199Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "discrepancies": "{\"detail\": \"POSITION_DRIFT:TRUMP/USDT:USDT\", \"mismatches\": 2}",
  "ts": "2026-07-27T08:23:49.610Z"
 },
 {
  "venue": "binance",
  "result": "MISMATCH",
  "discrepancies": "{\"detail\": \"clean\", \"mismatches\": 48}",
  "ts": "2026-07-27T08:23:35.199Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "discrepancies": "{\"detail\": \"POSITION_DRIFT:TRUMP/USDT:USDT\", \"mismatches\": 2}",
  "ts": "2026-07-27T08:23:19.323Z"
 },
 {
  "venue": "binance",
  "result": "MISMATCH",
  "discrepancies": "{\"detail\": \"clean\", \"mismatches\": 48}",
  "ts": "2026-07-27T08:23:05.197Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "discrepancies": "{\"detail\": \"POSITION_DRIFT:TRUMP/USDT:USDT\", \"mismatches\": 2}",
  "ts": "2026-07-27T08:22:48.974Z"
 },
 {
  "venue": "binance",
  "result": "MISMATCH",
  "discrepancies": "{\"detail\": \"clean\", \"mismatches\": 48}",
  "ts": "2026-07-27T08:22:35.198Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "discrepancies": "{\"detail\": \"POSITION_DRIFT:TRUMP/USDT:USDT\", \"mismatches\": 2}",
  "ts": "2026-07-27T08:22:19.375Z"
 },
 {
  "venue": "binance",
  "result": "MISMATCH",
  "discrepancies": "{\"detail\": \"clean\", \"mismatches\": 48}",
  "ts": "2026-07-27T08:22:05.194Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "discrepancies": "{\"detail\": \"POSITION_DRIFT:TRUMP/USDT:USDT\", \"mismatches\": 2}",
  "ts": "2026-07-27T08:21:49.204Z"
 },
 {
  "venue": "binance",
  "result": "MISMATCH",
  "discrepancies": "{\"detail\": \"clean\", \"mismatches\": 48}",
  "ts": "2026-07-27T08:21:35.195Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "discrepancies": "{\"detail\": \"POSITION_DRIFT:TRUMP/USDT:USDT\", \"mismatches\": 2}",
  "ts": "2026-07-27T08:21:19.175Z"
 },
 {
  "venue": "binance",
  "result": "MISMATCH",
  "discrepancies": "{\"detail\": \"clean\", \"mismatches\": 48}",
  "ts": "2026-07-27T08:21:05.199Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "discrepancies": "{\"detail\": \"POSITION_DRIFT:TRUMP/USDT:USDT\", \"mismatches\": 2}",
  "ts": "2026-07-27T08:20:49.234Z"
 },
 {
  "venue": "binance",
  "result": "MISMATCH",
  "discrepancies": "{\"detail\": \"clean\", \"mismatches\": 48}",
  "ts": "2026-07-27T08:20:35.193Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "discrepancies": "{\"detail\": \"POSITION_DRIFT:TRUMP/USDT:USDT\", \"mismatches\": 2}",
  "ts": "2026-07-27T08:20:19.007Z"
 }
]
```

## reconciliation result history

```json
[
 {
  "venue": "binance",
  "result": "MISMATCH",
  "count": "2609",
  "first": "2026-07-23T02:13:31.482Z",
  "last": "2026-07-27T08:25:05.197Z"
 },
 {
  "venue": "binance",
  "result": "CLEAN",
  "count": "6531",
  "first": "2026-07-21T11:16:55.529Z",
  "last": "2026-07-25T11:13:17.590Z"
 },
 {
  "venue": "binance",
  "result": "HALT",
  "count": "1",
  "first": "2026-07-23T15:45:32.027Z",
  "last": "2026-07-23T15:45:32.027Z"
 },
 {
  "venue": "binanceusdm",
  "result": "HALT",
  "count": "1650",
  "first": "2026-07-25T03:46:35.816Z",
  "last": "2026-07-27T08:24:48.992Z"
 },
 {
  "venue": "binanceusdm",
  "result": "MISMATCH",
  "count": "1036",
  "first": "2026-07-23T16:01:03.048Z",
  "last": "2026-07-26T18:12:44.535Z"
 },
 {
  "venue": "binanceusdm",
  "result": "CLEAN",
  "count": "6442",
  "first": "2026-07-21T11:17:13.888Z",
  "last": "2026-07-26T04:56:59.242Z"
 }
]
```

## boots

```json
[
 {
  "boot_id": "4ff1fbe6-e646-429e-ba9d-882f60967e17",
  "first": "2026-07-25T16:20:36.578Z",
  "last": "2026-07-27T08:25:09.020Z",
  "count": "10419"
 },
 {
  "boot_id": "f6a163ec-ea3b-4274-8949-36e4480a4079",
  "first": "2026-07-25T07:48:30.208Z",
  "last": "2026-07-25T16:18:27.032Z",
  "count": "2555"
 },
 {
  "boot_id": "11673f15-7de4-488a-b85c-c6a45d10ef59",
  "first": "2026-07-24T15:45:21.982Z",
  "last": "2026-07-25T07:48:11.738Z",
  "count": "11595"
 },
 {
  "boot_id": "51a98ca2-6bf3-445c-bd52-34db7be38436",
  "first": "2026-07-24T15:39:28.953Z",
  "last": "2026-07-24T15:45:04.069Z",
  "count": "68"
 },
 {
  "boot_id": "26472b85-3b6b-4361-ba20-17c9fa778c58",
  "first": "2026-07-24T14:05:06.129Z",
  "last": "2026-07-24T15:39:08.162Z",
  "count": "1131"
 },
 {
  "boot_id": "5f2697da-c5a6-4b35-87bc-bdca4a064219",
  "first": "2026-07-24T11:21:28.447Z",
  "last": "2026-07-24T14:04:48.238Z",
  "count": "1963"
 },
 {
  "boot_id": "2bbd9951-fc93-49be-a7cb-70d291d99ce5",
  "first": "2026-07-24T10:49:03.268Z",
  "last": "2026-07-24T11:21:08.723Z",
  "count": "388"
 },
 {
  "boot_id": "e7c86f49-d6cf-4ebb-a5f2-09c78960ee0e",
  "first": "2026-07-24T10:48:14.485Z",
  "last": "2026-07-24T10:48:44.487Z",
  "count": "7"
 }
]
```

## agent_decisions tail

```json
[
 {
  "symbol": "UNI/USDT",
  "action": "error",
  "r": "RETRYABLE: anthropic api transport error: fetch failed",
  "model": "claude-sonnet-5",
  "created_at": "2026-07-25T14:59:58.773Z"
 },
 {
  "symbol": "SHIB/USDT",
  "action": "hold",
  "r": "scheduled: next consult in 0 bars — LLM not consulted",
  "model": "prescreen",
  "created_at": "2026-07-25T14:42:02.868Z"
 },
 {
  "symbol": "XRP/USDT",
  "action": "hold",
  "r": "scheduled: next consult in 0 bars — LLM not consulted",
  "model": "prescreen",
  "created_at": "2026-07-25T14:41:59.711Z"
 },
 {
  "symbol": "OP/USDT",
  "action": "hold",
  "r": "scheduled: next consult in 0 bars — LLM not consulted",
  "model": "prescreen",
  "created_at": "2026-07-25T14:41:59.518Z"
 },
 {
  "symbol": "NEAR/USDT",
  "action": "hold",
  "r": "scheduled: next consult in 10 bars — LLM not consulted",
  "model": "prescreen",
  "created_at": "2026-07-25T14:41:58.516Z"
 },
 {
  "symbol": "ZEC/USDT",
  "action": "hold",
  "r": "scheduled: next consult in 10 bars — LLM not consulted",
  "model": "prescreen",
  "created_at": "2026-07-25T14:41:58.082Z"
 },
 {
  "symbol": "LTC/USDT",
  "action": "hold",
  "r": "scheduled: next consult in 0 bars — LLM not consulted",
  "model": "prescreen",
  "created_at": "2026-07-25T14:41:57.585Z"
 },
 {
  "symbol": "BTC/USDT",
  "action": "hold",
  "r": "plan active — deterministic hold (scheduled: next consult in 15 bars)",
  "model": "plan-executor",
  "created_at": "2026-07-25T14:41:57.497Z"
 },
 {
  "symbol": "SOL/USDT",
  "action": "hold",
  "r": "plan active — deterministic hold (scheduled: next consult in 14 bars)",
  "model": "plan-executor",
  "created_at": "2026-07-25T14:41:56.514Z"
 },
 {
  "symbol": "DOGE/USDT",
  "action": "hold",
  "r": "scheduled: next consult in 0 bars — LLM not consulted",
  "model": "prescreen",
  "created_at": "2026-07-25T14:41:56.057Z"
 }
]
```

## equity tail

```json
[
 {
  "boot_id": "4ff1fbe6-e646-429e-ba9d-882f60967e17",
  "ts": "2026-07-27T08:25:09.020Z",
  "equity": "4978.035331235552593789",
  "cash": "4800.761584290000000000",
  "peak": "5000.695479360000000000"
 },
 {
  "boot_id": "4ff1fbe6-e646-429e-ba9d-882f60967e17",
  "ts": "2026-07-27T08:25:04.020Z",
  "equity": "4978.035331235552593789",
  "cash": "4800.761584290000000000",
  "peak": "5000.695479360000000000"
 },
 {
  "boot_id": "4ff1fbe6-e646-429e-ba9d-882f60967e17",
  "ts": "2026-07-27T08:24:59.018Z",
  "equity": "4978.035331235552593789",
  "cash": "4800.761584290000000000",
  "peak": "5000.695479360000000000"
 }
]
```

---

## /metrics (full scrape at capture time)

```text
# HELP process_cpu_user_seconds_total Total user CPU time spent in seconds.
# TYPE process_cpu_user_seconds_total counter
process_cpu_user_seconds_total 1788.8211580000075

# HELP process_cpu_system_seconds_total Total system CPU time spent in seconds.
# TYPE process_cpu_system_seconds_total counter
process_cpu_system_seconds_total 258.6892010000002

# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds.
# TYPE process_cpu_seconds_total counter
process_cpu_seconds_total 2047.5103590000012

# HELP process_start_time_seconds Start time of the process since unix epoch in seconds.
# TYPE process_start_time_seconds gauge
process_start_time_seconds 1784996428

# HELP process_resident_memory_bytes Resident memory size in bytes.
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes 369045504

# HELP process_virtual_memory_bytes Virtual memory size in bytes.
# TYPE process_virtual_memory_bytes gauge
process_virtual_memory_bytes 9746067456

# HELP process_heap_bytes Process heap size in bytes.
# TYPE process_heap_bytes gauge
process_heap_bytes 641437696

# HELP process_open_fds Number of open file descriptors.
# TYPE process_open_fds gauge
process_open_fds 57

# HELP process_max_fds Maximum number of open file descriptors.
# TYPE process_max_fds gauge
process_max_fds 1048576

# HELP nodejs_eventloop_lag_seconds Lag of event loop in seconds.
# TYPE nodejs_eventloop_lag_seconds gauge
nodejs_eventloop_lag_seconds 0.001148375

# HELP nodejs_eventloop_lag_min_seconds The minimum recorded event loop delay.
# TYPE nodejs_eventloop_lag_min_seconds gauge
nodejs_eventloop_lag_min_seconds 0.008880128

# HELP nodejs_eventloop_lag_max_seconds The maximum recorded event loop delay.
# TYPE nodejs_eventloop_lag_max_seconds gauge
nodejs_eventloop_lag_max_seconds 0.018907135

# HELP nodejs_eventloop_lag_mean_seconds The mean of the recorded event loop delays.
# TYPE nodejs_eventloop_lag_mean_seconds gauge
nodejs_eventloop_lag_mean_seconds 0.011062957829823084

# HELP nodejs_eventloop_lag_stddev_seconds The standard deviation of the recorded event loop delays.
# TYPE nodejs_eventloop_lag_stddev_seconds gauge
nodejs_eventloop_lag_stddev_seconds 0.0009359256489951742

# HELP nodejs_eventloop_lag_p50_seconds The 50th percentile of the recorded event loop delays.
# TYPE nodejs_eventloop_lag_p50_seconds gauge
nodejs_eventloop_lag_p50_seconds 0.010846207

# HELP nodejs_eventloop_lag_p90_seconds The 90th percentile of the recorded event loop delays.
# TYPE nodejs_eventloop_lag_p90_seconds gauge
nodejs_eventloop_lag_p90_seconds 0.012468223

# HELP nodejs_eventloop_lag_p99_seconds The 99th percentile of the recorded event loop delays.
# TYPE nodejs_eventloop_lag_p99_seconds gauge
nodejs_eventloop_lag_p99_seconds 0.012926975

# HELP nodejs_active_resources Number of active resources that are currently keeping the event loop alive, grouped by async resource type.
# TYPE nodejs_active_resources gauge
nodejs_active_resources{type="PipeWrap"} 2
nodejs_active_resources{type="TCPServerWrap"} 1
nodejs_active_resources{type="TCPSocketWrap"} 4
nodejs_active_resources{type="Timeout"} 15
nodejs_active_resources{type="Immediate"} 1

# HELP nodejs_active_resources_total Total number of active resources.
# TYPE nodejs_active_resources_total gauge
nodejs_active_resources_total 23

# HELP nodejs_active_handles Number of active libuv handles grouped by handle type. Every handle type is C++ class name.
# TYPE nodejs_active_handles gauge
nodejs_active_handles{type="Socket"} 4
nodejs_active_handles{type="Server"} 1
nodejs_active_handles{type="TLSSocket"} 2

# HELP nodejs_active_handles_total Total number of active handles.
# TYPE nodejs_active_handles_total gauge
nodejs_active_handles_total 7

# HELP nodejs_active_requests Number of active libuv requests grouped by request type. Every request type is C++ class name.
# TYPE nodejs_active_requests gauge

# HELP nodejs_active_requests_total Total number of active requests.
# TYPE nodejs_active_requests_total gauge
nodejs_active_requests_total 0

# HELP nodejs_heap_size_total_bytes Process heap size from Node.js in bytes.
# TYPE nodejs_heap_size_total_bytes gauge
nodejs_heap_size_total_bytes 190246912

# HELP nodejs_heap_size_used_bytes Process heap size used from Node.js in bytes.
# TYPE nodejs_heap_size_used_bytes gauge
nodejs_heap_size_used_bytes 173369704

# HELP nodejs_external_memory_bytes Node.js external memory size in bytes.
# TYPE nodejs_external_memory_bytes gauge
nodejs_external_memory_bytes 15970831

# HELP nodejs_heap_space_size_total_bytes Process heap space size total from Node.js in bytes.
# TYPE nodejs_heap_space_size_total_bytes gauge
nodejs_heap_space_size_total_bytes{space="read_only"} 0
nodejs_heap_space_size_total_bytes{space="new"} 1048576
nodejs_heap_space_size_total_bytes{space="old"} 148205568
nodejs_heap_space_size_total_bytes{space="code"} 9437184
nodejs_heap_space_size_total_bytes{space="shared"} 0
nodejs_heap_space_size_total_bytes{space="trusted"} 7499776
nodejs_heap_space_size_total_bytes{space="shared_trusted"} 0
nodejs_heap_space_size_total_bytes{space="new_large_object"} 0
nodejs_heap_space_size_total_bytes{space="large_object"} 23867392
nodejs_heap_space_size_total_bytes{space="code_large_object"} 188416
nodejs_heap_space_size_total_bytes{space="shared_large_object"} 0
nodejs_heap_space_size_total_bytes{space="shared_trusted_large_object"} 0
nodejs_heap_space_size_total_bytes{space="trusted_large_object"} 0

# HELP nodejs_heap_space_size_used_bytes Process heap space size used from Node.js in bytes.
# TYPE nodejs_heap_space_size_used_bytes gauge
nodejs_heap_space_size_used_bytes{space="read_only"} 0
nodejs_heap_space_size_used_bytes{space="new"} 729304
nodejs_heap_space_size_used_bytes{space="old"} 135560744
nodejs_heap_space_size_used_bytes{space="code"} 7106720
nodejs_heap_space_size_used_bytes{space="shared"} 0
nodejs_heap_space_size_used_bytes{space="trusted"} 6117336
nodejs_heap_space_size_used_bytes{space="shared_trusted"} 0
nodejs_heap_space_size_used_bytes{space="new_large_object"} 0
nodejs_heap_space_size_used_bytes{space="large_object"} 23674672
nodejs_heap_space_size_used_bytes{space="code_large_object"} 184416
nodejs_heap_space_size_used_bytes{space="shared_large_object"} 0
nodejs_heap_space_size_used_bytes{space="shared_trusted_large_object"} 0
nodejs_heap_space_size_used_bytes{space="trusted_large_object"} 0

# HELP nodejs_heap_space_size_available_bytes Process heap space size available from Node.js in bytes.
# TYPE nodejs_heap_space_size_available_bytes gauge
nodejs_heap_space_size_available_bytes{space="read_only"} 0
nodejs_heap_space_size_available_bytes{space="new"} 319208
nodejs_heap_space_size_available_bytes{space="old"} 11749040
nodejs_heap_space_size_available_bytes{space="code"} 2329312
nodejs_heap_space_size_available_bytes{space="shared"} 0
nodejs_heap_space_size_available_bytes{space="trusted"} 1366360
nodejs_heap_space_size_available_bytes{space="shared_trusted"} 0
nodejs_heap_space_size_available_bytes{space="new_large_object"} 1048576
nodejs_heap_space_size_available_bytes{space="large_object"} 0
nodejs_heap_space_size_available_bytes{space="code_large_object"} 0
nodejs_heap_space_size_available_bytes{space="shared_large_object"} 0
nodejs_heap_space_size_available_bytes{space="shared_trusted_large_object"} 0
nodejs_heap_space_size_available_bytes{space="trusted_large_object"} 0

# HELP nodejs_version_info Node.js version info.
# TYPE nodejs_version_info gauge
nodejs_version_info{version="v24.18.0",major="24",minor="18",patch="0"} 1

# HELP nodejs_gc_duration_seconds Garbage collection duration by kind, one of major, minor, incremental or weakcb.
# TYPE nodejs_gc_duration_seconds histogram
nodejs_gc_duration_seconds_bucket{le="0.001",kind="minor"} 6804
nodejs_gc_duration_seconds_bucket{le="0.01",kind="minor"} 30158
nodejs_gc_duration_seconds_bucket{le="0.1",kind="minor"} 30290
nodejs_gc_duration_seconds_bucket{le="1",kind="minor"} 30346
nodejs_gc_duration_seconds_bucket{le="2",kind="minor"} 30349
nodejs_gc_duration_seconds_bucket{le="5",kind="minor"} 30352
nodejs_gc_duration_seconds_bucket{le="+Inf",kind="minor"} 30352
nodejs_gc_duration_seconds_sum{kind="minor"} 88.8402733831408
nodejs_gc_duration_seconds_count{kind="minor"} 30352
nodejs_gc_duration_seconds_bucket{le="0.001",kind="incremental"} 363
nodejs_gc_duration_seconds_bucket{le="0.01",kind="incremental"} 504
nodejs_gc_duration_seconds_bucket{le="0.1",kind="incremental"} 508
nodejs_gc_duration_seconds_bucket{le="1",kind="incremental"} 510
nodejs_gc_duration_seconds_bucket{le="2",kind="incremental"} 510
nodejs_gc_duration_seconds_bucket{le="5",kind="incremental"} 510
nodejs_gc_duration_seconds_bucket{le="+Inf",kind="incremental"} 510
nodejs_gc_duration_seconds_sum{kind="incremental"} 1.992652451783419
nodejs_gc_duration_seconds_count{kind="incremental"} 510
nodejs_gc_duration_seconds_bucket{le="0.001",kind="major"} 0
nodejs_gc_duration_seconds_bucket{le="0.01",kind="major"} 511
nodejs_gc_duration_seconds_bucket{le="0.1",kind="major"} 518
nodejs_gc_duration_seconds_bucket{le="1",kind="major"} 523
nodejs_gc_duration_seconds_bucket{le="2",kind="major"} 523
nodejs_gc_duration_seconds_bucket{le="5",kind="major"} 523
nodejs_gc_duration_seconds_bucket{le="+Inf",kind="major"} 524
nodejs_gc_duration_seconds_sum{kind="major"} 10.815978210717455
nodejs_gc_duration_seconds_count{kind="major"} 524

# HELP reconciliation_mismatch_total Reconciliation mismatches detected per pass, by class (§6.4, backlog #24)
# TYPE reconciliation_mismatch_total counter
reconciliation_mismatch_total{class="sweep_failure"} 97914
reconciliation_mismatch_total{class="position_drift"} 1650
reconciliation_mismatch_total{class="adopted_terminal"} 1649

# HELP reconciliation_runs_total Reconciliation passes by venue and result (v3 spec §8 — one series per per-venue pass)
# TYPE reconciliation_runs_total counter
reconciliation_runs_total{venue="binance",result="mismatch"} 1679
reconciliation_runs_total{venue="all",result="skipped"} 64
reconciliation_runs_total{venue="binanceusdm",result="mismatch"} 27
reconciliation_runs_total{venue="binanceusdm",result="clean"} 2
reconciliation_runs_total{venue="binanceusdm",result="halt"} 1649

# HELP reconciliation_last_success_timestamp_seconds Unix time of the last clean (no-mismatch, not-halted) reconciliation pass (§8)
# TYPE reconciliation_last_success_timestamp_seconds gauge
reconciliation_last_success_timestamp_seconds 0

# HELP orders_total Orders submitted through the execution gate, by outcome
# TYPE orders_total counter

# HELP orders_rejected_total Orders rejected by the execution gate or venue, by stage and reason code
# TYPE orders_rejected_total counter

# HELP orders_submitted_total Orders successfully submitted to a venue, by type and time-in-force
# TYPE orders_submitted_total counter

# HELP orders_submitted_qty_total Total submitted quantity, by type and time-in-force (fill-rate denominator)
# TYPE orders_submitted_qty_total counter

# HELP order_submit_latency_seconds Submit→ack latency in seconds, by venue and order type (§8)
# TYPE order_submit_latency_seconds histogram

# HELP fills_total Fills ingested (non-duplicate) through the fill ingestor
# TYPE fills_total counter
fills_total 0

# HELP orders_filled_qty_total Total filled quantity, by type and time-in-force (fill-rate numerator)
# TYPE orders_filled_qty_total counter

# HELP orders_fully_filled_total Orders that reached FILLED, by type and time-in-force
# TYPE orders_fully_filled_total counter

# HELP order_slippage_decision_bps Execution vs signal reference price, signed bps, positive = adverse (§8 decision slippage)
# TYPE order_slippage_decision_bps histogram

# HELP fees_paid_total Fees paid across all fills, by fee currency (§8)
# TYPE fees_paid_total counter

# HELP round_trips_total Completed round trips by result (win = round-trip PnL > 0, else loss)
# TYPE round_trips_total counter

# HELP trade_pnl_usdt Realized PnL per completed round trip, USDT (net of quote fees); _sum/_count give cumulative + avg
# TYPE trade_pnl_usdt histogram
trade_pnl_usdt_bucket{le="-10"} 0
trade_pnl_usdt_bucket{le="-5"} 0
trade_pnl_usdt_bucket{le="-2"} 0
trade_pnl_usdt_bucket{le="-1"} 0
trade_pnl_usdt_bucket{le="-0.5"} 0
trade_pnl_usdt_bucket{le="-0.2"} 0
trade_pnl_usdt_bucket{le="0"} 0
trade_pnl_usdt_bucket{le="0.2"} 0
trade_pnl_usdt_bucket{le="0.5"} 0
trade_pnl_usdt_bucket{le="1"} 0
trade_pnl_usdt_bucket{le="2"} 0
trade_pnl_usdt_bucket{le="5"} 0
trade_pnl_usdt_bucket{le="10"} 0
trade_pnl_usdt_bucket{le="+Inf"} 0
trade_pnl_usdt_sum 0
trade_pnl_usdt_count 0

# HELP recovery_auto_resume_total Kill-switch auto-resumes dispatched by RecoveryCoordinatorService, by cause (owner-authorized recovery program, 2026-07-22)
# TYPE recovery_auto_resume_total counter

# HELP planned_stop_sizing_total Planned-stop entry risk cap outcomes (aggregate same-side cost-notional clamp or invalid stop)
# TYPE planned_stop_sizing_total counter

# HELP risk_rejections_total Risk-engine vetoes by reason code (§5/§8 rejection taxonomy, risk stage)
# TYPE risk_rejections_total counter

# HELP signals_rejected_total Signals rejected before risk evaluation, by front-door stage and reason
# TYPE signals_rejected_total counter

# HELP protective_exits_total Bot-enforced protective exits fired (stop-loss/trailing-stop/plan-stop watcher), by reason
# TYPE protective_exits_total counter

# HELP event_loop_delay_p99_seconds Event loop delay p99 in seconds
# TYPE event_loop_delay_p99_seconds gauge
event_loop_delay_p99_seconds 0.015384575

# HELP event_loop_utilization Event loop utilization ratio
# TYPE event_loop_utilization gauge
event_loop_utilization 0.01398450098641859

# HELP mode_info Trading mode info — requested is always env requestedMode (pre-test/ci override); effective is ModeControlPort.resolveMode().effective when MODE_CONTROL is bound (arming-aware), otherwise boot configMode.
# TYPE mode_info gauge
mode_info{requested="testnet",effective="testnet"} 1

# HELP boot_info Boot info
# TYPE boot_info gauge
boot_info{boot_id="4ff1fbe6-e646-429e-ba9d-882f60967e17"} 1

# HELP kill_switch_state Kill switch state (1 on the currently-active state label)
# TYPE kill_switch_state gauge
kill_switch_state{state="HALTED_DEGRADED"} 1

# HELP equity_usdt Account equity (cash + Σ position×mark), USDT
# TYPE equity_usdt gauge
equity_usdt 4978.035331235553

# HELP cash_usdt Free quote (USDT) balance
# TYPE cash_usdt gauge
cash_usdt 4800.76158429

# HELP peak_equity_usdt Peak equity high-water mark, USDT
# TYPE peak_equity_usdt gauge
peak_equity_usdt 5000.69547936

# HELP day_pnl_usdt Equity − start-of-day-UTC equity, USDT
# TYPE day_pnl_usdt gauge
day_pnl_usdt 0

# HELP drawdown_ratio (peak − equity) / peak, 0..1
# TYPE drawdown_ratio gauge
drawdown_ratio 0.004531399325948858

# HELP unrealized_pnl_usdt Unrealized PnL on open positions, Σ signedQty×(mark − avgEntry), USDT
# TYPE unrealized_pnl_usdt gauge
unrealized_pnl_usdt 0

# HELP starting_cash_usdt Seed baseline (PortfolioConfig.startingCash) — return-since-inception denominator, USDT
# TYPE starting_cash_usdt gauge
starting_cash_usdt 5000

# HELP realized_pnl_usdt Realized PnL per venue/strategy/symbol, USDT
# TYPE realized_pnl_usdt gauge
realized_pnl_usdt{venue="binance",strategy="agentic-6",symbol="ZEC/USDT"} -0.80692992
realized_pnl_usdt{venue="binance",strategy="agentic-7",symbol="AAVE/USDT"} -4.055773367180664
realized_pnl_usdt{venue="binance",strategy="agentic-1",symbol="BTC/USDT"} 0
realized_pnl_usdt{venue="binance",strategy="agentic-3",symbol="SOL/USDT"} 0
realized_pnl_usdt{venue="binanceusdm",strategy="agentic-25",symbol="BTC/USDT:USDT"} -0.05495884
realized_pnl_usdt{venue="binanceusdm",strategy="agentic-33",symbol="TRUMP/USDT:USDT"} -0.01599706

# HELP position_qty Signed position quantity per venue/strategy/symbol
# TYPE position_qty gauge
position_qty{venue="binance",strategy="agentic-6",symbol="ZEC/USDT"} 0.000903
position_qty{venue="binance",strategy="agentic-7",symbol="AAVE/USDT"} 0.000649
position_qty{venue="binance",strategy="agentic-1",symbol="BTC/USDT"} 0.00121878
position_qty{venue="binance",strategy="agentic-3",symbol="SOL/USDT"} 0.523476
position_qty{venue="binanceusdm",strategy="agentic-25",symbol="BTC/USDT:USDT"} 0.0021
position_qty{venue="binanceusdm",strategy="agentic-33",symbol="TRUMP/USDT:USDT"} -51.24

# HELP position_notional_usdt abs(position) × avgEntry per venue/strategy/symbol, USDT
# TYPE position_notional_usdt gauge
position_notional_usdt{venue="binance",strategy="agentic-6",symbol="ZEC/USDT"} 0.46361826
position_notional_usdt{venue="binance",strategy="agentic-7",symbol="AAVE/USDT"} 0.06252446535259379
position_notional_usdt{venue="binance",strategy="agentic-1",symbol="BTC/USDT"} 79.4420182602
position_notional_usdt{venue="binance",strategy="agentic-3",symbol="SOL/USDT"} 39.89410596
position_notional_usdt{venue="binanceusdm",strategy="agentic-25",symbol="BTC/USDT:USDT"} 137.39712
position_notional_usdt{venue="binanceusdm",strategy="agentic-33",symbol="TRUMP/USDT:USDT"} 79.98564

# HELP open_orders Open (resting) order count, by venue
# TYPE open_orders gauge
open_orders{venue="binance"} 3
open_orders{venue="binanceusdm"} 2

# HELP in_flight_intents In-flight (reserved) intent count, by venue
# TYPE in_flight_intents gauge
in_flight_intents{venue="binance"} 3
in_flight_intents{venue="binanceusdm"} 8

# HELP strategy_lifecycle Per-strategy lifecycle state (1 for current state, 0 for others)
# TYPE strategy_lifecycle gauge

# HELP agent_decide_total Agentic lane decide() outcomes
# TYPE agent_decide_total counter

# HELP agent_tokens_total Agentic lane LLM token usage, by kind and model
# TYPE agent_tokens_total counter

# HELP agent_decide_latency_seconds Agentic lane decide() latency in seconds
# TYPE agent_decide_latency_seconds histogram
agent_decide_latency_seconds_bucket{le="0.5"} 0
agent_decide_latency_seconds_bucket{le="1"} 0
agent_decide_latency_seconds_bucket{le="2"} 0
agent_decide_latency_seconds_bucket{le="5"} 0
agent_decide_latency_seconds_bucket{le="10"} 0
agent_decide_latency_seconds_bucket{le="15"} 0
agent_decide_latency_seconds_bucket{le="20"} 0
agent_decide_latency_seconds_bucket{le="30"} 0
agent_decide_latency_seconds_bucket{le="+Inf"} 0
agent_decide_latency_seconds_sum 0
agent_decide_latency_seconds_count 0

# HELP agentic_playbook_info Active agentic playbook version info (1 on the active version)
# TYPE agentic_playbook_info gauge
agentic_playbook_info{version="6"} 1

# HELP playbook_validator_rejections_total Playbook validator rejections, tagged by whether the denylist tripwire fired and which concept
# TYPE playbook_validator_rejections_total counter

# HELP agent_client_info Bound agentic client kind (1 on the active kind; stub = INERT, anthropic = LIVE)
# TYPE agent_client_info gauge
agent_client_info{kind="anthropic"} 1

# HELP agentic_consult_gate_total Consult-gate outcomes ahead of agentic LLM calls (consulted / skipped_scheduled / forced_fill / forced_move / forced_fallback / forced_rearm)
# TYPE agentic_consult_gate_total counter

# HELP agentic_reflection_outcomes_total Reflection loop attempt outcomes, labeled by the exit reason (bound closed set)
# TYPE agentic_reflection_outcomes_total counter

# HELP agentic_venue_tp_total Venue-resting take-profit lifecycle events (bound closed set — see VenueTpEvent), by venue
# TYPE agentic_venue_tp_total counter

# HELP agentic_venue_stop_total Venue-resting protective stop lifecycle events (bound closed set — see VenueStopEvent), by venue
# TYPE agentic_venue_stop_total counter

# HELP derivatives_feed_staleness_seconds Seconds since the derivatives feed last polled successfully (-1 if never)
# TYPE derivatives_feed_staleness_seconds gauge
derivatives_feed_staleness_seconds 31.638

# HELP derivatives_feed_poll_errors_total Cumulative derivatives-feed poll failures
# TYPE derivatives_feed_poll_errors_total counter
derivatives_feed_poll_errors_total 654

# HELP sentiment_feed_staleness_seconds Seconds since the sentiment feed last polled successfully (-1 if never)
# TYPE sentiment_feed_staleness_seconds gauge
sentiment_feed_staleness_seconds -1

# HELP sentiment_feed_poll_errors_total Cumulative sentiment-feed poll failures
# TYPE sentiment_feed_poll_errors_total counter
sentiment_feed_poll_errors_total 0

# HELP market_channel_staleness_seconds Seconds since each market-data websocket channel last delivered an event, by venue
# TYPE market_channel_staleness_seconds gauge

# HELP market_stream_forced_reconnects_total Watchdog-forced websocket reconnects after a channel (ticker/trade/book/candle) stalled silently, by venue
# TYPE market_stream_forced_reconnects_total counter

# HELP venue_free_cash_usdt Free quote/margin balance in each venue wallet (the split's observable), USDT
# TYPE venue_free_cash_usdt gauge
venue_free_cash_usdt{venue="binance"} 500
venue_free_cash_usdt{venue="binanceusdm"} 500

# HELP venue_capital_headroom_usdt Per-venue capital-split headroom: venueCap − open notional − reserved notional (spec §6.1), USDT
# TYPE venue_capital_headroom_usdt gauge
venue_capital_headroom_usdt{venue="binance"} 380.1377330544474
venue_capital_headroom_usdt{venue="binanceusdm"} 282.61724

# HELP funding_payments_ingested_total Perp funding-payment settlement rows ingested from the venue (FundingIngestService), by venue/symbol
# TYPE funding_payments_ingested_total counter
funding_payments_ingested_total{venue="binanceusdm",symbol="KAITO/USDT:USDT"} 1
funding_payments_ingested_total{venue="binanceusdm",symbol="BTC/USDT:USDT"} 6
funding_payments_ingested_total{venue="binanceusdm",symbol="XRP/USDT:USDT"} 1
funding_payments_ingested_total{venue="binanceusdm",symbol="HYPE/USDT:USDT"} 1
funding_payments_ingested_total{venue="binanceusdm",symbol="ZEC/USDT:USDT"} 1
funding_payments_ingested_total{venue="binanceusdm",symbol="NEAR/USDT:USDT"} 1
funding_payments_ingested_total{venue="binanceusdm",symbol="TRUMP/USDT:USDT"} 3

# HELP agentic_active_menu Universe scanner active-menu membership (1 on a symbol currently in the consulted menu; absent otherwise)
# TYPE agentic_active_menu gauge

# HELP agentic_menu_churn_total Universe scanner active-menu churn — symbols entering/leaving the menu per recompute, by direction
# TYPE agentic_menu_churn_total counter

# HELP agentic_budget_remaining_usd Remaining daily LLM spend budget (USD) before the cost breaker trips — DailyLlmBudget.budgetBlock(), ONE shared lane-wide cap (not per-strategy: AGENT_LLM_BUDGET is a single instance shared across all strategy instances in this process)
# TYPE agentic_budget_remaining_usd gauge
agentic_budget_remaining_usd 0

# HELP agentic_capability_violations_total Per-symbol capability violations degraded to hold by the client zod layer (spec §4.3), by kind
# TYPE agentic_capability_violations_total counter

# HELP agentic_schema_rejections_total Per-call tool-payload schema rejections degraded to hold by the client zod layer, by kind
# TYPE agentic_schema_rejections_total counter

# HELP agentic_reflection_trigger_total ReflectionService.evaluateTrigger exits, by outcome (below_threshold/cooldown/inflight/fired)
# TYPE agentic_reflection_trigger_total counter

# HELP agentic_rearm_fallback_total Synthetic protective plans attached when a positioned consult returned hold/adjust without directives
# TYPE agentic_rearm_fallback_total counter
agentic_rearm_fallback_total 0

# HELP agentic_promotion_round_trips Closed demo round trips counted toward the earned-live promotion gate
# TYPE agentic_promotion_round_trips gauge
agentic_promotion_round_trips 19

# HELP agentic_promotion_win_rate Fraction of closed demo round trips with per-trip net (realized − fees) > 0 over the promotion evidence window (0..1)
# TYPE agentic_promotion_win_rate gauge
agentic_promotion_win_rate 0.15789473684210525

# HELP agentic_promotion_net_pnl_usd Net-of-cost PnL (realized − fees − LLM spend) over the promotion evidence window, USD
# TYPE agentic_promotion_net_pnl_usd gauge
agentic_promotion_net_pnl_usd -37.0348846298

# HELP agentic_promotion_llm_cost_usd LLM spend (decide + reflection tokens, priced) counted against promotion evidence, USD
# TYPE agentic_promotion_llm_cost_usd gauge
agentic_promotion_llm_cost_usd 14.1675074

# HELP agentic_promotion_window_days Span (days) between the first and last closed demo round trip in the evidence set
# TYPE agentic_promotion_window_days gauge
agentic_promotion_window_days 1.6895980787037037

# HELP agentic_promotion_ready Earned-live promotion verdict (1 = permitted, 0 = not permitted)
# TYPE agentic_promotion_ready gauge
agentic_promotion_ready 0

# HELP agentic_version_net_pnl_usd Realized net PnL (per-cycle realized − per-cycle fees) attributed to the playbook version active at each round trip entry, USD
# TYPE agentic_version_net_pnl_usd gauge
agentic_version_net_pnl_usd{version="1"} -1.01960776
agentic_version_net_pnl_usd{version="2"} -18.96323791
agentic_version_net_pnl_usd{version="7"} -0.7408758
agentic_version_net_pnl_usd{version="3"} -3.1940906
agentic_version_net_pnl_usd{version="6"} 1.4377259

# HELP agentic_version_round_trips Closed demo round trips attributed to the playbook version active at entry
# TYPE agentic_version_round_trips gauge
agentic_version_round_trips{version="1"} 3
agentic_version_round_trips{version="2"} 11
agentic_version_round_trips{version="7"} 1
agentic_version_round_trips{version="3"} 1
agentic_version_round_trips{version="6"} 3
```
