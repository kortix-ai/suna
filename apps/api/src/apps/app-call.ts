/**
 * A trigger whose target is an App (`target: { app, path }`): wake the App and
 * send the fire's payload straight to a serving machine, the path a public
 * request takes after the access gate. Only Kortix reaches a machine there, so
 * a private App receives the call too.
 */
import { apps } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { SandboxProviderName } from '../config';
import { db } from '../shared/db';
import { ingressTargetUrl } from '../platform/providers/ingress-url';
import { AppHostingProvider } from './hosting';
import { recordAppActivity } from './public-proxy-handler';
import { ensureAppRuntimeRunning, loadPublicApp } from './public-proxy-runtime';

const CALL_TIMEOUT_MS = 60_000;

export interface AppCallResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  /** A later attempt can succeed: no answer, a 429 or a 5xx. */
  retryable: boolean;
}

export async function callAppTarget(input: {
  projectId: string;
  app: string;
  method: 'POST' | 'GET';
  path: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  hosting?: AppHostingProvider;
}): Promise<AppCallResult> {
  const hosting = input.hosting ?? new AppHostingProvider();
  const [row] = await db.select({ routeKey: apps.routeKey }).from(apps)
    .where(and(eq(apps.projectId, input.projectId), eq(apps.slug, input.app), isNull(apps.deletedAt))).limit(1);
  if (!row) return { ok: false, status: null, error: `No App "${input.app}" in this project`, retryable: false };
  const loaded = await loadPublicApp(row.routeKey, 'http');
  if (!loaded) return { ok: false, status: null, error: `App "${input.app}" has no ready release that serves http`, retryable: true };
  try {
    const runtime = await ensureAppRuntimeRunning(loaded, hosting);
    // A call is activity, like a request: the idle reaper waits for it.
    await recordAppActivity(loaded.app, runtime.runtimeId, new Date());
    const ingress = await hosting.ingress(runtime.provider as SandboxProviderName, runtime.externalId, 'http');
    const response = await fetch(ingressTargetUrl(ingress, input.path), {
      method: input.method,
      headers: { ...ingress.headers, ...input.headers, ...(input.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: input.method === 'POST' ? JSON.stringify(input.payload) : undefined,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      // The App's own server answers this call: a 3xx must not steer it, and the
      // provider token it carries, at another host (public-proxy-handler does the same).
      redirect: 'manual',
    });
    await response.body?.cancel().catch(() => {});
    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : `App "${input.app}" answered ${response.status} on ${input.method} ${input.path}`,
      retryable: response.status === 429 || response.status >= 500,
    };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error), retryable: true };
  }
}
