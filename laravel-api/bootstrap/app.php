<?php

use App\Support\ApiExceptionRenderer;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        apiPrefix: '', // paths in routes/api.php are absolute (health is version-neutral, rest /v1)
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Every API request gets a correlation id echoed back as X-Request-Id.
        $middleware->api(prepend: [
            \App\Http\Middleware\AssignRequestId::class,
        ]);

        $middleware->alias([
            'session' => \App\Http\Middleware\EnsureSession::class,
            'tenant' => \App\Http\Middleware\ResolveTenant::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // One error shape for the whole API — see ApiExceptionRenderer.
        $exceptions->render(fn (\Throwable $e, Request $request) => ApiExceptionRenderer::render($e, $request));
    })->create();
