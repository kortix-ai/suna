import type { Hono } from 'hono';
import type { InflightBudget } from '@kortix/llm-gateway';
import type { TraceSink } from './observability/langfuse';
import type { createApiClient } from './clients/api-client';
const STARTED_AT = Date.now();
const SERVICE_VERSION = process.env.KORTIX_VERSION ?? 'dev';
const SERVICE_COMMIT = process.env.KORTIX_COMMIT ?? 'unknown';
// Below this volume in the window, a high error rate is statistical noise.
const ERROR_RATE_MIN_VOLUME = 20;
const ERROR_RATE_ALERT = 0.5;
export function registerHealth(app: Hono, api: ReturnType<typeof createApiClient>, inflight: InflightBudget, traces: TraceSink | null, trafficSnapshot: () => { window_s: number; requests: number; errors: number; error_rate: number }) {

  // Shallow liveness: the process is up. The k8s livenessProbe should point here
  // so a dependency outage (which a restart can't fix) doesn't crash-loop the pod.
  // Includes version/commit so a rollout can be confirmed with one cheap probe
  // (no deep dependency checks) — `curl /health/live` shows which build is live.
  app.get('/health/live', (c) =>
    c.json({ ok: true, version: SERVICE_VERSION, commit: SERVICE_COMMIT }),
  );

  // Deep health/readiness, built for an external monitor: an overall status, the
  // specific incidents, dependency checks, and a rolling error rate. Returns HTTP
  // 503 when unhealthy so a bot can alert on the status code alone, then read
  // `incidents`/`checks` for the what.
  app.get('/health', async (c) => {
    const apiCheck = await api.ping();
    const traffic = trafficSnapshot();
    const admission = {
      used_bytes: inflight.inflightBytes,
      capacity_bytes: inflight.capacityBytes,
      utilization: Number(inflight.utilisation.toFixed(4)),
    };
    const errorSpike =
      traffic.requests >= ERROR_RATE_MIN_VOLUME && traffic.error_rate >= ERROR_RATE_ALERT;

    // A sustained streak, not one blip: a single dropped POST during a
    // Langfuse hiccup is not an incident, and this must never page on it.
    const TRACE_FAILURE_STREAK_ALERT = 5;
    const tracesStatus = traces?.status() ?? null;
    const traceStreakAlert =
      tracesStatus !== null && tracesStatus.consecutiveFailures >= TRACE_FAILURE_STREAK_ALERT;

    const incidents: string[] = [];
    if (!apiCheck.ok)
      incidents.push(`kortix api unreachable (${apiCheck.error ?? `http ${apiCheck.status}`})`);
    if (errorSpike)
      incidents.push(
        `error rate ${(traffic.error_rate * 100).toFixed(0)}% over ${traffic.window_s}s`,
      );
    if (traceStreakAlert)
      incidents.push(
        `langfuse trace recording failed ${tracesStatus.consecutiveFailures}x in a row (${tracesStatus.lastError ?? 'unknown error'})`,
      );

    const status = !apiCheck.ok ? 'unhealthy' : incidents.length ? 'degraded' : 'healthy';

    return c.json(
      {
        status,
        service: 'kortix-llm-gateway',
        version: SERVICE_VERSION,
        commit: SERVICE_COMMIT,
        uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
        timestamp: new Date().toISOString(),
        incidents,
        checks: {
          api: {
            status: apiCheck.ok ? 'up' : 'down',
            latency_ms: apiCheck.latencyMs,
            ...(apiCheck.status ? { http_status: apiCheck.status } : {}),
            ...(apiCheck.error ? { error: apiCheck.error } : {}),
          },
          traces: {
            langfuse: traces ? 'enabled' : 'disabled',
            ...(tracesStatus
              ? {
                  last_queued_at: tracesStatus.lastQueuedAt
                    ? new Date(tracesStatus.lastQueuedAt).toISOString()
                    : null,
                  last_failure_at: tracesStatus.lastFailureAt
                    ? new Date(tracesStatus.lastFailureAt).toISOString()
                    : null,
                  consecutive_failures: tracesStatus.consecutiveFailures,
                  ...(tracesStatus.lastError ? { last_error: tracesStatus.lastError } : {}),
                }
              : {}),
          },
          admission,
        },
        traffic,
      },
      status === 'unhealthy' ? 503 : 200,
    );
  });
}
