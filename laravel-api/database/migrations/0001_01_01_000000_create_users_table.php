<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Tessera `users` table — a faithful translation of the Prisma `User` model
 * (packages/database/prisma/schema.prisma) from Postgres to MySQL/MariaDB.
 *
 * Differences forced by the engine, documented so they are deliberate, not accidental:
 *   - Postgres `Inet` has no MariaDB equivalent -> `varchar(45)` (holds IPv6).
 *   - Postgres `Bytes` -> `binary` (BLOB) for the encrypted TOTP secret.
 *   - `notification_preferences` JSON is nullable (MariaDB 10.4 cannot take a JSON literal
 *     default in DDL); the model defaults it to `{}`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('users', function (Blueprint $table) {
            $table->char('id', 30)->primary();               // usr_<ULID>
            $table->string('email', 254)->unique();
            $table->timestamp('email_verified_at')->nullable();
            $table->text('password_hash')->nullable();
            $table->string('name', 120);
            $table->text('avatar_url')->nullable();
            $table->string('timezone', 64)->default('UTC');
            $table->string('locale', 10)->default('en');
            $table->string('theme', 10)->default('system');  // light | dark | system

            // Second factor
            $table->boolean('two_factor_enabled')->default(false);
            $table->binary('totp_secret_cipher')->nullable();
            $table->integer('totp_secret_key_version')->nullable();

            // Abuse controls
            $table->integer('failed_login_count')->default(0);
            $table->timestamp('locked_until')->nullable();
            $table->timestamp('last_login_at')->nullable();
            $table->string('last_login_ip', 45)->nullable();

            $table->boolean('is_platform_admin')->default(false);
            $table->string('status', 20)->default('active');  // active | suspended | pending_deletion
            $table->timestamp('deletion_requested_at')->nullable();

            $table->json('notification_preferences')->nullable();

            $table->timestamp('created_at')->nullable();
            $table->timestamp('updated_at')->nullable();
            $table->timestamp('deleted_at')->nullable();      // soft delete

            $table->index('status');
            $table->index('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('users');
    }
};
