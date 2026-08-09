import { Controller, Get, Param, Query } from '@nestjs/common';
import { AppError, type TenantContext } from '@tessera/types';

import { CurrentTenant, RequiresAction } from '../../bootstrap/decorators';

import { HistoryService } from './history.service';

@Controller({ version: '1' })
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get('records/:recordId/history')
  @RequiresAction('record:read')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Param('recordId') recordId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const parsedLimit = Number(limit);
    const parsedBefore = Number(before);

    return {
      data: await this.history.list(tenant, recordId, {
        ...(Number.isFinite(parsedLimit) && parsedLimit > 0 ? { limit: parsedLimit } : {}),
        ...(Number.isFinite(parsedBefore) ? { before: parsedBefore } : {}),
      }),
    };
  }

  @Get('records/:recordId/history/:version')
  @RequiresAction('record:read')
  async stateAt(
    @CurrentTenant() tenant: TenantContext,
    @Param('recordId') recordId: string,
    @Param('version') version: string,
  ) {
    const parsed = Number(version);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new AppError('MALFORMED_REQUEST', 'A version is a whole number from 1.');
    }
    return { data: await this.history.stateAt(tenant, recordId, parsed) };
  }

  @Get('tables/:tableId/activity')
  @RequiresAction('record:read')
  async forTable(
    @CurrentTenant() tenant: TenantContext,
    @Param('tableId') tableId: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    return {
      data: await this.history.forTable(tenant, tableId, {
        ...(Number.isFinite(parsed) && parsed > 0 ? { limit: parsed } : {}),
      }),
    };
  }
}
