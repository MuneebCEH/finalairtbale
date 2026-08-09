import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { SCOPES } from '@tessera/types';
import type { TenantContext } from '@tessera/types';
import { z } from 'zod';

import { CurrentTenant, RateLimit, RequiresAction } from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { TokensService } from './tokens.service';

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    scopes: z.array(z.enum(SCOPES as unknown as [string, ...string[]])).min(1).max(SCOPES.length),
    baseIds: z.array(z.string().max(30)).max(100).optional(),
    // Bounded: a token that never expires is one nobody ever reviews.
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

@Controller({ version: '1' })
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get('organizations/:orgId/api-tokens')
  @RequiresAction('api_token:manage')
  async list(@CurrentTenant() tenant: TenantContext) {
    return { data: await this.tokens.list(tenant) };
  }

  @Post('organizations/:orgId/api-tokens')
  @RequiresAction('api_token:manage')
  @RateLimit('authenticatedWrite')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body(zodBody(createSchema)) input: z.infer<typeof createSchema>,
  ) {
    return { data: await this.tokens.create(tenant, input) };
  }

  @Delete('organizations/:orgId/api-tokens/:tokenId')
  @RequiresAction('api_token:manage')
  @RateLimit('authenticatedWrite')
  async revoke(@CurrentTenant() tenant: TenantContext, @Param('tokenId') tokenId: string) {
    return { data: await this.tokens.revoke(tenant, tokenId) };
  }
}
