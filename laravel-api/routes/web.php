<?php

use Illuminate\Support\Facades\Route;

// This is an API. The root should not advertise the framework — send visitors to the app instead
// (or to the health check if the frontend origin isn't configured).
Route::get('/', function () {
    return redirect()->away(env('FRONTEND_ORIGIN') ?: url('/health/ready'));
});
