import { pool } from "./db";
import { runSimulation } from "./processor";
import { randomUUID } from "crypto";

const WORKER_ID = process.env.WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;
const LEASE_SECONDS = parseInt(process.env.LEASE_SECONDS || "15", 10);
const POLL_INTERVAL_MS = 500;

function backoffSeconds(attempt: number) {
  return Math.min(60, 2 ** attempt);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Atomically claims either a fresh 'pending' event or a 'processing' event
// whose lease has expired (i.e. its previous worker likely crashed).
// FOR UPDATE SKIP LOCKED means two workers running this at once never pick the same row.
async function claimEvent() {
  const { rows } = await pool.query(
    `
    UPDATE events
    SET status = 'processing', worker_id = $1, lease_expires_at = now() + ($2 || ' seconds')::interval
    WHERE event_id = (
      SELECT event_id FROM events
      WHERE (status = 'pending' AND next_attempt_at <= now())
         OR (status = 'processing' AND lease_expires_at < now())
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
    `,
    [WORKER_ID, LEASE_SECONDS]
  );
  return rows[0] ?? null;
}

async function recordSuccess(
  event: any,
  attemptNumber: number,
  startedAt: Date
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO attempts (event_id, attempt_number, worker_id, started_at, finished_at, result)
       VALUES ($1, $2, $3, $4, now(), 'success')`,
      [event.event_id, attemptNumber, WORKER_ID, startedAt]
    );
    // ON CONFLICT guards against a retried/reclaimed event ever producing
    // a second processed_orders row for the same event_id.
    await client.query(
      `INSERT INTO processed_orders (order_id, event_id)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.data.orderId, event.event_id]
    );
    await client.query(
      `UPDATE events SET status = 'succeeded', attempt_count = $2,
              worker_id = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE event_id = $1`,
      [event.event_id, attemptNumber]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function recordFailure(
  event: any,
  attemptNumber: number,
  startedAt: Date,
  err: any
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO attempts (event_id, attempt_number, worker_id, started_at, finished_at, result, error)
       VALUES ($1, $2, $3, $4, now(), 'failure', $5)`,
      [
        event.event_id,
        attemptNumber,
        WORKER_ID,
        startedAt,
        String(err?.message ?? err),
      ]
    );
    if (attemptNumber >= event.max_attempts) {
      await client.query(
        `UPDATE events SET status = 'failed_permanent', attempt_count = $2,
                worker_id = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE event_id = $1`,
        [event.event_id, attemptNumber]
      );
    } else {
      await client.query(
        `UPDATE events SET status = 'pending', attempt_count = $2,
                worker_id = NULL, lease_expires_at = NULL,
                next_attempt_at = now() + ($3 || ' seconds')::interval, updated_at = now()
         WHERE event_id = $1`,
        [event.event_id, attemptNumber, backoffSeconds(attemptNumber)]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function loop() {
  console.log(`${WORKER_ID} starting`);
  while (true) {
    let event;
    try {
      event = await claimEvent();
    } catch (e) {
      console.error("claim error", e);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (!event) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const attemptNumber = event.attempt_count + 1;
    const startedAt = new Date();
    console.log(
      `${WORKER_ID} claimed ${event.event_id} attempt ${attemptNumber}`
    );
    try {
      await runSimulation(event.data, attemptNumber);
      await recordSuccess(event, attemptNumber, startedAt);
      console.log(`${WORKER_ID} succeeded ${event.event_id}`);
    } catch (err) {
      await recordFailure(event, attemptNumber, startedAt, err);
      console.log(
        `${WORKER_ID} failed ${event.event_id}: ${(err as Error).message}`
      );
    }
  }
}

loop();
