<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Record comments and file attachments — enough of Phase 5 to keep the frontend fully navigable. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('comments', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // cmt_<ULID>
            $table->char('organization_id', 30);
            $table->char('record_id', 30);
            $table->char('table_id', 30);
            $table->char('author_id', 30)->nullable();
            $table->json('body');                            // validated rich-text doc tree
            $table->boolean('resolved')->default(false);
            $table->timestamps();
            $table->softDeletes();

            $table->index(['record_id', 'created_at']);
        });

        Schema::create('attachments', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // att_<ULID>
            $table->char('organization_id', 30);
            $table->char('base_id', 30);
            $table->string('filename', 255);
            $table->string('mime_type', 128);
            $table->bigInteger('size');
            $table->string('storage_disk', 32)->default('local');
            $table->text('storage_path');
            $table->string('scan_status', 16)->default('clean');
            $table->char('created_by', 30)->nullable();
            $table->timestamps();

            $table->index(['base_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('attachments');
        Schema::dropIfExists('comments');
    }
};
