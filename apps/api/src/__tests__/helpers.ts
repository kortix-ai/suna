/**
 * Test helpers for kortix-api E2E tests.
 *
 * Provides:
 * - createTestApp() — Hono app shell with auth bypassed
 * - jsonGet()
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { BillingError } from '../errors';
import type { AuthVariables } from '../types';

// ─── Constants ───────────────────────────────────────────────────────────────

const TEST_USER_ID = '00000000-0000-4000-a000-000000000001';
const TEST_USER_EMAIL = 'test@kortix.dev';

// ─── Test App Factory ────────────────────────────────────────────────────────

export interface TestAppOptions {
  userId?: string;
  userEmail?: string;
}

/**
 * Build the Hono app shell with health, system-status, version, 404, and error handlers.
 */
export function createTestApp(opts: TestAppOptions = {}) {
  const userId = opts.userId || TEST_USER_ID;
  const userEmail = opts.userEmail || TEST_USER_EMAIL;

  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', cors());

  // ─── Health (no auth) ───────────────────────────────────────────────────
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'kortix-api',
      timestamp: new Date().toISOString(),
    }),
  );

  app.get('/v1/health', (c) =>
    c.json({
      status: 'ok',
      service: 'kortix',
      timestamp: new Date().toISOString(),
    }),
  );

  // ─── System status (no auth) ────────────────────────────────────────────
  app.get('/v1/system/status', (c) =>
    c.json({
      maintenanceNotice: { enabled: false },
      technicalIssue: { enabled: false },
      updatedAt: new Date().toISOString(),
    }),
  );

  // ─── Version (no auth — does NOT import db) ────────────────────────────
  // version.ts has zero db imports, safe to require unconditionally
  const { versionRouter } = require('../platform/routes/version');
  app.route('/v1/platform/sandbox/version', versionRouter);

  // ─── Auth stub for all /v1/* routes that need it ───────────────────────
  app.use('/v1/*', async (c, next) => {
    c.set('userId', userId);
    c.set('userEmail', userEmail);
    await next();
  });

  // [channels v2] Old channel routes removed — managed via sandbox CLI

  // ─── Error handler (matches production) ────────────────────────────────
  app.onError((err, c) => {
    if (err instanceof BillingError) {
      return c.json({ error: err.message }, err.statusCode as any);
    }

    if (err instanceof HTTPException) {
      const response: Record<string, unknown> = {
        error: true,
        message: err.message,
        status: err.status,
      };
      if (err.status === 503) {
        c.header('Retry-After', '10');
      }
      return c.json(response, err.status);
    }

    console.error('Test app error:', err);
    return c.json(
      { error: true, message: 'Internal server error', status: 500 },
      500,
    );
  });

  // ─── 404 handler (matches production) ──────────────────────────────────
  app.notFound((c) =>
    c.json({ error: true, message: 'Not found', status: 404 }, 404),
  );

  return app;
}

// ─── Request Helpers ─────────────────────────────────────────────────────────

export function jsonGet(app: Hono<any>, path: string) {
  return app.request(path, { method: 'GET' });
}
