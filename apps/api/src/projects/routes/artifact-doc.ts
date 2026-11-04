// Live co-editing of doc Artifacts (KRTX-3670, flags `artifacts` + `artifact_comments`), contract v2.
//
//   GET  …/artifacts/{artifactId}/doc           the epoch, the updates after a seq, the flush, the lease (view)
//   POST …/artifacts/{artifactId}/doc/seed      the first update of a new epoch, built from the file     (write)
//   POST …/artifacts/{artifactId}/doc/updates   one Yjs update → the next seq                             (write)
//   POST …/artifacts/{artifactId}/doc/lease     acquire, renew or release the file-writer lease            (write)
//   POST …/artifacts/{artifactId}/doc/flushed   the lease holder wrote the file                          (write)
//   POST …/artifacts/{artifactId}/doc/reset     delete the live state; the next open seeds from the file  (write)
//
// The access check is the save route's (`loadArtifactForCaller`, read or
// write): 404 for an Artifact the caller cannot view, 403 `artifact_read_only`
// for a write without write access to its path in Files. A flag that is off
// answers 403 `feature_disabled`, as the comment routes do. An `html` Artifact
// answers 400 `not_a_doc`. The server never integrates Yjs: it checks an
// update's structure (`checkDocUpdate`) and stores it. Logic lives in
// `artifacts/doc-service.ts`.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auth, errors, json } from '../../openapi';
import { logger } from '../../lib/logger';
import { markInboundAuditHeartbeat } from '../../shared/audit-scope';
import { TokenBucketRateLimiter } from '../../shared/rate-limit';
import { publishArtifactLiveChange } from '../../artifacts/live-publish';
import {
  DOC_BYTE_RATE,
  DOC_COMPACT_ROWS,
  DOC_MARKDOWN_MAX_BYTES,
  DOC_MAX_BYTES_TOTAL,
  DOC_PAGE_MAX_BYTES,
  DOC_SEED_UPDATE_MAX_BYTES,
  DOC_UPDATE_MAX_BYTES,
  DocByteBudget,
  isIncrementalDocPull,
} from '../../artifacts/doc-rules';
import { DOC_MAX_DELETES, DOC_MAX_STRUCTS, checkDocUpdate } from '../../artifacts/doc-yjs';
import {
  ArtifactDocError,
  appendArtifactDocUpdate,
  compactArtifactDoc,
  leaseArtifactDoc,
  markArtifactDocFlushed,
  readArtifactDoc,
  resetArtifactDoc,
  seedArtifactDoc,
} from '../../artifacts/doc-service';
import { loadArtifactForCaller } from '../lib/artifact-access';
import { projectsApp } from '../lib/app';

const ArtifactParams = z.object({ projectId: z.string().uuid(), artifactId: z.string().uuid() });
const COMMENT_FLAGS = ['artifact_comments'] as const;
const Version = z.string().min(1).max(200).openapi({ description: 'The entry version (`entry_version`) of the file.' });
const Holder = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, 'an opaque client id: 1 to 64 of A-Z a-z 0-9 . _ : -')
  .openapi({ description: 'An opaque id of one browser tab (for example a random UUID).' });
const Base64 = z.string().openapi({ description: 'A Yjs (v1) update, standard base64.' });
const Epoch = z.string().uuid().optional().openapi({ description: 'The epoch this write was made in (from GET or the seed). Another epoch → 409 `epoch_mismatch` with the current `epoch`: the doc was reset; rebuild. Omitted: not checked.' });
const MiB = 1024 * 1024;

const DocSchema = z.object({
  seeded: z.boolean().openapi({ description: 'The doc has a live state. False: seed it from the file.' }),
  epoch: z.string().nullable().openapi({ description: 'New on every seed; null when not seeded. A client holding another epoch rebuilds its doc.' }),
  latest_seq: z.number().int().openapi({ description: 'The newest seq; 0 when not seeded.' }),
  updates: z.array(z.object({ seq: z.number().int(), update: z.string().openapi({ description: 'base64' }) })).openapi({
    description: `The updates with seq > after, ascending. A merged (compacted) row carries the highest seq it holds; applying an update twice is a no-op in Yjs. At most ${DOC_PAGE_MAX_BYTES / MiB} MiB of updates per page; no row is larger.`,
  }),
  has_more: z.boolean().openapi({ description: 'More updates follow: ask again with `after` = the last seq of this page.' }),
  flushed: z.object({
    seq: z.number().int().openapi({ description: 'Every update with seq <= this is in the file.' }),
    version: z.string().nullable(),
    markdown: z.string().optional().openapi({ description: 'The file text of that flush. Only with `base=true`.' }),
  }).nullable(),
  lease: z.object({ holder: z.string(), expires_at: z.string() }).nullable().openapi({ description: 'The tab that writes the file, while its lease lasts.' }),
}).openapi('ArtifactDoc');

const LeaseSchema = z.object({
  leader: z.boolean().openapi({ description: 'This tab holds the lease now.' }),
  holder: z.string().nullable(),
  expires_at: z.string().nullable(),
}).openapi('ArtifactDocLease');

const responses = errors(400, 401, 403, 404, 409, 413, 429);
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { 'application/json': { schema } } });

// replica-local: the bucket counts in this process, so the fleet allows the
// rate × API replicas. It stops a runaway client, not a typist: 60 pushes a
// second sustained, bursts up to 240. A client batches its pushes every 50 ms.
const pushLimiter = new TokenBucketRateLimiter('artifact_doc_push');
const PUSH_POLICY = { limit: 240, windowMs: 4_000 };
// replica-local: pushed bytes per person in this process (2 MiB/s, bursts of 4 MiB).
const pushBytes = new DocByteBudget(DOC_BYTE_RATE);

/** A body over `maxSize` bytes answers 413 with `code` before it is parsed. */
function limitBody(path: string, maxSize: number, code: string) {
  projectsApp.use(path, bodyLimit({ maxSize, onError: (c) => c.json({ error: `The request is larger than ${Math.round(maxSize / 1024)} KiB`, code }, 413) }));
}

/** Strict standard base64 → bytes, or why not. */
function decodeBase64(value: string, max: number): Buffer | 'too_large' | 'invalid' {
  if (value.length > Math.ceil(max / 3) * 4) return 'too_large';
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return 'invalid';
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > max ? 'too_large' : bytes;
}

function rateLimited(c: Context, retryAfterMs: number) {
  c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return c.json({ error: 'Too many doc updates: retry shortly', code: 'rate_limited' }, 429);
}

/**
 * The update in the body, or the 400 / 413 / 429 response: size, then the
 * caller's byte budget (`byteKey`, pushes only), then the structural checks.
 */
function updateFrom(c: Context, value: string, input: { max: number; kind: 'push' | 'seed'; byteKey?: string }) {
  const bytes = decodeBase64(value, input.max);
  if (bytes === 'too_large') return { ok: false as const, response: c.json({ error: `One update is at most ${input.max / 1024} KiB decoded`, code: 'update_too_large' }, 413) };
  if (bytes === 'invalid') return { ok: false as const, response: c.json({ error: 'The update is not standard base64', code: 'invalid_update', reason: 'malformed' }, 400) };
  if (input.byteKey) {
    const taken = pushBytes.take(input.byteKey, bytes.length, Date.now());
    if (!taken.allowed) return { ok: false as const, response: rateLimited(c, taken.retryAfterMs) };
  }
  const checked = checkDocUpdate(bytes, input.kind);
  if (!checked.ok) return { ok: false as const, response: c.json({ error: 'The update is not an acceptable Yjs update', code: 'invalid_update', reason: checked.reason }, 400) };
  return { ok: true as const, bytes };
}

function markdownTooLarge(c: Context, markdown: string) {
  if (Buffer.byteLength(markdown, 'utf8') <= DOC_MARKDOWN_MAX_BYTES) return null;
  return c.json({ error: `The Markdown is at most ${DOC_MARKDOWN_MAX_BYTES / MiB} MiB`, code: 'markdown_too_large' }, 413);
}

/** The doc the caller may read or write, gated like the comment routes; 400 `not_a_doc` for a page. */
async function loadDoc(c: Context, mode: 'read' | 'write') {
  const { projectId, artifactId } = c.req.param() as { projectId: string; artifactId: string };
  const loaded = await loadArtifactForCaller(c, projectId, artifactId, mode, COMMENT_FLAGS);
  if (!loaded.ok) return loaded;
  if (loaded.row.type !== 'doc') return { ok: false as const, response: c.json({ error: 'Only a doc Artifact has a live document', code: 'not_a_doc' }, 400) };
  return loaded;
}

function failure(c: Context, err: unknown) {
  if (err instanceof ArtifactDocError) return c.json({ error: err.message, code: err.code, ...(err.detail ?? {}) }, err.status);
  throw err;
}

const CHECKS = `Scanned byte by byte before anything decodes it: only the content the doc editor emits (text, formats, XML elements and text, attributes; \`reason: content_not_allowed\` otherwise), at most ${DOC_MAX_STRUCTS} structs and ${DOC_MAX_DELETES} delete ranges, and no item may name its own client at its own clock or later as origin, right origin or parent; otherwise 400 \`invalid_update\` with a \`reason\`.`;

export function registerArtifactDocRoutes(): void {
  limitBody('/:projectId/artifacts/:artifactId/doc/seed', 8 * MiB, 'doc_too_large');
  limitBody('/:projectId/artifacts/:artifactId/doc/updates', MiB, 'update_too_large');
  limitBody('/:projectId/artifacts/:artifactId/doc/lease', 4 * 1024, 'request_too_large');
  limitBody('/:projectId/artifacts/:artifactId/doc/flushed', 8 * MiB, 'markdown_too_large');
  limitBody('/:projectId/artifacts/:artifactId/doc/reset', 4 * 1024, 'request_too_large');

  projectsApp.openapi(createRoute({
    method: 'get', path: '/{projectId}/artifacts/{artifactId}/doc', tags: ['artifacts'],
    summary: 'Read the live document of a doc Artifact: its epoch, the Yjs updates after a seq, the last flush and the lease',
    ...auth,
    request: {
      params: ArtifactParams,
      query: z.object({
        after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().openapi({ description: 'The last seq the client holds. Default 0.' }),
        base: z.enum(['true', 'false', '1', '0']).optional().openapi({ description: '`true`: include the flushed Markdown.' }),
      }),
    },
    responses: { 200: json(DocSchema, 'The live document'), ...responses },
  }), async (c) => {
    const access = await loadDoc(c, 'read');
    if (!access.ok) return access.response;
    const q = c.req.valid('query');
    const query = { after: q.after ?? 0, base: q.base === 'true' || q.base === '1' };
    // A catch-up pull writes no audit row; a full read (from seq 0, or with the file text) keeps it.
    if (isIncrementalDocPull(query)) markInboundAuditHeartbeat();
    const doc = await readArtifactDoc(access.row.artifactId, query);
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      seeded: doc.seeded,
      epoch: doc.epoch,
      latest_seq: doc.latestSeq,
      updates: doc.updates.map((u) => ({ seq: u.seq, update: Buffer.from(u.bytes).toString('base64') })),
      has_more: doc.hasMore,
      flushed: doc.flushed,
      lease: doc.lease ? { holder: doc.lease.holder, expires_at: doc.lease.expiresAt.toISOString() } : null,
    }, 200);
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/doc/seed', tags: ['artifacts'],
    summary: 'Seed the live document with its first update, built from the file',
    description: `The update is the whole doc built from \`markdown\`, the file text at \`version\` (at most ${DOC_SEED_UPDATE_MAX_BYTES / MiB} MiB decoded; the Markdown at most 1 MiB). It becomes seq 1 of a new \`epoch\` and counts as flushed. It may carry several clients. ${CHECKS} 429 \`rate_limited\` past the same byte rate as pushes. 409 \`doc_seeded\` when the doc already has a live state: GET it instead.`,
    ...auth,
    request: { params: ArtifactParams, body: body(z.object({ update: Base64, markdown: z.string(), version: Version })) },
    responses: { 201: json(z.object({ seq: z.number().int(), epoch: z.string() }), 'Seeded'), ...responses },
  }), async (c) => {
    const access = await loadDoc(c, 'write');
    if (!access.ok) return access.response;
    const input = c.req.valid('json');
    const tooLarge = markdownTooLarge(c, input.markdown);
    if (tooLarge) return tooLarge;
    // The same byte budget as pushes: a seed is up to 2 MiB.
    const update = updateFrom(c, input.update, { max: DOC_SEED_UPDATE_MAX_BYTES, kind: 'seed', byteKey: access.viewer.userId });
    if (!update.ok) return update.response;
    try {
      const seeded = await seedArtifactDoc(access.row.artifactId, { update: update.bytes, markdown: input.markdown, version: input.version, userId: access.viewer.userId });
      publishArtifactLiveChange(access.row.artifactId, 'doc', String(seeded.seq));
      return c.json(seeded, 201);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/doc/updates', tags: ['artifacts'],
    summary: 'Push one Yjs update to the live document',
    description: `Appends the update with the next seq and pings every live socket on the Artifact with \`changed {what: "doc", version: "<seq>"}\`. A push carries the structs of one client at most (a tab pushes only its own changes). ${CHECKS} One update is at most ${DOC_UPDATE_MAX_BYTES / 1024} KiB decoded (413 \`update_too_large\`); past ${DOC_MAX_BYTES_TOTAL / MiB} MiB stored for the doc → 413 \`doc_too_large\` (fall back to saving the file); 409 \`doc_not_seeded\` before the seed or after a reset; 409 \`epoch_mismatch\` (with the current \`epoch\`) when \`epoch\` names another epoch; 429 \`rate_limited\` past ${PUSH_POLICY.limit / (PUSH_POLICY.windowMs / 1000)} pushes or ${DOC_BYTE_RATE.bytesPerSecond / MiB} MiB a second per person.`,
    ...auth,
    request: { params: ArtifactParams, body: body(z.object({ update: Base64, epoch: Epoch })) },
    responses: { 200: json(z.object({ seq: z.number().int() }), 'Appended'), ...responses },
  }), async (c) => {
    const access = await loadDoc(c, 'write');
    if (!access.ok) return access.response;
    const limited = pushLimiter.check(access.viewer.userId, PUSH_POLICY);
    if (!limited.allowed) return rateLimited(c, limited.retryAfterMs ?? 1_000);
    const input = c.req.valid('json');
    const update = updateFrom(c, input.update, { max: DOC_UPDATE_MAX_BYTES, kind: 'push', byteKey: access.viewer.userId });
    if (!update.ok) return update.response;
    try {
      const artifactId = access.row.artifactId;
      const appended = await appendArtifactDocUpdate(artifactId, { update: update.bytes, userId: access.viewer.userId, epoch: input.epoch });
      publishArtifactLiveChange(artifactId, 'doc', String(appended.seq));
      if (appended.rows > DOC_COMPACT_ROWS) {
        void compactArtifactDoc(artifactId).catch((error) => logger.warn('[artifact-doc] compaction failed', {
          artifactId, error: error instanceof Error ? error.message : String(error),
        }));
      }
      return c.json({ seq: appended.seq }, 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/doc/lease', tags: ['artifacts'],
    summary: 'Acquire, renew or release the lease of the tab that writes the file',
    description: 'Acquires when the lease is free, expired or already this holder\'s (the same `holder` from the same person); renews when it is; `release: true` gives it up. Another live holder → `leader: false` and that holder. The lease lasts 15 s; renew it every 5 s. A successful renewal writes no audit row; an acquire, a release, a contested call and a failure do. 409 `doc_not_seeded` before the seed; 409 `epoch_mismatch` (with the current `epoch`) when `epoch` names another epoch.',
    ...auth,
    request: { params: ArtifactParams, body: body(z.object({ holder: Holder, release: z.boolean().optional(), epoch: Epoch })) },
    responses: { 200: json(LeaseSchema, 'The lease now'), ...responses },
  }), async (c) => {
    const access = await loadDoc(c, 'write');
    if (!access.ok) return access.response;
    const input = c.req.valid('json');
    try {
      const lease = await leaseArtifactDoc(access.row.artifactId, { holder: input.holder, userId: access.viewer.userId, release: input.release === true, epoch: input.epoch });
      if (lease.kind === 'renew') markInboundAuditHeartbeat();
      return c.json({ leader: lease.leader, holder: lease.holder, expires_at: lease.expiresAt?.toISOString() ?? null }, 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/doc/flushed', tags: ['artifacts'],
    summary: 'Record that the lease holder wrote the file',
    description: 'After a save of the file (`PUT …/artifacts/{artifactId}`), the lease holder records which updates the file now holds (`seq`), its new `version` and its text. The flush moves only forward: an older `seq` sets nothing. 409 `not_leader` from a tab that does not hold the lease; 400 `invalid_seq` past the newest update; 413 `markdown_too_large` past 1 MiB; 409 `epoch_mismatch` (with the current `epoch`) when `epoch` names another epoch.',
    ...auth,
    request: {
      params: ArtifactParams,
      body: body(z.object({ holder: Holder, seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), version: Version, markdown: z.string(), epoch: Epoch })),
    },
    responses: { 200: json(z.object({ flushed_seq: z.number().int() }), 'The flush now'), ...responses },
  }), async (c) => {
    const access = await loadDoc(c, 'write');
    if (!access.ok) return access.response;
    const input = c.req.valid('json');
    const tooLarge = markdownTooLarge(c, input.markdown);
    if (tooLarge) return tooLarge;
    try {
      const flushed = await markArtifactDocFlushed(access.row.artifactId, { ...input, userId: access.viewer.userId });
      return c.json({ flushed_seq: flushed.flushedSeq }, 200);
    } catch (err) {
      return failure(c, err);
    }
  });

  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/artifacts/{artifactId}/doc/reset', tags: ['artifacts'],
    summary: 'Reset the live document: delete its state and every update',
    description: 'For a doc whose live state a client cannot apply (a poisoned update). The lease holder may reset, and anyone while the lease is free or expired; another live holder → 409 `not_leader`. Deletes the state and every update in one transaction and pings every live socket with `changed {what: "doc", version: "0"}`; every client then rebuilds, and the next open seeds from the file with a new epoch. A doc with no live state answers 200 as well.',
    ...auth,
    request: { params: ArtifactParams, body: body(z.object({ holder: Holder })) },
    responses: { 200: json(z.object({ reset: z.literal(true) }), 'Reset'), ...responses },
  }), async (c) => {
    const access = await loadDoc(c, 'write');
    if (!access.ok) return access.response;
    try {
      const reset = await resetArtifactDoc(access.row.artifactId, { holder: c.req.valid('json').holder, userId: access.viewer.userId });
      publishArtifactLiveChange(access.row.artifactId, 'doc', '0');
      return c.json(reset, 200);
    } catch (err) {
      return failure(c, err);
    }
  });
}
