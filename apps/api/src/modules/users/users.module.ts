import { Module } from '@nestjs/common';

import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { AuthModule } from '../auth/auth.module';

import { UsersController } from './users.controller';

@Module({
  imports: [InfrastructureModule, AuthModule],
  controllers: [UsersController],
})
export class UsersModule {}
