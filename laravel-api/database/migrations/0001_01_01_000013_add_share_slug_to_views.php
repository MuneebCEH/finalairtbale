<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Share-view links: a view with a slug is publicly readable (read-only) at /v1/shared/{slug}.
 * Null means not shared — the default for every existing and new view.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('views', function (Blueprint $table) {
            $table->string('share_slug', 40)->nullable()->unique()->after('position');
        });
    }

    public function down(): void
    {
        Schema::table('views', function (Blueprint $table) {
            $table->dropColumn('share_slug');
        });
    }
};
