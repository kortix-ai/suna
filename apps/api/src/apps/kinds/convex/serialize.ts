/**
 * The `instance` object of an App of kind `convex` in every App response: the
 * machine's state. Agnostic names: clients read `capabilities` to know which
 * fields mean something.
 */
import { CONVEX_CLI_VERSION } from './convex-image';
import { backendDashboardUrl, backendPublicUrls } from './hosts';
import type { BackendHealth } from './maintenance';
import { backendOperation } from './operations';
import { type ConvexRow, effectiveStatus } from './provision';

/** `authEnv`: the KORTIX_AUTH_* the machine's environment holds (../../tokens.ts authEnv); null before its project has a key. */
export function convexInstanceJson(row: ConvexRow, authEnv: Record<string, string> | null) {
  const status = effectiveStatus(row);
  const meta = row.metadata as {
    lastError?: unknown;
    lastOperationError?: unknown;
    health?: BackendHealth;
    budgetAlert?: { month: string; percent: number; spentUsd: number; budgetUsd: number; at: string };
    purgeAfter?: string;
  };
  const lastError = status !== row.status ? 'Provisioning was interrupted. Delete this App and create it again.' : meta.lastError;
  const live = status !== 'deleted' && !row.deletedAt;
  return {
    status,
    /** The Convex client URL (the App's `url`) and its HTTP actions URL: Kortix hosts, fixed for the App's life. */
    url: live && row.url ? backendPublicUrls(row.appId).url : null,
    site_url: live && row.siteUrl ? backendPublicUrls(row.appId).siteUrl : null,
    dashboard_url: live ? backendDashboardUrl(row) : null,
    error: status === 'error' && typeof lastError === 'string' ? lastError : null,
    operation: backendOperation(row),
    last_operation_error: typeof meta.lastOperationError === 'string' ? meta.lastOperationError : null,
    health: meta.health ?? null,
    auth_env: live ? authEnv : null,
    /** The client CLI version that matches the machine (`npx convex@<version> deploy`). */
    client_version: CONVEX_CLI_VERSION,
    budget_alert: meta.budgetAlert
      ? {
          month: meta.budgetAlert.month,
          percent: meta.budgetAlert.percent,
          spent_usd: meta.budgetAlert.spentUsd,
          budget_usd: meta.budgetAlert.budgetUsd,
          at: meta.budgetAlert.at,
        }
      : null,
    /** Set on a deleted App: when Kortix purges the kept machine and its final snapshot. */
    purge_after: meta.purgeAfter ?? null,
  };
}
