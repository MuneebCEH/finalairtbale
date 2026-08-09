import { Module } from '@nestjs/common';

import { InfrastructureModule } from '../../infrastructure/infrastructure.module';

import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [InfrastructureModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
