import { Global, Module } from '@nestjs/common';

import { InfrastructureModule } from '../../infrastructure/infrastructure.module';

import { RealtimeAuthorizer } from './realtime.authorizer';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Global so any module that mutates data can publish a delta without importing this one.
 *
 * The alternative — importing it into every feature module — makes the realtime concern a
 * dependency of the whole graph, which is how a circular import between records and realtime
 * eventually appears.
 */
@Global()
@Module({
  imports: [InfrastructureModule],
  providers: [RealtimeGateway, RealtimeAuthorizer],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
