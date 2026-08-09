import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AuthGuard } from './bootstrap/auth.guard';
import { ErrorFilter } from './bootstrap/error.filter';
import { PolicyGuard } from './bootstrap/policy.guard';
import { RateLimitGuard } from './bootstrap/rate-limit.guard';
import { RequestContextMiddleware } from './bootstrap/request-context.middleware';
import { TenantGuard } from './bootstrap/tenant.guard';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { AuthModule } from './modules/auth/auth.module';
import { DataModule } from './modules/bases/bases.module';
import { CommentsModule } from './modules/comments/comments.module';
import { HealthModule } from './modules/health/health.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { UsersModule } from './modules/users/users.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';

/**
 * The guards below are registered **globally and in this order**, which is the pipeline described
 * in docs/01-system-architecture.md §3:
 *
 *   RateLimit → Auth → Tenant → Policy
 *
 * The order matters and is not arbitrary:
 *   • Rate limiting runs first so a flood is rejected before it costs a database query.
 *   • Authentication before tenancy, because the tenant guard must prove *this principal's*
 *     membership.
 *   • Tenancy before policy, because the policy engine evaluates against a resolved tenant.
 *
 * Registering them globally rather than per-controller is the point: protection is the default
 * and must be explicitly opted out of with `@Public()` / `@SkipTenantScope()`, both of which are
 * greppable and reviewed. The opposite arrangement makes every forgotten decorator a hole.
 */
@Module({
  imports: [
    InfrastructureModule,
    HealthModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    WorkspacesModule,
    DataModule,
    AttachmentsModule,
    RealtimeModule,
    NotificationsModule,
    CommentsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
