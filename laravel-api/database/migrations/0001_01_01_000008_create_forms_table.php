<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Forms — a public page that writes into one table. `config` holds the ordered field list (with
 * per-field required/hidden/label overrides), the submit-button text, and the confirmation
 * message. `slug` is the public, unguessable id used in the shareable link `/v1/f/{slug}`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('forms', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // frm_<ULID>
            $table->char('organization_id', 30);
            $table->char('base_id', 30);
            $table->char('table_id', 30);
            $table->string('title', 200);
            $table->text('description')->nullable();
            $table->string('slug', 40)->unique();
            $table->json('config');
            $table->boolean('is_published')->default(false);
            $table->integer('submission_count')->default(0);
            $table->char('created_by', 30)->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['table_id', 'deleted_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('forms');
    }
};
