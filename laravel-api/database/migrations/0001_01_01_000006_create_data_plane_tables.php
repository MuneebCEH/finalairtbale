<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The data plane: bases, tables, fields, and records — translated from Prisma.
 *
 * Records use the hybrid storage model (docs/02 §1): every value lives in the `data` JSON keyed by
 * field id, and a field may additionally be "promoted" into a typed slot column (s0-s3 text,
 * n0-n3 decimal, d0-d2 datetime, b0-b1 boolean) so the columns people filter and sort on get real
 * indexes. Postgres JSONB becomes MySQL/MariaDB JSON.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('bases', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // bas_<ULID>
            $table->char('organization_id', 30);
            $table->char('workspace_id', 30);
            $table->string('name', 120);
            $table->text('description')->nullable();
            $table->string('icon', 64)->nullable();
            $table->char('color', 7)->nullable();
            $table->integer('position')->default(0);
            $table->integer('schema_version')->default(1);
            $table->char('template_id', 30)->nullable();
            $table->dateTime('archived_at')->nullable();
            $table->char('created_by_id', 30);
            $table->timestamps();
            $table->softDeletes();

            $table->index(['organization_id', 'workspace_id', 'deleted_at']);
            $table->foreign('workspace_id')->references('id')->on('workspaces')->cascadeOnDelete();
        });

        Schema::create('tables', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // tbl_<ULID>
            $table->char('organization_id', 30);
            $table->char('base_id', 30);
            $table->string('name', 120);
            $table->text('description')->nullable();
            $table->string('icon', 64)->nullable();
            $table->char('color', 7)->nullable();
            $table->integer('position')->default(0);
            $table->char('primary_field_id', 30)->nullable();
            $table->bigInteger('data_version')->default(1);
            $table->integer('record_count')->default(0);
            $table->bigInteger('auto_number_seq')->default(0);
            $table->dateTime('hidden_at')->nullable();
            $table->dateTime('archived_at')->nullable();
            $table->char('created_by_id', 30);
            $table->timestamps();
            $table->softDeletes();

            $table->unique(['base_id', 'name']);
            $table->index(['organization_id', 'base_id', 'deleted_at']);
            $table->foreign('base_id')->references('id')->on('bases')->cascadeOnDelete();
        });

        Schema::create('fields', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // fld_<ULID>
            $table->char('organization_id', 30);
            $table->char('table_id', 30);
            $table->string('name', 120);
            $table->string('type', 32);
            $table->text('description')->nullable();
            $table->integer('position')->default(0);
            $table->boolean('is_primary')->default(false);
            $table->boolean('is_required')->default(false);
            $table->boolean('is_unique')->default(false);
            $table->json('options')->nullable();
            $table->json('default_value')->nullable();
            $table->string('promoted_slot', 4)->nullable();
            $table->string('promotion_state', 16)->nullable();
            $table->char('symmetric_field_id', 30)->nullable();
            $table->json('compute_meta')->nullable();
            $table->char('created_by_id', 30);
            $table->timestamps();
            $table->softDeletes();

            $table->unique(['table_id', 'name']);
            $table->index(['organization_id', 'table_id', 'deleted_at']);
            $table->foreign('table_id')->references('id')->on('tables')->cascadeOnDelete();
        });

        Schema::create('records', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // rec_<ULID>
            $table->char('organization_id', 30);
            $table->char('table_id', 30);
            $table->json('data');
            // Promoted typed slots (indexed) — written for fields that carry a promoted_slot.
            $table->text('s0')->nullable();
            $table->text('s1')->nullable();
            $table->text('s2')->nullable();
            $table->text('s3')->nullable();
            $table->decimal('n0', 38, 10)->nullable();
            $table->decimal('n1', 38, 10)->nullable();
            $table->decimal('n2', 38, 10)->nullable();
            $table->decimal('n3', 38, 10)->nullable();
            $table->dateTime('d0')->nullable();
            $table->dateTime('d1')->nullable();
            $table->dateTime('d2')->nullable();
            $table->boolean('b0')->nullable();
            $table->boolean('b1')->nullable();
            $table->integer('version')->default(1);
            $table->bigInteger('auto_number');
            $table->char('created_by', 30)->nullable();
            $table->char('updated_by', 30)->nullable();
            $table->dateTime('created_at')->nullable();
            $table->dateTime('updated_at')->nullable();
            $table->dateTime('deleted_at')->nullable();

            $table->index(['organization_id', 'table_id', 'id']);
            $table->index(['organization_id', 'table_id', 'updated_at']);
            $table->foreign('table_id')->references('id')->on('tables')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('records');
        Schema::dropIfExists('fields');
        Schema::dropIfExists('tables');
        Schema::dropIfExists('bases');
    }
};
