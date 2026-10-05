import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../openapi';
import { supabaseAuth } from '../middleware/auth';
import { sendDemoRequestNotification } from '../lib/demo-request-email';
import { createCachedPlatformSetting } from '../platform/services/platform-setting-cache';
// Statically imported (NOT await import() in the handlers): on a long-running
// `bun --hot` dev process, dynamic import() can wedge permanently after enough
// hot reloads — the promise never settles, the handler hangs, and Bun's
// idleTimeout kills the socket with an empty reply. Frontend-polled routes
// (maintenance banner, user-roles) must never sit behind a dynamic import.
import { hasDatabase } from '../shared/db';
// Statically imported (NOT await import() in the handlers): on a long-running
// `bun --hot` dev process, dynamic import() can wedge permanently after enough
// hot reloads — the promise never settles, the handler hangs, and Bun's
// idleTimeout kills the socket with an empty reply. Frontend-polled routes
// (maintenance banner, user-roles) must never sit behind a dynamic import.
import { computeEtag, etagMatches } from '../shared/http-cache';
import { readJsonObject } from '../shared/http-body';
import { getPlatformRole } from '../shared/platform-roles';
import { createDemoRequestRateLimitMiddleware } from '../middleware/rate-limit';

// ─── Maintenance config (DB-backed; replaces Vercel Edge Config) ─────────────
// One row in kortix.platform_settings under 'maintenance_config'. GET is public
// (banner + maintenance page read it); PUT is admin-only. Set via /admin/utils.
const MAINTENANCE_KEY = 'maintenance_config';

const MaintenanceSchema = z
  .object({
    level: z.string(),
    title: z.string(),
    message: z.string(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    statusUrl: z.string().nullable(),
    affectedServices: z.array(z.string()),
    updatedAt: z.string(),
  })
  .partial()
  .openapi('MaintenanceConfig');

type MaintenanceConfigValue = Required<z.infer<typeof MaintenanceSchema>>;

const DEFAULT_MAINTENANCE: MaintenanceConfigValue = {
  level: 'none',
  title: '',
  message: '',
  startTime: null,
  endTime: null,
  statusUrl: null,
  affectedServices: [],
  updatedAt: new Date(0).toISOString(),
};

function parseMaintenance(value: unknown): MaintenanceConfigValue {
  if (!value || typeof value !== 'object') return DEFAULT_MAINTENANCE;
  return { ...DEFAULT_MAINTENANCE, ...(value as Partial<MaintenanceConfigValue>) };
}

// The config is one singleton row that changes only when an admin flips it, but
// the GET is public and polled. Read it through the shared cached
// platform-setting reader, so the route never blocks on a DB round trip. The
// admin PUT writes through the cache, so the writing process serves the new
// value at once; other replicas converge within the reader's TTL.
const maintenanceSetting = createCachedPlatformSetting<MaintenanceConfigValue>(
  MAINTENANCE_KEY,
  parseMaintenance,
);

export { maintenanceSetting };

export function registerPlatformEndpoints(app: OpenAPIHono) {
// Also expose system status at root for backward compat with frontend
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/system/status',
    tags: ['system'],
    summary: 'Maintenance / technical-issue banner status',
    responses: {
      200: json(
        z
          .object({
            maintenanceNotice: z.object({ enabled: z.boolean() }).passthrough(),
            technicalIssue: z.object({ enabled: z.boolean() }).passthrough(),
            updatedAt: z.string(),
          })
          .openapi('SystemStatus'),
        'System status',
      ),
    },
  }),
  (c: any) =>
    c.json({
      maintenanceNotice: { enabled: false },
      technicalIssue: { enabled: false },
      updatedAt: new Date().toISOString(),
    }),
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/system/maintenance',
    tags: ['system'],
    summary: 'Read the maintenance config (public — banner + maintenance page)',
    responses: { 200: json(MaintenanceSchema, 'Maintenance config') },
  }),
  // Cacheable: the response never varies per tenant/user (no auth, same row
  // for every caller), so `public` is safe. The config comes from the
  // in-process cache, so the route pays no DB round trip; `max-age=5` + ETag
  // still shave the repeat poll at the client. A just-flipped lockdown reaches
  // every replica within the reader's TTL and the writing replica at once, so
  // a long `stale-while-revalidate` (which would let a flip keep serving the
  // OLD state for minutes) stays deliberately out.
  async (c: any) => {
    const payload = maintenanceSetting.read();
    const etag = computeEtag(payload);
    c.header('Cache-Control', 'public, max-age=5, must-revalidate');
    c.header('ETag', etag);
    if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
    return c.json(payload);
  },
);

app.openapi(
  createRoute({
    method: 'put',
    path: '/v1/system/maintenance',
    tags: ['system'],
    summary: 'Update the maintenance config (admin only)',
    ...auth,
    middleware: [supabaseAuth] as const,
    request: {
      body: { content: { 'application/json': { schema: MaintenanceSchema } } },
    },
    responses: {
      200: json(MaintenanceSchema, 'Updated config'),
      ...errors(403, 503),
    },
  }),
  async (c: any) => {
    const userId = c.get('userId') as string;
    const role = await getPlatformRole(userId);
    if (role !== 'admin' && role !== 'super_admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }
    if (!hasDatabase) return c.json({ error: 'Database not configured' }, 503);
    const body = await readJsonObject(c);
    const maintenanceConfig: MaintenanceConfigValue = {
      ...DEFAULT_MAINTENANCE,
      ...(body as Partial<MaintenanceConfigValue>),
      updatedAt: new Date().toISOString(),
    };
    await maintenanceSetting.write(maintenanceConfig);
    return c.json(maintenanceConfig);
  },
);

// ─── Demo request (public lead capture) ─────────────────────────────────────
// POST /v1/system/demo-request — public, unauthenticated. The marketing site's
// "Book a demo" qualifier form POSTs the first-step details here (via the web
// server); we email an internal notification to DEMO_LEAD_NOTIFY_EMAIL on every
// submission, whether or not the lead goes on to book a Cal slot. The email uses
// the API's email-provider credentials (AWS Secrets Manager), so the Vercel
// frontend never needs the secret. IP rate-limited; no configured email
// provider is a graceful skip, so lead capture never fails on account of email.
const DemoRequestSchema = z
  .object({
    name: z.string().max(200).optional(),
    email: z.string().email(),
    company_name: z.string().max(200).optional(),
    company_size: z.string().max(50).optional(),
    goal: z.string().max(2000).optional(),
    qualified: z.boolean().optional(),
    source: z.string().max(100).optional(),
  })
  .openapi('DemoRequest');

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/system/demo-request',
    tags: ['system'],
    summary: 'Submit a public demo request (emails an internal notification)',
    middleware: [createDemoRequestRateLimitMiddleware()] as const,
    request: {
      body: { content: { 'application/json': { schema: DemoRequestSchema } } },
    },
    responses: {
      200: json(
        z.object({ ok: z.boolean(), emailed: z.boolean() }).openapi('DemoRequestResult'),
        'Accepted',
      ),
      ...errors(400, 429),
    },
  }),
  async (c: any) => {
    const body = await c.req.json().catch(() => null);
    const email = String(body?.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: 'Invalid email' }, 400);
    }
    const result = await sendDemoRequestNotification({
      name: typeof body.name === 'string' ? body.name : undefined,
      email,
      company_name: typeof body.company_name === 'string' ? body.company_name : undefined,
      company_size: typeof body.company_size === 'string' ? body.company_size : undefined,
      goal: typeof body.goal === 'string' ? body.goal : undefined,
      qualified: typeof body.qualified === 'boolean' ? body.qualified : undefined,
      source: typeof body.source === 'string' ? body.source : undefined,
      user_agent: c.req.header('user-agent')?.slice(0, 500) ?? null,
    });
    if (!result.ok && !('skipped' in result && result.skipped)) {
      console.error('[system/demo-request] notification not sent:', result);
    }
    return c.json({ ok: true, emailed: result.ok });
  },
);

// ─── Stub Endpoints ─────────────────────────────────────────────────────────
// These endpoints are called by the frontend but were never implemented.
// Adding proper stubs stops 404 noise and provides correct responses.

// POST /v1/prewarm — no-op pre-warm. Frontend fires this on login.
app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/prewarm',
    tags: ['system'],
    summary: 'No-op pre-warm (frontend fires this on login)',
    responses: {
      200: json(z.object({ success: z.boolean() }).openapi('Prewarm'), 'ok'),
    },
  }),
  (c: any) => c.json({ success: true }),
);
}
