/**
 * The session-log journal and manifest: `POST /:projectId/sessions/:sessionId/log/journal`
 * and `GET /:projectId/sessions/:sessionId/log/manifest`. Called only by the session's own
 * daemon with its session sandbox credential (the project + session PAT kortixd holds as
 * `KORTIX_TOKEN`). The auth middleware already pins the token's project to the URL's; this
 * file pins its session. Wire and status codes: `@kortix/api-contract/session-log` (`wire.ts`).
 * The writes and their rules: `../session-log-ingest.ts`.
 *
 * The journal body is gzipped JSON. It is not declared as a validated request schema: the
 * OpenAPI validator would call `req.json()` on gzip bytes (same reason as
 * `platform/routes/runtime-projection.ts`). The handler gunzips, caps and validates it.
 */
import { gunzipSync } from 'node:zlib';
import { createRoute, z } from '@hono/zod-openapi';
import {
  SessionLogJournalConflictSchema,
  SessionLogJournalRequestSchema,
  SessionLogJournalResponseSchema,
  SessionLogJournalSeqConflictSchema,
  SessionLogManifestSchema,
  type SessionLogJournalRequest,
} from '@kortix/api-contract/session-log';
import type { Context } from 'hono';
import { config } from '../../config';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { auth, errors, json } from '../../openapi';
import type { AppEnv } from '../../types';
import { projectsApp } from '../lib/app';
import { ingestSessionLogJournal, readSessionLogManifest, type SessionLogScope } from '../session-log-ingest';

const MAX_GZIP_BYTES = 2 * 1024 * 1024;
const MAX_RAW_BYTES = 16 * 1024 * 1024;

const params = z.object({ projectId: z.string(), sessionId: z.string() });

/** The calling box's scope, or null when the credential is not this session's sandbox credential. */
function sandboxScope(c: Context<AppEnv>): SessionLogScope | null {
  const sessionId = c.req.param('sessionId') ?? '';
  const accountId = c.get('accountId');
  if (!isSessionSandboxCredential(c) || c.get('sessionId') !== sessionId || !accountId) return null;
  return { sessionId, projectId: c.req.param('projectId') ?? '', accountId };
}

type BodyRead = { ok: true; body: unknown } | { ok: false; status: 400 | 413; error: string };

/** The JSON body, gunzipped when `Content-Encoding: gzip`, within the caps. */
async function readJournalBody(c: Context<AppEnv>): Promise<BodyRead> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await c.req.arrayBuffer());
  } catch {
    return { ok: false, status: 400, error: 'Could not read request body' };
  }
  if ((c.req.header('content-encoding') ?? '').toLowerCase().includes('gzip')) {
    if (bytes.byteLength > MAX_GZIP_BYTES) return { ok: false, status: 413, error: 'Journal body exceeds 2 MB gzipped' };
    try {
      bytes = gunzipSync(bytes, { maxOutputLength: MAX_RAW_BYTES });
    } catch (err) {
      return (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
        ? { ok: false, status: 413, error: 'Journal body exceeds 16 MB raw' }
        : { ok: false, status: 400, error: 'Journal body is not valid gzip' };
    }
  } else if (bytes.byteLength > MAX_RAW_BYTES) {
    return { ok: false, status: 413, error: 'Journal body exceeds 16 MB raw' };
  }
  try {
    return { ok: true, body: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { ok: false, status: 400, error: 'Journal body is not JSON' };
  }
}

export function registerSessionLogRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/sessions/{sessionId}/log/journal',
      tags: ['projects'],
      summary: 'Journal session-log records from the session daemon',
      description:
        'Body: `SessionLogJournalRequest` as JSON with `Content-Encoding: gzip`, at most 2 MB gzipped and 16 MB raw. ' +
        'Session sandbox credential only. 200 acknowledges every `(message_id, rev)` pair after commit.',
      ...auth,
      request: { params },
      responses: {
        200: json(SessionLogJournalResponseSchema, 'Every pair of the batch, after commit'),
        409: json(SessionLogJournalConflictSchema, 'The batch generation is older than the session generation'),
        422: json(SessionLogJournalSeqConflictSchema, 'A put reuses a seq of its thread; nothing was written'),
        ...errors(400, 403, 404, 413, 503),
      },
    }),
    async (c) => {
      const scope = sandboxScope(c);
      if (!scope) return c.json({ error: 'The session log takes the session sandbox credential' }, 403);
      if (!config.SESSION_LOG_INGEST_ENABLED) return c.json({ error: 'Session log ingest is off' }, 503);
      const read = await readJournalBody(c);
      if (!read.ok) return c.json({ error: read.error }, read.status);
      const parsed = SessionLogJournalRequestSchema.safeParse(read.body);
      if (!parsed.success) {
        return c.json({ error: 'Invalid journal body', issues: parsed.error.issues.slice(0, 5) }, 400);
      }
      // The body as sent: the parse would drop fields this API does not know.
      const outcome = await ingestSessionLogJournal(scope, read.body as SessionLogJournalRequest);
      if (outcome.status === 200) return c.json(outcome.body, 200);
      if (outcome.status === 409) return c.json(outcome.body, 409);
      if (outcome.status === 422) return c.json(outcome.body, 422);
      return c.json(outcome.body, 404);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/log/manifest',
      tags: ['projects'],
      summary: 'Read the session-log manifest for the daemon boot reconcile',
      ...auth,
      request: { params },
      responses: {
        200: json(SessionLogManifestSchema, 'The session generation and every stored message'),
        ...errors(403, 404, 503),
      },
    }),
    async (c) => {
      const scope = sandboxScope(c);
      if (!scope) return c.json({ error: 'The session log takes the session sandbox credential' }, 403);
      if (!config.SESSION_LOG_INGEST_ENABLED) return c.json({ error: 'Session log ingest is off' }, 503);
      const manifest = await readSessionLogManifest(scope);
      if (!manifest) return c.json({ error: 'Session not found' }, 404);
      return c.json(manifest, 200);
    },
  );
}
