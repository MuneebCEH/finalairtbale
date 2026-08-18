<?php

/**
 * One-shot migration runner for hosts with no terminal (cPanel shared hosting).
 *
 * Open  https://<api-domain>/run-migrations.php?key=tessera-migrate-2026  in a browser: it boots
 * the app and runs `php artisan migrate --force`, printing what ran. Running it twice is safe —
 * migrations that already ran are skipped. It changes SCHEMA only; data rows are never touched.
 *
 * Delete this file from the server once done.
 */

if (($_GET['key'] ?? '') !== 'tessera-migrate-2026') {
    http_response_code(403);
    exit('Forbidden');
}

require __DIR__.'/../vendor/autoload.php';

$app = require_once __DIR__.'/../bootstrap/app.php';
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();

header('Content-Type: text/plain; charset=utf-8');

try {
    $code = Illuminate\Support\Facades\Artisan::call('migrate', ['--force' => true]);
    echo Illuminate\Support\Facades\Artisan::output();
    echo $code === 0 ? "\nDONE — migrations up to date.\n" : "\nEXIT CODE {$code}\n";
} catch (Throwable $e) {
    http_response_code(500);
    echo 'ERROR: '.$e->getMessage()."\n";
}
