import { Pool } from "pg";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/webhooks",
});

beforeAll(async () => {
  await pool.query(`DELETE FROM processed_orders`);
  await pool.query(`DELETE FROM attempts`);
  await pool.query(`DELETE FROM events`);
});

afterAll(async () => pool.end());

test("concurrent duplicate webhook submissions result in exactly one event row", async () => {
  const eventId = "evt_test_dup_1";
  const insertOnce = () =>
    pool.query(
      `INSERT INTO events (event_id, type, data) VALUES ($1, 'order.created', $2) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, { orderId: "ORD-1", simulate: "ok" }]
    );

  await Promise.all([
    insertOnce(),
    insertOnce(),
    insertOnce(),
    insertOnce(),
    insertOnce(),
  ]);

  const { rows } = await pool.query(
    `SELECT * FROM events WHERE event_id = $1`,
    [eventId]
  );
  expect(rows.length).toBe(1);
});

test("two workers claiming concurrently never claim the same pending event", async () => {
  const ids = ["evt_test_claim_a", "evt_test_claim_b"];
  for (const id of ids) {
    await pool.query(
      `INSERT INTO events (event_id, type, data) VALUES ($1, 'order.created', $2) ON CONFLICT (event_id) DO NOTHING`,
      [id, { orderId: id, simulate: "ok" }]
    );
  }

  const claim = (workerId: string) =>
    pool.query(
      `
      UPDATE events
      SET status = 'processing', worker_id = $1, lease_expires_at = now() + interval '15 seconds'
      WHERE event_id = (
        SELECT event_id FROM events
        WHERE status = 'pending' AND next_attempt_at <= now() AND event_id = ANY($2)
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING event_id
      `,
      [workerId, ids]
    );

  const [r1, r2] = await Promise.all([claim("worker-a"), claim("worker-b")]);
  const claimed = [...r1.rows, ...r2.rows].map((r) => r.event_id);
  expect(new Set(claimed).size).toBe(claimed.length);
});
