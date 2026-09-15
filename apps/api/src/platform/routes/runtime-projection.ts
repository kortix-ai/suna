/**
 * POST /v1/platform/runtime-projection — the daemon's sink for its own
 * `/kortix/opencode/state` document.
 *
 * WHY A PUSH AT ALL. The API can already PULL the same document
 * (`session-runtime-projection-refresh.ts`), and that is what serves v1. The
 * push is what removes the last conditional from the story: a pulled
 * projection exists only for sessions somebody has recently opened, while a
 * pushed one exists from the moment the box boots — so the FIRST open of a
 * cold session answers `agents`/`commands`/`config` from Postgres too, and a
 * box that stops right after boot leaves its last true state behind.
 *
 * AUTH — sandbox token only, exactly like `/platform/boot-timeline`. This is
 * the daemon reporting on its OWN session; there is no user action here and
 * therefore no PAT/dashboard fallback. The handler then re-checks that the
 * token's sandbox is genuinely bound to the session it claims to be reporting
 * for, so a sandbox credential can only ever write its own row.
 *
 * BODY may be gzipped (`Content-Encoding: gzip`). The document is ~8.7 KB raw
 * and ~0.9 KB gzipped and this call happens on every boot, so the compression
 * is worth having; it is accepted, not required, because a self-host daemon
 * older than this route sends plain JSON.
 *
 * WIRING (both outside this file, mirroring boot-timeline's own note):
 *   1. `platformApp.route('/runtime-projection', runtimeProjectionRouter)` in
 *      platform/index.ts.
 *   2. `path.endsWith('/runtime-projection')` in `sandboxTokenPathAllowed`
 *      (middleware/auth.ts) — without it every push 401s before the handler.
 */
import { gunzipSync } from 'node:zlib';
import { createRoute, z } from '@hono/zod-openapi';
import { sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';

import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import {
  PROJECTION_MAX_BYTES,
  saveRuntimeProjection,
} from '../../projects/lib/session-runtime-projection';
import { db } from '../../shared/db';
import type { AppEnv } from '../../types';

const RuntimeProjectionRequestSchema = z.object({
  session_id: z.string(),
  /** ISO-8601. The DAEMON's capture clock, not ours — an out-of-order retry
   *  must lose to a newer capture, and only the daemon knows which is newer. */
  captured_at: z.string().optional(),
  projection_etag: z.string().optional(),
  projection: z.record(z.string(), z.unknown()),
});

export const runtimeProjectionRouter = makeOpenApiApp<AppEnv>();

runtimeProjectionRouter.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['platform'],
    summary: 'Relay the in-sandbox runtime projection for server-side custody',
    description:
      'Body: `{session_id, captured_at?, projection_etag?, projection}` as JSON, ' +
      'optionally `Content-Encoding: gzip`. The body is deliberately NOT declared ' +
      'as a validated request schema: the OpenAPI validator would call `req.json()` ' +
      'before the handler runs and reject every gzipped push with a 400 it could ' +
      'not explain. The handler decompresses, caps and validates it instead — see ' +
      '`RuntimeProjectionRequestSchema` in this file, which is the same schema.',
    ...auth,
    responses: {
      200: json(
        z.object({
          ok: z.boolean(),
          stored: z.enum(['stored', 'ignored']),
          etag: z.string(),
        }),
        'Projection accepted (or superseded by a newer capture)',
      ),
      ...errors(400, 403, 413),
    },
  }),
  async (c) => {
    // Sandbox-only: the daemon reporting its OWN runtime. Same posture as
    // boot-timeline, and for the same reason — this is never a user action.
    if (!isSessionSandboxCredential(c, 'worker')) {
      return c.json({ error: 'runtime-projection requires a sandbox token' }, 403);
    }
    const accountId = c.get('accountId');
    const sandboxId = c.get('sandboxId');
    if (!accountId || !sandboxId) {
      return c.json({ error: 'runtime-projection requires a sandbox token' }, 403);
    }

    const decoded = await readProjectionBody(c.req);
    if (!decoded.ok) return c.json({ error: decoded.error }, decoded.status);

    const parsed = RuntimeProjectionRequestSchema.safeParse(decoded.body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid runtime-projection body' }, 400);
    }
    const body = parsed.data;

    // Scope the token's own sandbox back to the session it claims to report
    // for, and to the caller's account. Defense in depth identical to
    // boot-timeline's: a sandbox token can only ever write its OWN session's
    // row, whatever the body says.
    const [sandbox] = await db
      .select({
        sessionId: sessionSandboxes.sessionId,
        projectId: sessionSandboxes.projectId,
        externalId: sessionSandboxes.externalId,
      })
      .from(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sandboxId, sandboxId),
          eq(sessionSandboxes.sessionId, body.session_id),
          eq(sessionSandboxes.accountId, accountId),
          inArray(sessionSandboxes.status, ['provisioning', 'active']),
        ),
      )
      .limit(1);
    if (!sandbox) {
      return c.json({ error: 'sandbox token is not scoped to this session' }, 403);
    }

    const capturedAt = parseCapturedAt(body.captured_at, body.projection);
    const etag = body.projection_etag?.trim() || fallbackEtag(body.projection, capturedAt);

    const stored = await saveRuntimeProjection({
      sessionId: sandbox.sessionId,
      projectId: sandbox.projectId,
      accountId,
      externalId: sandbox.externalId ?? '',
      projectionEtag: etag,
      projection: body.projection,
      capturedAt,
      source: 'daemon_push',
    });

    return c.json({ ok: true, stored, etag });
  },
);

type BodyRead = { ok: true; body: unknown } | { ok: false; error: string; status: 400 | 413 };

/**
 * Read the request body, decompressing a gzipped one, with a hard ceiling.
 *
 * The ceiling is checked on the DECOMPRESSED bytes, which is the only number
 * that matters: a 1 KB gzip bomb decompressing to 500 MB is the failure this
 * guards, and checking `Content-Length` would miss it entirely.
 */
async function readProjectionBody(request: {
  arrayBuffer: () => Promise<ArrayBuffer>;
  header: (name: string) => string | undefined;
}): Promise<BodyRead> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await request.arrayBuffer());
  } catch {
    return { ok: false, error: 'Could not read request body', status: 400 };
  }

  const encoding = (request.header('content-encoding') ?? '').toLowerCase();
  if (encoding.includes('gzip')) {
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: PROJECTION_MAX_BYTES });
    } catch {
      // `maxOutputLength` throws when the body would exceed the cap, so this
      // catch covers both "not gzip" and "too big"; 413 is the honest answer
      // for the case the daemon can act on (it sheds sections and retries).
      return {
        ok: false,
        error: 'Projection body is not valid gzip, or exceeds the size cap',
        status: 413,
      };
    }
  } else if (bytes.byteLength > PROJECTION_MAX_BYTES) {
    return { ok: false, error: 'Projection body exceeds the size cap', status: 413 };
  }

  try {
    return { ok: true, body: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { ok: false, error: 'Projection body is not JSON', status: 400 };
  }
}

/**
 * The daemon's capture clock, or the document's own `built_at`, or now.
 *
 * Never silently "now" when the daemon told us otherwise: the whole
 * out-of-order guard in `saveRuntimeProjection` rests on this being the
 * PRODUCER's clock.
 */
function parseCapturedAt(raw: string | undefined, projection: Record<string, unknown>): Date {
  for (const candidate of [raw, projection.built_at]) {
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return new Date(parsed);
    }
  }
  return new Date();
}

function fallbackEtag(projection: Record<string, unknown>, capturedAt: Date): string {
  const epoch = typeof projection.epoch === 'string' ? projection.epoch : 'no-epoch';
  const seq = typeof projection.seq === 'number' ? projection.seq : -1;
  return `push:${epoch}:${seq}:${capturedAt.toISOString()}`;
}
