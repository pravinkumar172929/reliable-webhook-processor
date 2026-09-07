import { Body, Controller, Post } from "@nestjs/common";
import { pool } from "./db";

@Controller("webhooks")
export class WebhooksController {
  @Post()
  async ingest(@Body() body: any) {
    const { eventId, type, data } = body;
    if (!eventId || !type) {
      return { error: "eventId and type are required" };
    }
    // ON CONFLICT DO NOTHING makes this safe even if the same eventId
    // arrives from two simultaneous requests — the PK enforces one row.
    await pool.query(
      `INSERT INTO events (event_id, type, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, type, data ?? {}]
    );
    return { accepted: true, eventId };
  }
}
