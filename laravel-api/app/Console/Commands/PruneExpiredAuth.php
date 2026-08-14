<?php

namespace App\Console\Commands;

use App\Models\AuthToken;
use App\Models\UserSession;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;

/**
 * Maintenance job: retire sessions that have expired and delete consumed or expired one-time
 * tokens. On cPanel (no long-running worker) this runs from a cron entry — see the deployment
 * guide. It is the first of the Laravel-queue/cron jobs that replace the Node BullMQ worker.
 */
class PruneExpiredAuth extends Command
{
    protected $signature = 'tessera:prune-auth';
    protected $description = 'Revoke expired sessions and delete stale one-time tokens.';

    public function handle(): int
    {
        $now = Carbon::now();

        $sessions = UserSession::whereNull('revoked_at')->where('expires_at', '<', $now)
            ->update(['revoked_at' => $now, 'revoked_reason' => 'expired']);

        $tokens = AuthToken::where('expires_at', '<', $now)
            ->orWhereNotNull('consumed_at')
            ->delete();

        $this->info("Pruned {$sessions} expired session(s) and {$tokens} stale token(s).");

        return self::SUCCESS;
    }
}
