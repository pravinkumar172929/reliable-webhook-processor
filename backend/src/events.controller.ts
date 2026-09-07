import { Controller, Get, Param, Post } from "@nestjs/common";
import { pool } from "./db";

@Controller("events")
export class EventsController {
  @Get()
  async list() {
    const { rows } = await pool.query(`
      SELECT event_id, type, status, attempt_count, max_attempts, created_at, updated_at
      FROM events
      ORDER BY created_at DESC
      LIMIT 500
    `);
    return rows;
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    const event = await pool.query(`SELECT * FROM events WHERE event_id = $1`, [
      id,
    ]);
    const attempts = await pool.query(
      `SELECT * FROM attempts WHERE event_id = $1 ORDER BY attempt_number ASC`,
      [id]
    );
    const processed = await pool.query(
      `SELECT * FROM processed_orders WHERE event_id = $1`,
      [id]
    );
    return {
      event: event.rows[0] ?? null,
      attempts: attempts.rows,
      processedOrder: processed.rows[0] ?? null,
    };
  }

  @Post(":id/retry")
  async retry(@Param("id") id: string) {
    const { rows } = await pool.query(
      `UPDATE events
       SET status = 'pending', attempt_count = 0, next_attempt_at = now(),
           worker_id = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE event_id = $1 AND status = 'failed_permanent'
       RETURNING event_id`,
      [id]
    );
    if (rows.length === 0) {
      return {
        retried: false,
        reason: "event not found or not in failed_permanent state",
      };
    }
    return { retried: true, eventId: id };
  }
}
