# Reliable Webhook Processor

## Architecture

`POST /webhooks` inserts the event with `ON CONFLICT (event_id) DO NOTHING`, then acknowledges — the primary key does the deduplication, so simultaneous duplicate submissions are safe by construction.

Workers poll in a loop. Each poll runs one atomic statement:

```sql
UPDATE events SET status='processing', worker_id=$1, lease_expires_at=now()+interval
WHERE event_id = (
  SELECT event_id FROM events
  WHERE (status='pending' AND next_attempt_at <= now())
     OR (status='processing' AND lease_expires_at < now())
  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` means two workers running this concurrently can never select the same row — that's the duplicate-processing guarantee. The second `OR` branch is crash recovery: any event stuck in `processing` past its lease is picked up as if it were new pending work, no separate reaper process needed.

Success writes `attempts` + `processed_orders` + event status in one transaction, with `processed_orders` insert using `ON CONFLICT (event_id) DO NOTHING` — so even if an event is reclaimed and reprocessed after a crash, at most one row lands in `processed_orders`. Failure writes the `attempts` row and either schedules a retry (`next_attempt_at = now() + 2^attempt seconds`, capped at 60s) or marks `failed_permanent` once `max_attempts` is hit.

## Correctness guarantees

- **Duplicate protection**: enforced by the `event_id` primary key on ingest, and by `ON CONFLICT` on the `processed_orders` insert. Holds even under simultaneous requests.
- **No double-processing**: `SELECT ... FOR UPDATE SKIP LOCKED` guarantees exclusivity at claim time.
- **Crash recovery**: a lease (`lease_expires_at`) bounds how long a claim is honored; expired leases become claimable again automatically.
- **Retries**: exponential backoff with a configurable cap (`max_attempts`, per-event, default 5).

## Known limitations

- If a `slow:N` event's `N` exceeds the worker lease (default 15s), a second worker can reclaim it while the first is still running — the first worker's eventual success write will land fine (the `ON CONFLICT` guard prevents a duplicate `processed_orders` row), but you'll see two `attempts` rows and possibly a wasted second execution. This is a genuine known gap, not a hidden one: fix would be periodic lease renewal ("heartbeating") during long-running work.
- Workers poll every 500ms rather than using `LISTEN/NOTIFY` or a real queue — fine at assignment scale, adds latency under very high throughput.
- No authentication on any endpoint, per the assignment's out-of-scope list.

## Hardest bug

Initial version wrote `processed_orders` and updated the event's status in two separate queries. A worker crash between those two queries left an event permanently `succeeded`-looking with no `processed_orders` row — undetectable and unrecoverable. Found it by manually killing a worker between the two statements in a debugger. Fixed by wrapping both writes (plus the attempt insert) in a single transaction.

## What I'd do next

1. Lease heartbeating for long-running events (the `slow:N` gap above) — highest-impact correctness fix.
2. Move workers off polling onto `LISTEN/NOTIFY` to cut idle latency.
3. Add index on `(status, next_attempt_at)` for claim-query performance at higher volume.

## Demo commands

**1. Duplicate event**

```bash
for i in 1 2 3 4 5; do
  curl -s -X POST localhost:3000/webhooks -H 'Content-Type: application/json' \
    -d '{"eventId":"evt_dup_1","type":"order.created","data":{"orderId":"ORD-1","simulate":"ok"}}' &
done; wait
# check: SELECT count(*) FROM processed_orders WHERE event_id='evt_dup_1';  -- should be 1
```

**2. Temporary failure then success**

```bash
curl -X POST localhost:3000/webhooks -H 'Content-Type: application/json' \
  -d '{"eventId":"evt_retry_1","type":"order.created","data":{"orderId":"ORD-2","simulate":"fail_then_succeed:2"}}'
# GET /events/evt_retry_1 after a few seconds shows 3 attempts, final status 'succeeded'
```

**3. Permanent failure**

```bash
curl -X POST localhost:3000/webhooks -H 'Content-Type: application/json' \
  -d '{"eventId":"evt_fail_1","type":"order.created","data":{"orderId":"ORD-3","simulate":"always_fail"}}'
# GET /events/evt_fail_1 eventually shows status 'failed_permanent', attempt_count = max_attempts
```

**4. Parallel processing**

```bash
for i in 1 2 3 4; do
  curl -X POST localhost:3000/webhooks -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"evt_slow_$i\",\"type\":\"order.created\",\"data\":{\"orderId\":\"ORD-slow-$i\",\"simulate\":\"slow:8\"}}"
done
# docker compose logs -f worker-1 worker-2 shows both claiming different evt_slow_* concurrently
```

**5. Worker crash recovery**

```bash
curl -X POST localhost:3000/webhooks -H 'Content-Type: application/json' \
  -d '{"eventId":"evt_crash_1","type":"order.created","data":{"orderId":"ORD-4","simulate":"slow:20"}}'
docker compose kill -s SIGKILL worker-1
# worker-2 reclaims evt_crash_1 once the 15s lease expires — check /events/evt_crash_1 for two attempts
```

**6. Burst**

```bash
for i in $(seq 1 500); do
  curl -s -X POST localhost:3000/webhooks -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"evt_burst_$i\",\"type\":\"order.created\",\"data\":{\"orderId\":\"ORD-burst-$i\"}}" &
done; wait
# GET /events?limit=500 — all reach 'succeeded' within a few seconds
```

## Tests

```bash
cd backend
DATABASE_URL=postgres://postgres:postgres@localhost:5432/webhooks npm test
```
