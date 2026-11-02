// Expand the aggregate ECS secret before any module reads process.env.
import './environment-secret';

// ─── Observability (must follow environment hydration) ───────────────────────
import './lib/sentry';

// Notices a job can fire register their delivery at import. A failed box start
// tells the session's chat (channels/core/session-notice.ts, Telegram's port);
// the API process imports these through its routes, the worker here. The
// subagent notices load with projects/surface.ts.
// unit-worker-entry-imports.test.ts fails when a registration is missing.
import './channels/core/session-notice';
import './channels/telegram/session';

/**
 * The worker entry point: `bun run src/worker.ts`.
 *
 * It runs the scheduled jobs (`worker/jobs/index.ts`) and nothing that serves
 * users: no HTTP app, no WebSockets, no message delivery drain. Production
 * runs it as its own ECS service, one task, with no load balancer; the web
 * servers run `src/index.ts` with `KORTIX_PROCESS_ROLE=web`. It joins the same
 * leader election as before, so exactly one process runs the jobs even while a
 * deploy overlaps two worker tasks: the new task waits for the lease, and the
 * old one releases it on SIGTERM.
 *
 * Its only listener is a health server on PORT for the ECS container health
 * check: `/health/live` (event-loop lag) and `/health/ready` (503 until boot
 * finishes and while draining).
 */
import { config } from './config';
import { bootServices, draining, markSchemaReady, prepareProcess, shutdown } from './bootstrap';
import { ensureSchema } from './ensure-schema';
import { logger } from './lib/logger';
import { eventLoopLagMs } from './replica/event-loop-lag';
import { captureServer } from './shared/drain';
import { runsSingletonWorkers } from './shared/leader-election';

// A worker that would never join the election must not report ready: the
// deploy would then move the API to `web` and leave no process to run the jobs.
if (!config.KORTIX_WORKERS_ENABLED || !runsSingletonWorkers()) {
  logger.error('[worker] background workers are disabled (KORTIX_WORKERS_ENABLED or the KORTIX_*_ENABLED job flags): a worker that runs no jobs must not start');
  await logger.flush();
  process.exit(1);
}

let booted = false;

function health(path: string): Response {
  if (path === '/health/live' || path === '/v1/health/live') {
    const lag = Math.round(eventLoopLagMs);
    const ok = eventLoopLagMs <= config.HEALTH_MAX_EVENT_LOOP_LAG_MS;
    return Response.json({ status: ok ? 'ok' : 'degraded', event_loop_lag_ms: lag }, { status: ok ? 200 : 503 });
  }
  if (path === '/health/ready' || path === '/v1/health/ready') {
    if (draining) return Response.json({ status: 'draining', reason: 'shutdown in progress' }, { status: 503 });
    if (!booted) return Response.json({ status: 'starting', reason: 'boot not finished' }, { status: 503 });
    return Response.json({ status: 'ok', role: 'worker' });
  }
  return Response.json({ error: 'not found' }, { status: 404 });
}

logger.info('[worker] starting', { port: config.PORT, env: config.INTERNAL_KORTIX_ENV });
await prepareProcess({ entry: true });

const server = Bun.serve({ port: config.PORT, fetch: (req) => health(new URL(req.url).pathname) });
// Shutdown stops this listener with the request drain.
captureServer(server);

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await ensureSchema().catch((err) => {
  logger.error('[worker] ensureSchema failed, starting jobs anyway', {
    error: err instanceof Error ? err.message : String(err),
  });
});
markSchemaReady();
await bootServices('worker');
booted = true;
logger.info('[worker] ready: joined the leader election for the scheduled jobs');
