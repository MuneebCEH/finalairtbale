/**
 * Subscription plans and the entitlements they carry.
 *
 * Entitlements are enforced server-side at the point of action (creating a workspace, running an
 * automation, uploading a file), never only in the UI. `null` means unlimited.
 */

export const PLANS = ['free', 'starter', 'professional', 'business', 'enterprise'] as const;
export type Plan = (typeof PLANS)[number];

export interface Entitlements {
  readonly seats: number | null;
  readonly guests: number | null;
  readonly workspaces: number | null;
  readonly basesPerWorkspace: number | null;
  readonly recordsPerBase: number | null;
  readonly attachmentStorageBytes: number | null;
  readonly maxUploadBytes: number;
  readonly automationRunsPerMonth: number | null;
  readonly apiRequestsPerSecond: number;
  readonly revisionHistoryDays: number;
  readonly trashRetentionDays: number;
  readonly formSubmissionsPerMonth: number | null;
  readonly interfaceViewers: number | null;
  readonly advancedViews: boolean;
  readonly interfaces: boolean;
  readonly customRoles: boolean;
  readonly fieldLevelPermissions: boolean;
  readonly sso: boolean;
  readonly scim: boolean;
  readonly auditLogExport: boolean;
  readonly enforcedTwoFactor: boolean;
  readonly perTenantWorkerConcurrency: number;
}

export const PLAN_ENTITLEMENTS: Readonly<Record<Plan, Entitlements>> = {
  free: {
    seats: 5,
    guests: 0,
    workspaces: 1,
    basesPerWorkspace: 2,
    recordsPerBase: 1_000,
    attachmentStorageBytes: 1_073_741_824,
    maxUploadBytes: 5_242_880,
    automationRunsPerMonth: 100,
    apiRequestsPerSecond: 5,
    revisionHistoryDays: 14,
    trashRetentionDays: 7,
    formSubmissionsPerMonth: 100,
    interfaceViewers: 0,
    advancedViews: false,
    interfaces: false,
    customRoles: false,
    fieldLevelPermissions: false,
    sso: false,
    scim: false,
    auditLogExport: false,
    enforcedTwoFactor: false,
    perTenantWorkerConcurrency: 2,
  },
  starter: {
    seats: 25,
    guests: 5,
    workspaces: 3,
    basesPerWorkspace: 10,
    recordsPerBase: 10_000,
    attachmentStorageBytes: 21_474_836_480,
    maxUploadBytes: 26_214_400,
    automationRunsPerMonth: 5_000,
    apiRequestsPerSecond: 10,
    revisionHistoryDays: 30,
    trashRetentionDays: 30,
    formSubmissionsPerMonth: 2_000,
    interfaceViewers: 0,
    advancedViews: true,
    interfaces: false,
    customRoles: false,
    fieldLevelPermissions: false,
    sso: false,
    scim: false,
    auditLogExport: false,
    enforcedTwoFactor: false,
    perTenantWorkerConcurrency: 4,
  },
  professional: {
    seats: null,
    guests: 50,
    workspaces: 25,
    basesPerWorkspace: 50,
    recordsPerBase: 100_000,
    attachmentStorageBytes: 214_748_364_800,
    maxUploadBytes: 104_857_600,
    automationRunsPerMonth: 50_000,
    apiRequestsPerSecond: 25,
    revisionHistoryDays: 180,
    trashRetentionDays: 90,
    formSubmissionsPerMonth: null,
    interfaceViewers: 100,
    advancedViews: true,
    interfaces: true,
    customRoles: false,
    fieldLevelPermissions: true,
    sso: false,
    scim: false,
    auditLogExport: false,
    enforcedTwoFactor: true,
    perTenantWorkerConcurrency: 8,
  },
  business: {
    seats: null,
    guests: null,
    workspaces: null,
    basesPerWorkspace: null,
    recordsPerBase: 500_000,
    attachmentStorageBytes: 1_099_511_627_776,
    maxUploadBytes: 524_288_000,
    automationRunsPerMonth: 250_000,
    apiRequestsPerSecond: 50,
    revisionHistoryDays: 365,
    trashRetentionDays: 180,
    formSubmissionsPerMonth: null,
    interfaceViewers: null,
    advancedViews: true,
    interfaces: true,
    customRoles: true,
    fieldLevelPermissions: true,
    sso: true,
    scim: true,
    auditLogExport: true,
    enforcedTwoFactor: true,
    perTenantWorkerConcurrency: 16,
  },
  enterprise: {
    seats: null,
    guests: null,
    workspaces: null,
    basesPerWorkspace: null,
    recordsPerBase: null,
    attachmentStorageBytes: null,
    maxUploadBytes: 1_073_741_824,
    automationRunsPerMonth: null,
    apiRequestsPerSecond: 100,
    revisionHistoryDays: 1095,
    trashRetentionDays: 365,
    formSubmissionsPerMonth: null,
    interfaceViewers: null,
    advancedViews: true,
    interfaces: true,
    customRoles: true,
    fieldLevelPermissions: true,
    sso: true,
    scim: true,
    auditLogExport: true,
    enforcedTwoFactor: true,
    perTenantWorkerConcurrency: 32,
  },
};

/** Metered quantities that accrue into `usage_events` and drive both limits and invoices. */
export const METERED_UNITS = [
  'seats',
  'guests',
  'records',
  'attachment_bytes',
  'automation_runs',
  'api_requests',
  'form_submissions',
  'interface_viewers',
  'worker_seconds',
] as const;

export type MeteredUnit = (typeof METERED_UNITS)[number];
