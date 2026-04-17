/**
 * Test helpers for kortix-api E2E tests.
 *
 * Provides:
 * - createTestApp() — Hono app mimicking the monolith with auth bypassed + injectable mock providers
 * - getTestDb()     — shared Drizzle DB instance for assertions
 * - cleanupTestData() — deletes all test rows from the shared kortix schema
 * - Mock provider factories
 * - Request helpers (jsonPost, jsonGet, jsonPatch, jsonDelete)
 *
 * IMPORTANT: This file must be importable WITHOUT TEST_DATABASE_URL being set.
 * DB-dependent modules (routes/platform, routes/channels, etc.) are loaded dynamically
 * in createTestApp() only when TEST_DATABASE_URL is available.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import {
  createDb,
  type Database,
  sandboxes,
  deployments,
  kortixApiKeys,
  accounts,
  accountMembers,
  integrationCredentials,
} from '@kortix/db';
import { sql, inArray } from 'drizzle-orm';
import { BillingError } from '../errors';
import type { AuthVariables } from '../types';

// ─── Provider Types (re-declared to avoid importing ../providers which chains to heavy deps) ─

export type ProviderName = 'daytona' | 'local_docker' | 'justavps';

export interface CreateSandboxOpts {
  accountId: string;
  userId: string;
  name: string;
  serverType?: string;
  location?: string;
  envVars?: Record<string, string>;
}

export interface ProvisionResult {
  externalId: string;
  baseUrl: string;
  metadata: Record<string, unknown>;
}

export type SandboxStatus = 'running' | 'stopped' | 'removed' | 'unknown';

export interface SandboxProvider {
  readonly name: ProviderName;
  create(opts: CreateSandboxOpts): Promise<ProvisionResult>;
  start(externalId: string): Promise<void>;
  stop(externalId: string): Promise<void>;
  remove(externalId: string): Promise<void>;
  getStatus(externalId: string): Promise<SandboxStatus>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const TEST_USER_ID = '00000000-0000-4000-a000-000000000001';
export const TEST_USER_EMAIL = 'test@kortix.dev';
export const OTHER_USER_ID = '00000000-0000-4000-a000-000000000002';
export const OTHER_USER_EMAIL = 'other@kortix.dev';

// ─── DB ──────────────────────────────────────────────────────────────────────

let testDb: Database | null = null;

const TEST_DB_CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';

export const HAS_SAFE_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL
  && process.env.KORTIX_TEST_DB_CONFIRM === TEST_DB_CONFIRMATION,
);

function getSafeTestDbUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL must be set for integration tests');
  }

  if (process.env.KORTIX_TEST_DB_CONFIRM !== TEST_DB_CONFIRMATION) {
    throw new Error(`KORTIX_TEST_DB_CONFIRM must equal ${TEST_DB_CONFIRMATION}`);
  }

  if (process.env.INTERNAL_KORTIX_ENV === 'prod') {
    throw new Error('Refusing to run integration tests against prod environment');
  }

  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    throw new Error('Refusing to run integration tests against the primary DATABASE_URL');
  }

  return url;
}

export function getTestDb(): Database {
  if (!testDb) {
    testDb = createDb(getSafeTestDbUrl());
  }
  return testDb;
}

export async function getTestAccountIds(): Promise<string[]> {
  const db = getTestDb();
  const baseIds = [TEST_USER_ID, OTHER_USER_ID];

  const memberships = await db
    .select({ accountId: accountMembers.accountId })
    .from(accountMembers)
    .where(inArray(accountMembers.userId, baseIds));

  return Array.from(new Set([...baseIds, ...memberships.map((row) => row.accountId)]));
}

// ─── Mock Provider Factory ───────────────────────────────────────────────────

/**
 * Creates a mock SandboxProvider that records calls and returns configurable results.
 */
export function createMockProvider(
  name: ProviderName,
  overrides: Partial<{
    createResult: ProvisionResult;
    statusResult: SandboxStatus;
    createError: Error;
    startError: Error;
    stopError: Error;
    removeError: Error;
    statusError: Error;
  }> = {},
): SandboxProvider & {
  calls: {
    create: CreateSandboxOpts[];
    start: string[];
    stop: string[];
    remove: string[];
    getStatus: string[];
  };
} {
  const calls = {
    create: [] as CreateSandboxOpts[],
    start: [] as string[],
    stop: [] as string[],
    remove: [] as string[],
    getStatus: [] as string[],
  };

  const defaultResult: ProvisionResult = {
    externalId: `mock-${name}-${Date.now()}`,
    baseUrl:
      name === 'daytona'
        ? `https://kortix.cloud/mock-daytona-id/8000`
        : name === 'justavps'
          ? 'https://mock-justavps.kortix.cloud'
        : `http://localhost:${30000 + Math.floor(Math.random() * 1000)}`,
    metadata: {
      provisionedBy: 'test',
      provider: name,
      testNote: 'sandbox tokens now stored in api_keys table',
    },
  };

  return {
    name,
    calls,

    async create(opts: CreateSandboxOpts): Promise<ProvisionResult> {
      calls.create.push(opts);
      if (overrides.createError) throw overrides.createError;
      return overrides.createResult || defaultResult;
    },

    async start(externalId: string): Promise<void> {
      calls.start.push(externalId);
      if (overrides.startError) throw overrides.startError;
    },

    async stop(externalId: string): Promise<void> {
      calls.stop.push(externalId);
      if (overrides.stopError) throw overrides.stopError;
    },

    async remove(externalId: string): Promise<void> {
      calls.remove.push(externalId);
      if (overrides.removeError) throw overrides.removeError;
    },

    async getStatus(externalId: string): Promise<SandboxStatus> {
      calls.getStatus.push(externalId);
      if (overrides.statusError) throw overrides.statusError;
      return overrides.statusResult || 'running';
    },
  };
}

// ─── Test App Factory ────────────────────────────────────────────────────────

export interface TestAppOptions {
  userId?: string;
  userEmail?: string;
  /** Single mock provider (used for both daytona & docker if not separately provided) */
  provider?: ReturnType<typeof createMockProvider>;
  daytonaProvider?: ReturnType<typeof createMockProvider>;
  dockerProvider?: ReturnType<typeof createMockProvider>;
  /** Override default provider name */
  defaultProvider?: ProviderName;
  /** Override available providers list */
  availableProviders?: ProviderName[];
  /** Whether to mount platform routes (requires DATABASE_URL). Default: true if DATABASE_URL set */
  mountPlatform?: boolean;
  /** Whether to mount deployment routes (requires DATABASE_URL). Default: false */
  mountDeployments?: boolean;
}

/**
 * Build the Hono app shell with health, system-status, version, 404, and error handlers.
 * Platform routes are mounted only when TEST_DATABASE_URL is explicitly configured.
 */
export function createTestApp(opts: TestAppOptions = {}) {
  const userId = opts.userId || TEST_USER_ID;
  const userEmail = opts.userEmail || TEST_USER_EMAIL;
  const hasDb = HAS_SAFE_TEST_DB;

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

  // ─── Platform routes (DI — mock providers, test DB) ────────────────────
  const shouldMountPlatform = opts.mountPlatform !== false && hasDb;
  if (shouldMountPlatform) {
    try {
      const { createAccountRouter } = require('../platform/routes/account');
      const db = getTestDb();

      const providerMap = new Map<ProviderName, SandboxProvider>();
      if (opts.provider) {
        providerMap.set(opts.provider.name, opts.provider);
      }
      if (opts.daytonaProvider) {
        providerMap.set('daytona', opts.daytonaProvider);
      }
      if (opts.dockerProvider) {
        providerMap.set('local_docker', opts.dockerProvider);
      }
      if (providerMap.size === 0) {
        providerMap.set('daytona', createMockProvider('daytona'));
        providerMap.set('local_docker', createMockProvider('local_docker'));
      }

      const deps = {
        db,
        getProvider: (name: ProviderName) => {
          const p = providerMap.get(name);
          if (!p) throw new Error(`Mock provider not configured for: ${name}`);
          return p;
        },
        getDefaultProviderName: () => opts.defaultProvider || 'local_docker',
        getAvailableProviders: () =>
          opts.availableProviders || Array.from(providerMap.keys()),
        resolveAccountId: async (uid: string) => uid,
        useAuth: false,
      };

      const accountRouter = createAccountRouter(deps);
      app.route('/v1/platform', accountRouter);

      // Also mount the cloud sandbox router at /v1/platform/sandbox
      const { createCloudSandboxRouter } = require('../platform/routes/sandbox-cloud');
      const sandboxRouter = createCloudSandboxRouter({
        db,
        getProvider: deps.getProvider,
        getDefaultProviderName: deps.getDefaultProviderName,
        resolveAccountId: deps.resolveAccountId,
        useAuth: false,
      });
      app.route('/v1/platform/sandbox', sandboxRouter);

      // API key management routes
      const { createApiKeysRouter } = require('../platform/routes/api-keys');
      const apiKeysRouter = createApiKeysRouter({
        db,
        resolveAccountId: deps.resolveAccountId,
        useAuth: false,
      });
      app.route('/v1/platform/api-keys', apiKeysRouter);
    } catch (e) {
      console.warn('[test] Failed to mount platform routes:', e);
    }
  }

  // ─── Deployment routes (module-level db — requires DATABASE_URL) ───────
  if (opts.mountDeployments && hasDb) {
    try {
      const { deploymentsRouter } = require('../deployments/routes/deployments');
      app.route('/v1/deployments', deploymentsRouter);
    } catch (e) {
      console.warn('[test] Failed to mount deployment routes:', e);
    }
  }

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

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Delete only test-scoped data from kortix schema tables.
 * Never performs whole-table deletes.
 */
export async function cleanupTestData(): Promise<void> {
  const db = getTestDb();
  const accountIds = await getTestAccountIds();
  if (accountIds.length === 0) return;

  await db.delete(kortixApiKeys).where(inArray(kortixApiKeys.accountId, accountIds));
  await db.delete(deployments).where(inArray(deployments.accountId, accountIds));
  await db.delete(sandboxes).where(inArray(sandboxes.accountId, accountIds));
  await db.delete(integrationCredentials).where(inArray(integrationCredentials.accountId, accountIds));
  await db.delete(accountMembers).where(inArray(accountMembers.userId, [TEST_USER_ID, OTHER_USER_ID]));
  await db.delete(accounts).where(inArray(accounts.accountId, accountIds));
}

// ─── Request Helpers ─────────────────────────────────────────────────────────

export function jsonPost(app: Hono<any>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function jsonGet(app: Hono<any>, path: string) {
  return app.request(path, { method: 'GET' });
}

export function jsonPatch(app: Hono<any>, path: string, body: unknown) {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function jsonDelete(app: Hono<any>, path: string) {
  return app.request(path, { method: 'DELETE' });
}
