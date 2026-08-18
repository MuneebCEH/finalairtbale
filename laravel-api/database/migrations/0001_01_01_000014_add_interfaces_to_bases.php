<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Interfaces: per-base dashboards. The whole designer state (widget list) lives in one JSON
 * column — widgets are a view over the base's data, not data themselves, so they need no rows,
 * joins, or ids of their own.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('bases', function (Blueprint $table) {
            $table->longText('interfaces_config')->nullable()->after('color');
        });
    }

    public function down(): void
    {
        Schema::table('bases', function (Blueprint $table) {
            $table->dropColumn('interfaces_config');
        });
    }
};
