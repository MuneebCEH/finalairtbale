import { Module } from '@nestjs/common';

import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AutomationsController } from '../automations/automations.controller';
import { AutomationsService } from '../automations/automations.service';
import { FieldsController } from '../fields/fields.controller';
import { FieldsService } from '../fields/fields.service';
import { FormsController, PublicFormsController } from '../forms/forms.controller';
import { FormsService } from '../forms/forms.service';
import { HistoryController } from '../records/history.controller';
import { HistoryService } from '../records/history.service';
import { RecordsController } from '../records/records.controller';
import { RecordsService } from '../records/records.service';
import { ViewsController } from '../views/views.controller';
import { ViewsService } from '../views/views.service';

import { BasesController } from './bases.controller';
import { BasesService } from './bases.service';

/**
 * The data domain: bases, tables, fields and records.
 *
 * One module rather than four, because these four are a single unit of meaning — creating a base
 * creates a table which creates a field, and a record cannot be validated without its table's
 * fields. Splitting them would mean three modules importing each other in a cycle, which is the
 * usual signal that the boundary was drawn in the wrong place.
 */
@Module({
  imports: [InfrastructureModule, AttachmentsModule],
  controllers: [BasesController, FieldsController, RecordsController, HistoryController, ViewsController, FormsController, PublicFormsController, AutomationsController],
  providers: [BasesService, FieldsService, RecordsService, HistoryService, ViewsService, FormsService, AutomationsService],
  exports: [BasesService, FieldsService, RecordsService],
})
export class DataModule {}
