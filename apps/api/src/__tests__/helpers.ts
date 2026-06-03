/**
 * Test helpers for kortix-api E2E tests.
 *
 * Provides:
 * - createTestApp() — Hono app shell with auth bypassed
 * - Request helpers (jsonGet)
 *
 * IMPORTANT: This file must be importable without database env vars.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { BillingError } from '../errors';
import type { AppEnv } from '../types';

// ─── Constants ───────────────────────────────────────────────────────────────

const TEST_USER_ID = '00000000-0000-4000-a000-000000000001';
const TEST_USER_EMAIL = 'test@kortix.dev';

// ─── Test App Factory ────────────────────────────────────────────────────────

interface TestAppOptions {
  userId?: string;
  userEmail?: string;
}

/**
 * Build the Hono app shell with health, auth, 404, and error handlers.
 */
export function createTestApp(opts: TestAppOptions = {}) {
  const userId = opts.userId || TEST_USER_ID;
  const userEmail = opts.userEmail || TEST_USER_EMAIL;

  const app = new Hono<AppEnv>();
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

  // ─── Auth stub for all /v1/* routes that need it ───────────────────────
  app.use('/v1/*', async (c, next) => {
    c.set('userId', userId);
    c.set('userEmail', userEmail);
    await next();
  });

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
