<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Revision history — one row per user edit of a record, holding only the DIFF
 * ({fieldId: {from, to}}), not a full snapshot: a medical table edited all day must not double
 * the database. `kind` is created/updated/restored so the timeline reads as a story.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('record_revisions', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // rev_<ULID>
            $table->char('organization_id', 30);
            $table->char('table_id', 30);
            $table->char('record_id', 30);
            $table->char('user_id', 30)->nullable();
            $table->string('kind', 20)->default('updated');
            $table->json('changes')->nullable();
            $table->dateTime('created_at');

            $table->index(['record_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('record_revisions');
    }
};
