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
 * gzips its answer for a caller that accepts gzip.
 *
 * The read, `GET /:projectId/sessions/:sessionId/log` (P4.2), is a session read: the
 * transcript route's gate, so a session-bound token (a box's `KORTIX_TOKEN`) reads every
 * session the v1 transcript route serves it. A read claims nothing; the restore claims.
 * Postgres only (`../session-log-read.ts`).
 *
 * The switch preflight, `POST /:projectId/sessions/:sessionId/log/switch-preflight` (P7.1), has the
 * read's gate and changes nothing: the loss report of the stored log on another harness
 * (`switchPreflight`, `@kortix/api-contract/session-log` `capabilities.ts`).
 *
 * The attachment bytes, `GET` and `PUT /:projectId/sessions/:sessionId/log/blobs/:sha256` (P2.13), take
 * the journal's credential and switch. The journal asks for the object of an attachment it writes as
 * `blob:<sha256>`, uploads the bytes when there is none, and writes the `kortix-attachment://` ref both
 * answer into the record (`../session-log-blobs.ts`).
 *
 * The journal body is gzipped JSON. It is not declared as a validated request schema: the
 * OpenAPI validator would call `req.json()` on gzip bytes (same reason as
 * `platform/routes/runtime-projection.ts`). The handler gunzips, caps and validates it.
 */
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { MAX_SESSION_ATTACHMENT_BYTES } from '@kortix/shared';
import {
  SessionLogJournalConflictSchema,
  SessionLogJournalRequestSchema,
  SessionLogJournalResponseSchema,
  SessionLogJournalSeqConflictSchema,
  SessionLogManifestSchema,
  SessionLogPageSchema,
  SessionLogRestoreMissingSchema,
  SessionLogRestoreSchema,
  SessionLogSwitchPreflightRequestSchema,
  SessionLogSwitchPreflightSchema,
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
import { findSessionLogBlob, storeSessionLogBlob } from '../session-log-blobs';
import { ingestSessionLogJournal, readSessionLogManifest, sessionExists, type SessionLogScope } from '../session-log-ingest';
import { readSessionLogPage } from '../session-log-read';
import { claimSessionLog } from '../session-log-restore';
import { sessionLogSwitchPreflight } from '../session-log-switch';
import { resolveSessionBinding } from './lib/route-bindings';

const MAX_GZIP_BYTES = 2 * 1024 * 1024;
const MAX_RAW_BYTES = 16 * 1024 * 1024;

const params = z.object({ projectId: z.string(), sessionId: z.string() });
const blobParams = params.extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const BlobRefSchema = z.object({ ref: z.string().nullable() });
const TOO_LARGE = 'Session-log attachments must be 50 MiB or smaller';
/**
 * Uploads one replica buffers at once. Each holds its body (up to 50 MiB) and Storage's copy, so 4 bound
 * a replica at about 400 MiB of a 4 GiB task, when every box of a fleet sends its history at the first boot
 * on a new daemon. One per session, so one box never holds more than one slot. Above either: 429, and the
 * daemon tries the attachment again at its next collection. A body not read within
 * `SESSION_LOG_BLOB_READ_MS` is cancelled (408), so a stalled client frees its slot.
 */
const MAX_BLOB_UPLOADS = 4;
// replica-local: the sessions with an upload in flight on this replica.
const blobUploads = new Set<string>();

/**
 * The request body, read here and not by `bodyLimit` (which buffers a chunked body before the handler,
 * with no deadline). 'late' when it was not read within `ms`, 'large' above 50 MiB; both cancel the read.
 */
async function readBlobBody(request: Request, ms: number): Promise<Buffer | 'late' | 'large'> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_SESSION_ATTACHMENT_BYTES) return 'large';
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    void reader.cancel().catch(() => {});
  }, ms);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      size += r.value.byteLength;
      if (size > MAX_SESSION_ATTACHMENT_BYTES) {
        void reader.cancel().catch(() => {});
        return 'large';
      }
      chunks.push(r.value);
    }
  } catch {
    return 'late';
  } finally {
    clearTimeout(timer);
  }
  return late ? 'late' : Buffer.concat(chunks);
}

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

/** The session read gate of `GET …/transcript`: the project row when the caller may read the session, else the response. */
async function sessionReadGate(
  c: Context<AppEnv>,
  projectId: string,
  sessionId: string,
): Promise<{ denied: Response } | { denied: null; projectMetadata: unknown }> {
  const binding = await resolveSessionBinding(c, projectId, sessionId, 'read');
  if (binding.kind === 'error') return { denied: binding.response };
  const { loaded } = binding;
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
  const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
  return visible ? { denied: null, projectMetadata: loaded.row.metadata } : { denied: c.json({ error: 'Not found' }, 404) };
}

export function registerSessionLogRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/log/blobs/{sha256}',
      tags: ['projects'],
      summary: 'Find the stored object of a session-log attachment by its sha256',
      description: 'Session sandbox credential only. `{ ref }`: the `kortix-attachment://` ref of the object, or null when the session has none.',
      ...auth,
      request: { params: blobParams },
      responses: { 200: json(BlobRefSchema, 'The object ref, or null'), ...errors(400, 403, 404, 503) },
    }),
    async (c) => {
      const scope = sandboxScope(c);
      if (!scope) return c.json({ error: 'The session log takes the session sandbox credential' }, 403);
      if (!config.SESSION_LOG_INGEST_ENABLED) return c.json({ error: 'Session log ingest is off' }, 503);
      if (!(await sessionExists(scope))) return c.json({ error: 'Session not found' }, 404);
      return c.json({ ref: await findSessionLogBlob(scope, c.req.valid('param').sha256) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/sessions/{sessionId}/log/blobs/{sha256}',
      tags: ['projects'],
      summary: 'Store the bytes of a session-log attachment',
      description:
        'Body: the raw bytes, `Content-Type` = their MIME type, at most 50 MiB. Session sandbox credential only. ' +
        'The body sha256 must equal the path sha256 (else 400). Stored once per session and sha256; answers the object `{ ref }`. ' +
        '429 when 4 uploads, or one of this session, are already in flight on this replica. 408 when the body is not received ' +
        'within 60 s (`SESSION_LOG_BLOB_READ_MS`). Request deadline 95 s.',
      ...auth,
      request: { params: blobParams },
      responses: { 200: json(BlobRefSchema.extend({ ref: z.string() }), 'The object ref'), ...errors(400, 403, 404, 408, 413, 429, 503) },
    }),
    async (c) => {
      const scope = sandboxScope(c);
      if (!scope) return c.json({ error: 'The session log takes the session sandbox credential' }, 403);
      if (!config.SESSION_LOG_INGEST_ENABLED) return c.json({ error: 'Session log ingest is off' }, 503);
      const { sha256 } = c.req.valid('param');
      const mime = (c.req.header('content-type') || 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
      if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) return c.json({ error: 'Invalid Content-Type' }, 400);
      if (blobUploads.size >= MAX_BLOB_UPLOADS || blobUploads.has(scope.sessionId)) {
        c.header('Retry-After', '5');
        return c.json({ error: 'Too many session-log uploads in flight' }, 429);
      }
      blobUploads.add(scope.sessionId);
      try {
        const bytes = await readBlobBody(c.req.raw, config.SESSION_LOG_BLOB_READ_MS);
        if (bytes === 'large') return c.json({ error: TOO_LARGE }, 413);
        if (bytes === 'late') return c.json({ error: 'The body was not received in time' }, 408);
        if (createHash('sha256').update(bytes).digest('hex') !== sha256) return c.json({ error: 'The body sha256 does not match the path' }, 400);
        if (!(await sessionExists(scope))) return c.json({ error: 'Session not found' }, 404);
        return c.json({ ref: await storeSessionLogBlob(scope, sha256, mime, bytes) }, 200);
      } finally {
        blobUploads.delete(scope.sessionId);
      }
    },
  );

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
        ...errors(400, 403, 404, 413, 429, 503),
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
      if (outcome.status === 429) {
        c.header('Retry-After', '2');
        return c.json(outcome.body, 429);
      }
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
        'with `seq < before_seq`, ascending by seq, tombstoned messages left out. Session read permission, ' +
        'the same gate as `GET .../transcript`: a session-bound token reads the sessions that route serves it. ' +
        '404 when the session has no stored log or no such thread.',
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

      const gate = await sessionReadGate(c, projectId, sessionId);
      if (gate.denied) return gate.denied as never;

      const page = await readSessionLogPage({ sessionId, threadId: query.thread ?? null, beforeSeq, limit: limit.value });
      if (!page) return c.json({ error: 'No session log for this session' }, 404);
      if (page === 'unknown_thread') return c.json({ error: 'Unknown thread' }, 404);
      return c.json(page, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/sessions/{sessionId}/log/switch-preflight',
      tags: ['sessions'],
      summary: 'List what a session would lose on another harness',
      description:
        'Read only: claims nothing, changes nothing. Body `{ to: "pi" | "opencode" }`. Answers `SessionLogSwitchPreflight`: ' +
        '`available` and `reason` (`same_harness`, `llm_gateway_off`: a switch that cannot happen is still a 200), ' +
        '`restores` (the project restores session logs; false puts a `history` line first in `losses`), ' +
        '`losses` (each feature or runtime control the stored log uses that `to` handles worse, with counts; `degraded`: ' +
        'lowered or emulated, `lost`) and `unsupported` (everything the source harness handles that `to` handles worse, used or not). ' +
        'The capability manifests are `PI_CAPABILITIES` and `OPENCODE_CAPABILITIES` (`@kortix/api-contract/session-log`). ' +
        'Session read permission, the `GET .../log` gate. 404 when the session has no stored log.',
      ...auth,
      request: { params, body: { content: { 'application/json': { schema: SessionLogSwitchPreflightRequestSchema } }, required: true } },
      responses: {
        200: json(SessionLogSwitchPreflightSchema, 'The loss report'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
      const { projectId, sessionId } = c.req.valid('param');
      const { to } = c.req.valid('json');
      const gate = await sessionReadGate(c, projectId, sessionId);
      if (gate.denied) return gate.denied as never;
      const report = await sessionLogSwitchPreflight({ sessionId, projectMetadata: gate.projectMetadata, to });
      if (!report) return c.json({ error: 'No session log for this session' }, 404);
      return c.json(report, 200);
    },
  );
}
