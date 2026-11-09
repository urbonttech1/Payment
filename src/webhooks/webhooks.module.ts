import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { PayeesModule } from '../payees/payees.module';
import { WEBHOOK_EVENTS_REPOSITORY } from './webhook-events.repository';
import { PgWebhookEventsRepository } from './webhook-events.pg.repository';
import { UrbontApiClient } from './urbont-api.client';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [ProvidersModule, PayeesModule],
  controllers: [WebhooksController],
  providers: [
    { provide: WEBHOOK_EVENTS_REPOSITORY, useClass: PgWebhookEventsRepository },
    UrbontApiClient,
    WebhooksService,
  ],
  exports: [WebhooksService],
})
export class WebhooksModule {}
