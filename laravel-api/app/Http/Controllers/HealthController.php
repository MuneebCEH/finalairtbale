<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;

/**
 * Health endpoints, matching the NestJS semantics (docs/11-deployment.md §3):
 *   /health/live   — is this process wedged?
 *   /health/ready  — should traffic come here? Checks only the dependencies without which the
 *                    service is useless (database, cache). On cPanel there is no Redis, so `cache`
 *                    is reported false and the status is `degraded` — visible, not silently down.
 */
class HealthController extends Controller
{
    public function live()
    {
        return response()->json([
            'status' => 'ok',
            'uptimeSeconds' => 0,
        ]);
    }

    public function ready()
    {
        $database = $this->databaseHealthy();
        $cache = $this->cacheHealthy();

        return response()->json([
            'status' => ($database && $cache) ? 'ok' : 'degraded',
            'checks' => [
                'database' => $database,
                'cache' => $cache,
            ],
        ]);
    }

    private function databaseHealthy(): bool
    {
        try {
            DB::select('select 1');

            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    private function cacheHealthy(): bool
    {
        // No Redis on cPanel shared hosting — reported honestly rather than faked.
        if (env('REDIS_HOST') === null) {
            return false;
        }
        try {
            return Redis::connection()->ping() ? true : false;
        } catch (\Throwable) {
            return false;
        }
    }
}
