import { Module } from '@nestjs/common';

import { InfrastructureModule } from '../../infrastructure/infrastructure.module';

import { HealthController } from './health.controller';

@Module({
  imports: [InfrastructureModule],
  controllers: [HealthController],
})
export class HealthModule {}
