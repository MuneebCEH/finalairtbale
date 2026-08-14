<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Tessera `user_sessions` table — translation of the Prisma `UserSession` model.
 *
 * The plaintext session token lives only in the `tessera_session` cookie; the database stores
 * its SHA-256 (`token_hash`, 64 hex chars). `family_id` tracks rotation lineage so that reuse of
 * a rotated token can revoke the whole family. Postgres `Inet` -> `varchar(45)`.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_sessions', function (Blueprint $table) {
            $table->char('id', 30)->primary();                 // ses_<ULID>
            $table->char('user_id', 30);
            $table->char('token_hash', 64)->unique();
            $table->char('family_id', 30);
            $table->char('previous_token_hash', 64)->nullable();
            $table->string('ip_address', 45)->nullable();
            $table->text('user_agent')->nullable();
            $table->string('device_label', 120)->nullable();
            $table->string('location', 120)->nullable();
            $table->boolean('mfa_satisfied')->default(false);
            $table->timestamp('created_at')->nullable();
            $table->timestamp('last_seen_at')->nullable();
            // `datetime`, not `timestamp`: MariaDB in strict mode rejects a NOT NULL timestamp
            // without a default, and this value is always set by the application anyway.
            $table->dateTime('expires_at');
            $table->timestamp('revoked_at')->nullable();
            $table->string('revoked_reason', 64)->nullable();

            $table->foreign('user_id')->references('id')->on('users')->cascadeOnDelete();
            $table->index(['user_id', 'revoked_at']);
            $table->index('expires_at');
            $table->index('family_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('user_sessions');
    }
};
