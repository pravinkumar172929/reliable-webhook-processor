import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { EventsController } from "./events.controller";

@Module({
  controllers: [WebhooksController, EventsController],
})
export class AppModule {}
