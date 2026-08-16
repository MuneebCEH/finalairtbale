<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Automations — "when X happens on this table, do Y". `trigger_type` is record_created /
 * record_updated / record_matches; `trigger_config` holds the match conditions; `actions` is an
 * ordered list of {type, config} steps (update_record, create_record, webhook, send_email).
 * Runs are counted rather than logged row-by-row — a medical base does not need an audit table
 * growing by every automation firing.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('automations', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // aut_<ULID>
            $table->char('organization_id', 30);
            $table->char('base_id', 30);
            $table->char('table_id', 30);
            $table->string('name', 120);
            $table->boolean('enabled')->default(false);
            $table->string('trigger_type', 40)->default('record_created');
            $table->json('trigger_config')->nullable();
            $table->json('actions');
            $table->integer('run_count')->default(0);
            $table->dateTime('last_run_at')->nullable();
            $table->char('created_by', 30)->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['table_id', 'enabled', 'deleted_at']);
            $table->index(['base_id', 'deleted_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('automations');
    }
};
