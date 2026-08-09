import { Module } from '@nestjs/common';

import { InfrastructureModule } from '../../infrastructure/infrastructure.module';

import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [InfrastructureModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
