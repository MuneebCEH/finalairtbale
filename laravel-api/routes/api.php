<?php

use App\Http\Controllers\AuthController;
use App\Http\Controllers\BaseController;
use App\Http\Controllers\FieldController;
use App\Http\Controllers\HealthController;
use App\Http\Controllers\MeController;
use App\Http\Controllers\OrganizationController;
use App\Http\Controllers\RecordController;
use App\Http\Controllers\WorkspaceController;
use Illuminate\Support\Facades\Route;

/*
 | Tessera API routes. Paths match the NestJS backend exactly:
 |   - health is version-neutral (no /v1 prefix)
 |   - everything else is under /v1
 | The global api prefix is disabled (apiPrefix: '' in bootstrap/app.php).
 */

// ── Health (version-neutral) ────────────────────────────────────────────────
Route::prefix('health')->group(function () {
    Route::get('live', [HealthController::class, 'live']);
    Route::get('ready', [HealthController::class, 'ready']);
});

// ── v1 ───────────────────────────────────────────────────────────────────────
Route::prefix('v1')->group(function () {
    Route::prefix('auth')->group(function () {
        // Public
        Route::post('register', [AuthController::class, 'register']);
        Route::post('verify-email', [AuthController::class, 'verifyEmail']);
        Route::post('login', [AuthController::class, 'login']);
        Route::post('logout', [AuthController::class, 'logout']);
        Route::post('refresh', [AuthController::class, 'refresh']);
        Route::post('password/forgot', [AuthController::class, 'forgotPassword']);
        Route::post('password/reset', [AuthController::class, 'resetPassword']);

        // Authenticated
        Route::middleware('session')->group(function () {
            Route::post('password/change', [AuthController::class, 'changePassword']);
            Route::get('sessions', [AuthController::class, 'listSessions']);
            Route::delete('sessions/{sessionId}', [AuthController::class, 'revokeSession']);
            Route::delete('sessions', [AuthController::class, 'revokeOtherSessions']);
        });
    });

    // Current user
    Route::middleware('session')->group(function () {
        Route::get('me', [MeController::class, 'show']);
        Route::patch('me', [MeController::class, 'update']);
        Route::get('me/organizations', [MeController::class, 'organizations']);
    });

    // Organizations & workspaces. Creating an org needs no tenant (it makes one); everything else
    // is tenant-scoped — the `tenant` middleware enforces membership (404 on isolation).
    Route::middleware('session')->group(function () {
        Route::post('organizations', [OrganizationController::class, 'create']);

        Route::middleware('tenant')->group(function () {
            Route::get('organizations/{orgId}', [OrganizationController::class, 'show']);
            Route::get('organizations/{orgId}/members', [OrganizationController::class, 'listMembers']);
            Route::get('organizations/{orgId}/workspaces', [WorkspaceController::class, 'list']);
            Route::post('organizations/{orgId}/workspaces', [WorkspaceController::class, 'create']);
            Route::get('workspaces/{workspaceId}', [WorkspaceController::class, 'show']);

            // ── Data plane: bases, tables, fields, records ──────────────────
            Route::get('workspaces/{workspaceId}/bases', [BaseController::class, 'listBases']);
            Route::post('workspaces/{workspaceId}/bases', [BaseController::class, 'createBase']);
            Route::get('bases/{baseId}', [BaseController::class, 'showBase']);
            Route::patch('bases/{baseId}', [BaseController::class, 'updateBase']);
            Route::delete('bases/{baseId}', [BaseController::class, 'deleteBase']);
            Route::get('bases/{baseId}/tables', [BaseController::class, 'listTables']);
            Route::post('bases/{baseId}/tables', [BaseController::class, 'createTable']);
            Route::get('tables/{tableId}', [BaseController::class, 'showTable']);
            Route::patch('tables/{tableId}', [BaseController::class, 'updateTable']);
            Route::delete('tables/{tableId}', [BaseController::class, 'deleteTable']);

            Route::get('tables/{tableId}/fields', [FieldController::class, 'list']);
            Route::post('tables/{tableId}/fields', [FieldController::class, 'create']);
            Route::patch('tables/{tableId}/fields/{fieldId}', [FieldController::class, 'update']);
            Route::delete('tables/{tableId}/fields/{fieldId}', [FieldController::class, 'delete']);

            Route::get('tables/{tableId}/records', [RecordController::class, 'list']);
            Route::post('tables/{tableId}/records', [RecordController::class, 'create']);
            Route::get('tables/{tableId}/records/{recordId}', [RecordController::class, 'show']);
            Route::patch('tables/{tableId}/records/{recordId}', [RecordController::class, 'update']);
            Route::delete('tables/{tableId}/records', [RecordController::class, 'bulkDelete']);
        });
    });
});
