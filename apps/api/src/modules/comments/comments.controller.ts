import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AppError, type TenantContext } from '@tessera/types';
import { richTextDocumentSchema } from '@tessera/validation';
import { z } from 'zod';

import { CurrentTenant, RateLimit, RequiresAction } from '../../bootstrap/decorators';
import { zodBody } from '../../bootstrap/zod.pipe';

import { CommentsService } from './comments.service';

const createSchema = z
  .object({
    body: richTextDocumentSchema,
    parentId: z.string().max(30).optional(),
    fieldId: z.string().max(30).optional(),
  })
  .strict();

const updateSchema = z.object({ body: richTextDocumentSchema }).strict();

const resolveSchema = z.object({ resolved: z.boolean() }).strict();

const reactionSchema = z
  .object({
    // Length-bounded rather than validated against an emoji list: the set grows every Unicode
    // release, and a bound is what actually prevents abuse of the column.
    emoji: z.string().min(1).max(16),
    on: z.boolean(),
  })
  .strict();

@Controller({ version: '1' })
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('records/:recordId/comments')
  @RequiresAction('record:read')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Param('recordId') recordId: string,
    @Query('includeResolved') includeResolved?: string,
  ) {
    return { data: await this.comments.list(tenant, recordId, {
      includeResolved: includeResolved === 'true',
    }) };
  }

  @Post('records/:recordId/comments')
  // Commenting needs read access to the record, not write: a reviewer who may not edit data is
  // exactly the person a comment thread exists for.
  @RequiresAction('record:read')
  @RateLimit('authenticatedWrite')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Param('recordId') recordId: string,
    @Body(zodBody(createSchema)) input: z.infer<typeof createSchema>,
  ) {
    return { data: await this.comments.create(tenant, recordId, input) };
  }

  @Patch('comments/:commentId')
  @RequiresAction('record:read')
  @RateLimit('authenticatedWrite')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('commentId') commentId: string,
    @Body(zodBody(updateSchema)) input: z.infer<typeof updateSchema>,
  ) {
    return { data: await this.comments.update(tenant, commentId, input.body) };
  }

  @Delete('comments/:commentId')
  @RequiresAction('record:read')
  @RateLimit('authenticatedWrite')
  async remove(@CurrentTenant() tenant: TenantContext, @Param('commentId') commentId: string) {
    return { data: await this.comments.remove(tenant, commentId) };
  }

  @Post('comments/:commentId/resolve')
  @RequiresAction('record:read')
  @RateLimit('authenticatedWrite')
  async resolve(
    @CurrentTenant() tenant: TenantContext,
    @Param('commentId') commentId: string,
    @Body(zodBody(resolveSchema)) input: z.infer<typeof resolveSchema>,
  ) {
    return { data: await this.comments.resolve(tenant, commentId, input.resolved) };
  }

  @Post('comments/:commentId/reactions')
  @RequiresAction('record:read')
  @RateLimit('authenticatedWrite')
  async react(
    @CurrentTenant() tenant: TenantContext,
    @Param('commentId') commentId: string,
    @Body(zodBody(reactionSchema)) input: z.infer<typeof reactionSchema>,
  ) {
    if (input.emoji.trim() === '') throw new AppError('VALIDATION_FAILED', 'That is not a reaction.');
    return { data: await this.comments.react(tenant, commentId, input.emoji, input.on) };
  }
}
