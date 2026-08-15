<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Saved views — a named way of looking at one table. `type` is grid/kanban/calendar/…; `config`
 * holds what the toolbar builds: filter tree, sorts, groups, hidden field ids, row height. Views
 * belong to the table (collaborative, Airtable-style), so everyone sees the same list.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('views', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // viw_<ULID>
            $table->char('organization_id', 30);
            $table->char('table_id', 30);
            $table->string('name', 120);
            $table->string('type', 20)->default('grid');
            $table->json('config')->nullable();
            $table->integer('position')->default(0);
            $table->char('created_by', 30)->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->index(['table_id', 'deleted_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('views');
    }
};
