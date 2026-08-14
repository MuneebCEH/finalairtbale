<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Organizations, workspaces, and their memberships — translated from the Prisma models. Tenant
 * isolation, which Postgres enforced with row-level security, is enforced here in the application
 * layer (see TenantResolver / the `tenant` middleware): every org-scoped query is filtered by a
 * membership the caller actually holds.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('organizations', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // org_<ULID>
            $table->string('name', 120);
            $table->string('slug', 48)->unique();
            $table->text('logo_url')->nullable();
            $table->char('brand_color', 7)->nullable();
            $table->string('plan', 20)->default('free');
            $table->string('status', 20)->default('active');
            $table->json('settings')->nullable();
            $table->string('region', 32)->default('default');
            $table->integer('shard_id')->default(0);
            $table->boolean('legal_hold')->default(false);
            $table->dateTime('trial_ends_at')->nullable();
            $table->timestamps();
            $table->softDeletes();
            $table->index('status');
        });

        Schema::create('organization_members', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // mem_<ULID>
            $table->char('organization_id', 30);
            $table->char('user_id', 30);
            $table->string('role', 20);
            $table->string('status', 20)->default('active');
            $table->char('invited_by_id', 30)->nullable();
            $table->dateTime('joined_at')->nullable();
            $table->dateTime('last_active_at')->nullable();
            $table->timestamps();

            $table->unique(['organization_id', 'user_id']);
            $table->index('user_id');
            $table->index(['organization_id', 'role']);
            $table->foreign('organization_id')->references('id')->on('organizations')->cascadeOnDelete();
            $table->foreign('user_id')->references('id')->on('users')->cascadeOnDelete();
        });

        Schema::create('workspaces', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // wsp_<ULID>
            $table->char('organization_id', 30);
            $table->string('name', 120);
            $table->text('description')->nullable();
            $table->string('icon', 64)->nullable();
            $table->char('color', 7)->nullable();
            $table->integer('position')->default(0);
            $table->dateTime('archived_at')->nullable();
            $table->char('created_by_id', 30);
            $table->timestamps();
            $table->softDeletes();

            $table->index(['organization_id', 'archived_at', 'deleted_at']);
            $table->foreign('organization_id')->references('id')->on('organizations')->cascadeOnDelete();
        });

        Schema::create('workspace_members', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // wmb_<ULID>
            $table->char('organization_id', 30);
            $table->char('workspace_id', 30);
            $table->char('user_id', 30)->nullable();
            $table->char('group_id', 30)->nullable();        // groups arrive later; no FK yet
            $table->string('role', 20);
            $table->char('added_by_id', 30)->nullable();
            $table->timestamps();

            $table->unique(['workspace_id', 'user_id']);
            $table->index('user_id');
            $table->index(['organization_id', 'workspace_id']);
            $table->foreign('workspace_id')->references('id')->on('workspaces')->cascadeOnDelete();
            $table->foreign('user_id')->references('id')->on('users')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('workspace_members');
        Schema::dropIfExists('workspaces');
        Schema::dropIfExists('organization_members');
        Schema::dropIfExists('organizations');
    }
};
