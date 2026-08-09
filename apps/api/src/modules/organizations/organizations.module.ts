import { Module } from '@nestjs/common';

import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { TokensController } from '../tokens/tokens.controller';
import { TokensService } from '../tokens/tokens.service';

import { InvitationsController, OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  imports: [InfrastructureModule],
  controllers: [OrganizationsController, InvitationsController, TokensController],
  providers: [OrganizationsService, TokensService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
