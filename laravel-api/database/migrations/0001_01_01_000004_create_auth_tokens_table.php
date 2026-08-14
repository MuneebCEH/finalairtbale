<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Single-use tokens for email verification and password reset. Only the SHA-256 of the token is
 * stored; the plaintext is delivered by email (logged in local dev, since there is no mailer).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('auth_tokens', function (Blueprint $table) {
            $table->char('id', 30)->primary();                 // tok_<ULID>
            $table->char('user_id', 30)->nullable();
            $table->string('type', 30);                        // email_verification | password_reset
            $table->char('token_hash', 64)->unique();
            $table->dateTime('expires_at');
            $table->timestamp('consumed_at')->nullable();
            $table->timestamp('created_at')->nullable();

            $table->index(['user_id', 'type']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('auth_tokens');
    }
};
