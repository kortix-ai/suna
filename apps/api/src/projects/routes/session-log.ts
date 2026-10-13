/**
 * The session-log journal and manifest: `POST /:projectId/sessions/:sessionId/log/journal`
 * and `GET /:projectId/sessions/:sessionId/log/manifest`. Called only by the session's own
 * daemon with its session sandbox credential (the project + session PAT kortixd holds as
 * `KORTIX_TOKEN`). The auth middleware already pins the token's project to the URL's; this
 * file pins its session. Wire and status codes: `@kortix/api-contract/session-log` (`wire.ts`).
 * The writes and their rules: `../session-log-ingest.ts`.
 *
 * The restore, `POST /:projectId/sessions/:sessionId/log/restore` (P6.1), takes the same
 * credential: a fresh box's daemon claims the session and reads its whole log
 * (`../session-log-restore.ts`). The app-wide `compressResponse` (`../../middleware/compress.ts`)
 * gzips its answer for a caller that accepts gzip; it falls back to `node:zlib` on the image's Bun 1.2.
 *
 * The read, `GET /:projectId/sessions/:sessionId/log` (P4.2), is the other way round: a
 * project member's session read, never the sandbox credential. Postgres only
 * (`../session-log-read.ts`).
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
  SessionLogPageSchema,
  SessionLogRestoreMissingSchema,
  SessionLogRestoreSchema,
  type SessionLogJournalRequest,
} from '@kortix/api-contract/session-log';
import type { Context } from 'hono';
import { config } from '../../config';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { auth, errors, json } from '../../openapi';
import type { AppEnv } from '../../types';
import { assertProjectCapability, loadVisibleSession } from '../lib/access';
import { projectsApp } from '../lib/app';
import { parseBoundedPositiveInt } from '../lib/serializers';
import { ingestSessionLogJournal, readSessionLogManifest, type SessionLogScope } from '../session-log-ingest';
import { readSessionLogPage } from '../session-log-read';
import { claimSessionLog } from '../session-log-restore';
import { resolveSessionBinding } from './lib/route-bindings';

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

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/sessions/{sessionId}/log/restore',
      tags: ['projects'],
      summary: 'Claim the session and read its whole session log, for a fresh box',
      description:
        'Session sandbox credential only, no body. Raises the session generation by 1 and answers `SessionLogRestore` ' +
        'at that generation: every thread with its live messages in seq order, the rev of every message (tombstones ' +
        'included) and each text stored by reference. A box still journaling at an older generation then gets 409. ' +
        'Gzipped when the request accepts gzip and the body is 1 KiB or more. 404 `no_session_log`: no stored log, nothing claimed.',
      ...auth,
      request: { params },
      responses: {
        200: json(SessionLogRestoreSchema, 'The claimed generation and the whole stored log'),
        404: json(SessionLogRestoreMissingSchema, 'The session has no stored log; nothing was claimed'),
        ...errors(403, 503),
      },
    }),
    async (c) => {
      const scope = sandboxScope(c);
      if (!scope) return c.json({ error: 'The session log takes the session sandbox credential' }, 403);
      if (!config.SESSION_LOG_RESTORE_ENABLED) return c.json({ error: 'Session log restore is off' }, 503);
      const restored = await claimSessionLog(scope);
      if (!restored) return c.json({ error: 'no_session_log' as const }, 404);
      return c.json(restored, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/log',
      tags: ['sessions'],
      summary: 'Read a page of the session log',
      description:
        'One page of one thread of the stored session log (`SessionLogPage`), from Postgres only. ' +
        '`thread` defaults to the root thread; `messages` are the newest `limit` (default 40, max 500) ' +
        'with `seq < before_seq`, ascending by seq, tombstoned messages left out. Session read permission; ' +
        'the session sandbox credential is refused. 404 when the session has no stored log or no such thread.',
      ...auth,
      request: {
        params,
        query: z.object({ thread: z.string().optional(), before_seq: z.string().optional(), limit: z.string().optional() }),
      },
      responses: {
        200: json(SessionLogPageSchema, 'One page of the session log'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
      if (isSessionSandboxCredential(c)) return c.json({ error: 'The session sandbox credential cannot read the session log' }, 403);
      const { projectId, sessionId } = c.req.valid('param');
      const query = c.req.valid('query');
      const limit = parseBoundedPositiveInt(query.limit, 40, 1, 500, 'limit');
      if (!limit.ok) return c.json({ error: limit.error }, 400);
      const beforeSeq = query.before_seq === undefined ? null : Number(query.before_seq);
      if (beforeSeq !== null && (query.before_seq === '' || !Number.isSafeInteger(beforeSeq))) {
        return c.json({ error: 'before_seq must be an integer' }, 400);
      }
      if (query.thread !== undefined && (query.thread.length === 0 || query.thread.length > 256)) {
        return c.json({ error: 'Invalid thread' }, 400);
      }

      const binding = await resolveSessionBinding(c, projectId, sessionId, 'read');
      if (binding.kind === 'error') return binding.response as never;
      const { loaded } = binding;
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
      const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
      if (!visible) return c.json({ error: 'Not found' }, 404);

      const page = await readSessionLogPage({ sessionId, threadId: query.thread ?? null, beforeSeq, limit: limit.value });
      if (!page) return c.json({ error: 'No session log for this session' }, 404);
      if (page === 'unknown_thread') return c.json({ error: 'Unknown thread' }, 404);
      return c.json(page, 200);
    },
  );
}
