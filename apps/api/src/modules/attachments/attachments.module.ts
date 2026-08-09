import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { loadEnv } from '@tessera/config';

import { InfrastructureModule } from '../../infrastructure/infrastructure.module';

import { AttachmentsController, FilesController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  imports: [
    InfrastructureModule,
    /*
     * A ceiling at the parser, in front of the one in `store()`.
     *
     * Without it the whole body is read into memory before anything gets to reject it, so a
     * handful of concurrent multi-gigabyte posts would exhaust the process regardless of what the
     * service later decides. `files: 1` matters for the same reason: the field accepts one file,
     * and without the cap a request could carry thousands.
     */
    MulterModule.register({
      limits: { fileSize: loadEnv().MAX_UPLOAD_BYTES, files: 1 },
    }),
  ],
  controllers: [AttachmentsController, FilesController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
