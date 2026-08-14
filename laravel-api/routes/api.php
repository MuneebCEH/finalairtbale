<?php

use App\Http\Controllers\AttachmentController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\BaseController;
use App\Http\Controllers\CommentController;
use App\Http\Controllers\FieldController;
use App\Http\Controllers\FormController;
use App\Http\Controllers\HealthController;
use App\Http\Controllers\MeController;
use App\Http\Controllers\OrganizationController;
use App\Http\Controllers\PublicFormController;
use App\Http\Controllers\RecordController;
use App\Http\Controllers\SectionsController;
use App\Http\Controllers\TemplateController;
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
        Route::post('mfa/verify', [AuthController::class, 'mfaVerify']);
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

    // Public form — anyone with the link, no account. Serves HTML and accepts submissions.
    Route::get('f/{slug}', [PublicFormController::class, 'show']);
    Route::post('f/{slug}', [PublicFormController::class, 'submit']);

    // Current user
    Route::middleware('session')->group(function () {
        Route::get('me', [MeController::class, 'show']);
        Route::patch('me', [MeController::class, 'update']);
        Route::get('me/organizations', [MeController::class, 'organizations']);
        Route::get('templates', [TemplateController::class, 'index']);
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
            Route::post('workspaces/{workspaceId}/bases/from-template', [TemplateController::class, 'create']);
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
            Route::get('tables/{tableId}/record-links', [RecordController::class, 'linkOptions']);
            Route::post('tables/{tableId}/records/query', [RecordController::class, 'query']);
            Route::post('tables/{tableId}/records', [RecordController::class, 'create']);
            Route::get('tables/{tableId}/records/{recordId}', [RecordController::class, 'show']);
            Route::patch('tables/{tableId}/records/{recordId}', [RecordController::class, 'update']);
            Route::delete('tables/{tableId}/records', [RecordController::class, 'bulkDelete']);

            // Comments, attachments, and the (currently empty) forms/automations sections.
            Route::get('records/{recordId}/comments', [CommentController::class, 'list']);
            Route::post('records/{recordId}/comments', [CommentController::class, 'create']);
            Route::post('bases/{baseId}/attachments', [AttachmentController::class, 'upload']);
            Route::get('bases/{baseId}/automations', [SectionsController::class, 'automations']);

            // Forms
            Route::get('tables/{tableId}/forms', [FormController::class, 'index']);
            Route::post('tables/{tableId}/forms', [FormController::class, 'store']);
            Route::get('forms/{formId}', [FormController::class, 'show']);
            Route::patch('forms/{formId}', [FormController::class, 'update']);
            Route::delete('forms/{formId}', [FormController::class, 'destroy']);
        });
    });
});
