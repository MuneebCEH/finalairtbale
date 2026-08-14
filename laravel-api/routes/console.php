<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Background maintenance. On cPanel a single cron entry runs `php artisan schedule:run` every
// minute; Laravel decides which jobs are due. This replaces the always-on Node worker for the
// jobs ported so far. Queue-backed jobs drain via `php artisan queue:work --stop-when-empty`,
// also driven from cron (see the deployment guide).
Schedule::command('tessera:prune-auth')->hourly();
