/**
 * WS3-P1-b — pin-work for the durable ACP envelope persistence laws.
 *
 * Grounding law (docs/superpowers/plans/2026-07-15-cortex-cycle-plan.md): the
 * durable transcript is an append-only ORDERED log of RAW ACP envelopes plus
 * transport metadata; JSONL is a lossless export; markdown/HTML are lossy
 * projections. This file pins the ROUTE-DRIVEN half of that law against
 * `apps/api/src/projects/routes/acp.ts` (`GET .../acp/transcript` — the
 * replay endpoint, and `POST`/`GET .../acp` — the two persist sites):
 *
 *   1. Append-only ordered — `?after=N` replay contract + the DB-level
 *      guarantee ordinal ordering rests on.
 *   2. Idempotence — both persist directions, including the one direction
 *      where the property does NOT hold today (a real, isolated violation,
 *      not a bug this task fixes; see the "VIOLATION" test below).
 *   3. Transport metadata completeness — the exact write/read column shape,
 *      plus the serverId/sequence grounding-gap mapping.
 *
 * Pin 4 (lossless JSONL round-trip) and the SDK-export half of pin 5 (raw
 * survives `acpTranscriptJsonl`) live in the sibling
 * `../lib/acp-envelope-jsonl-lossless.test.ts` — that half needs no DB mock
 * at all, just the SDK's projection functions consumed read-only.
 *
 * Mocking idiom mirrors `acp.session-identity.test.ts` (mock-module +
 * dynamic-import, `../lib/access` / `../runtime-inspection` / `../../shared/db`
 * stubbed, global `fetch` stands in for the daemon-bridge upstream). Unlike
 * that file, this one calls `mock.restore()` in an `afterAll` — defense in
 * depth against `mock.module`'s process-wide registry leaking these
 * envelope-persistence stubs into whichever other test file bun's runner
 * happens to load next in the same process.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { acpSessionEnvelopes, sessionSandboxes } from '@kortix/db';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'sess-envelope-persistence-1';
const EXTERNAL_ID = 'sbx-ext-envelope-1';

type InsertedRow = {
  projectId: string;
  sessionId: string;
  runtimeId: string;
  direction: string;
  envelope: Record<string, unknown>;
  streamEventId: number | null;
};

let insertedRows: InsertedRow[] = [];
let onConflictCalls = 0;
let capturedWhere: unknown[] = [];
let capturedOrderBy: unknown[] = [];
let transcriptSeedRows: unknown[] = [];
let upstreamResponse: Response | null = null;

mock.module('../lib/access', () => ({
  loadProjectForUser: async (_c: unknown, projectId: string) => {
    if (projectId !== PROJECT_ID) return null;
    return { userId: 'user-1', row: { projectId: PROJECT_ID } };
  },
  loadVisibleSession: async (_loaded: unknown, sessionId: string) => {
    if (sessionId !== SESSION_ID) return null;
    return { row: {} };
  },
}));

mock.module('../runtime-inspection', () => ({
  sandboxRuntimeEndpoint: async () => ({
    url: 'https://box.example',
    headers: { 'content-type': 'application/json' },
    serviceKey: 'svc-key',
  }),
  inspectSandboxRuntime: async () => ({
    runtime: 'acp',
    runtimeReady: true,
    acpServerId: 'acp-server-1',
    acpHarness: null,
    bootError: null,
  }),
}));

mock.module('../lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));

mock.module('../lib/acp-session-identity', () => ({
  persistAcpSessionIdentity: async () => {},
}));

mock.module('../../shared/db', () => ({
  db: {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => {
          if (table === sessionSandboxes) {
            return { limit: async () => [{ externalId: EXTERNAL_ID }] };
          }
          // acpSessionEnvelopes transcript query.
          capturedWhere.push(cond);
          return {
            orderBy: (ord: unknown) => {
              capturedOrderBy.push(ord);
              return Promise.resolve(transcriptSeedRows);
            },
          };
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (v: InsertedRow) => ({
        onConflictDoNothing: async () => {
          onConflictCalls += 1;
          insertedRows.push(v);
        },
      }),
    }),
  },
}));

const { projectsApp } = await import('../lib/app');
await import('./acp');

const realFetch = globalThis.fetch;

beforeEach(() => {
  insertedRows = [];
  onConflictCalls = 0;
  capturedWhere = [];
  capturedOrderBy = [];
  transcriptSeedRows = [];
  upstreamResponse = null;
  globalThis.fetch = (async (_url: unknown, _init: unknown) => {
    if (!upstreamResponse) throw new Error('no upstream response stubbed');
    // `.clone()` so a test that drives multiple requests off one stubbed
    // Response (e.g. the byte-identical-retry violation test below) doesn't
    // hit "Body already used" — each fetch gets an independently readable body.
    return upstreamResponse.clone();
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  // Defense in depth (P1-a review note): `mock.module`'s registry is
  // process-wide, not file-scoped. Without this, these stubs for
  // `../../shared/db` / `../lib/access` / `../runtime-inspection` would keep
  // shadowing the real modules for whichever test file bun's single-process
  // runner loads next.
  mock.restore();
});

function postAcp(body: Record<string, unknown>) {
  return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getAcpStream() {
  return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
  });
}

function getTranscript(query = '') {
  return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp/transcript${query}`);
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(raw: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function drain(body: ReadableStream<Uint8Array> | null) {
  if (!body) return;
  const reader = body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

function transcriptRow(ordinal: number, direction: string) {
  return {
    ordinal,
    direction,
    streamEventId: null,
    envelope: { jsonrpc: '2.0', method: 'session/update' },
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

/**
 * Reconstructs enough of a drizzle `SQL` fragment's rendered text + bound
 * parameters to make assertions without depending on a real Postgres dialect
 * — `StringChunk`s concatenate, `Param`s become `?` (and are collected),
 * nested `SQL` fragments (from `and(...)`, `gt(...)`, etc.) recurse, and
 * column references render as `col:<db_column_name>`. Verified empirically
 * against this exact schema/query shape before use (see the WS3-P1-b task
 * report for the introspection transcript).
 */
function flatten(sqlObj: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  function walk(node: any): string {
    if (node && Array.isArray(node.queryChunks)) return node.queryChunks.map(walk).join('');
    if (node && node.constructor?.name === 'StringChunk') {
      return Array.isArray(node.value) ? node.value.join('') : String(node.value ?? '');
    }
    if (node && node.constructor?.name === 'Param') {
      params.push(node.value);
      return '?';
    }
    if (node && typeof node.constructor?.name === 'string' && node.constructor.name.startsWith('Pg')) {
      return `col:${node.name ?? '?'}`;
    }
    return '';
  }
  return { text: walk(sqlObj), params };
}

function repoFile(...segments: string[]): string {
  // apps/api/src/projects/routes -> repo root is 5 levels up.
  return join(import.meta.dir, '../../../../../', ...segments);
}

// ═══════════════════════════════════════════════════════════════════════
// Pin 1 — append-only ordered: ordinals strictly increase; `?after=N`
// replay returns exactly the rows with ordinal > N, in ascending order.
// ═══════════════════════════════════════════════════════════════════════
describe('Pin 1 — append-only ordered (GET .../acp/transcript)', () => {
  test('no ?after: WHERE has no ">" (gt) condition; results pass through in whatever order the query returned, unmodified', async () => {
    transcriptSeedRows = [transcriptRow(10, 'client_to_agent'), transcriptRow(11, 'agent_to_client'), transcriptRow(12, 'agent_to_client')];
    const res = await getTranscript();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envelopes).toEqual(transcriptSeedRows);
    const { text, params } = flatten(capturedWhere.at(-1));
    expect(text).not.toContain(' > ');
    expect(params).toEqual([PROJECT_ID, SESSION_ID]);
  });

  test('?after=11 adds gt(ordinal, 11) to the WHERE — the replay cursor is bound as a query parameter, not string-interpolated', async () => {
    transcriptSeedRows = [transcriptRow(12, 'agent_to_client')];
    await getTranscript('?after=11');
    const { text, params } = flatten(capturedWhere.at(-1));
    expect(text).toContain(' > ');
    expect(params).toEqual([PROJECT_ID, SESSION_ID, 11]);
  });

  test('the ORDER BY is always ascending on ordinal — never desc, never a different column', async () => {
    transcriptSeedRows = [];
    await getTranscript('?after=5');
    expect(flatten(capturedOrderBy.at(-1)).text).toBe('col:ordinal asc');
    await getTranscript();
    expect(flatten(capturedOrderBy.at(-1)).text).toBe('col:ordinal asc');
  });

  test.each([['0'], ['-5'], ['abc'], ['']])(
    '?after=%s is treated as "no cursor" (Number.isSafeInteger(after) && after > 0 guard) — same WHERE as no ?after at all',
    async (afterValue) => {
      transcriptSeedRows = [];
      await getTranscript(`?after=${afterValue}`);
      const { text, params } = flatten(capturedWhere.at(-1));
      expect(text).not.toContain(' > ');
      expect(params).toEqual([PROJECT_ID, SESSION_ID]);
    },
  );

  test('schema: ordinal is a GENERATED ALWAYS AS IDENTITY primary key — a single global monotonic sequence for the whole table, not app-assigned and not scoped per session', () => {
    const col = acpSessionEnvelopes.ordinal as unknown as { primary: boolean; generatedIdentity: unknown };
    expect(col.primary).toBe(true);
    expect(col.generatedIdentity).toEqual({ type: 'always' });
    // "always" identity: Postgres rejects an app-supplied value unless the
    // insert explicitly opts in with OVERRIDING SYSTEM VALUE. Neither write
    // site does — confirmed below — so ordinal ordering can never be forged
    // by application code, only by the DB's own counter.
  });

  test('neither persist call site (interactive routes/acp.ts, headless session-lifecycle/engine.ts) ever supplies "ordinal" in .values() — grep-pinned, not just read', () => {
    const routeSrc = readFileSync(repoFile('apps/api/src/projects/routes/acp.ts'), 'utf8');
    const engineSrc = readFileSync(repoFile('apps/api/src/projects/session-lifecycle/engine.ts'), 'utf8');
    for (const src of [routeSrc, engineSrc]) {
      const insertBlocks = src.match(/db\.insert\(acpSessionEnvelopes\)\.values\(\{[\s\S]*?\}\)/g) ?? [];
      expect(insertBlocks.length).toBeGreaterThan(0);
      for (const block of insertBlocks) expect(block).not.toContain('ordinal');
    }
  });

  test('runtime evidence: an actual POST persist never includes "ordinal" in the captured .values() payload', async () => {
    upstreamResponse = jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    await postAcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(insertedRows.length).toBeGreaterThan(0);
    for (const row of insertedRows) expect(Object.keys(row)).not.toContain('ordinal');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Pin 2 — idempotence. Both persist directions call onConflictDoNothing(),
// but the property only actually HOLDS (is DB-enforced) for one of them.
// ═══════════════════════════════════════════════════════════════════════
describe('Pin 2 — idempotence', () => {
  test('client_to_agent persist calls onConflictDoNothing(); streamEventId is always null for this direction (no SSE event id exists for a client-originated request)', async () => {
    upstreamResponse = jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    await postAcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const clientRow = insertedRows.find((r) => r.direction === 'client_to_agent');
    expect(clientRow).toBeDefined();
    expect(clientRow!.streamEventId).toBeNull();
    expect(onConflictCalls).toBeGreaterThan(0);
  });

  test('SSE-proxy persist populates a non-null streamEventId (the SSE block id) — the direction the DB\'s unique index actually protects', async () => {
    upstreamResponse = sseResponse('id: 7\ndata: {"jsonrpc":"2.0","method":"session/update","params":{}}\n\n');
    const res = await getAcpStream();
    await drain(res.body);
    const sseRow = insertedRows.find((r) => r.direction === 'agent_to_client' && r.streamEventId !== null);
    expect(sseRow).toBeDefined();
    expect(sseRow!.streamEventId).toBe(7);
  });

  test('a duplicate SSE block id is forwarded to the insert twice, byte-identical, unchanged — the proxy does not self-dedupe (mirrors acp-sse-proxy.test.ts\'s pinned "dedup is the DB layer\'s job" contract); onConflictDoNothing() is what makes the SECOND attempt a no-op in real Postgres', async () => {
    upstreamResponse = sseResponse(
      'id: 9\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"n":1}}\n\n'
      + 'id: 9\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"n":1}}\n\n',
    );
    const res = await getAcpStream();
    await drain(res.body);
    const dupRows = insertedRows.filter((r) => r.direction === 'agent_to_client' && r.streamEventId === 9);
    expect(dupRows).toHaveLength(2);
    expect(dupRows[0]).toEqual(dupRows[1]);
    expect(onConflictCalls).toBeGreaterThanOrEqual(2);
  });

  test('schema: the ONLY unique index covering (direction, streamEventId) is PARTIAL — scoped to "stream_event_id IS NOT NULL" — rows with a null streamEventId are outside its protection', () => {
    const cfg = getTableConfig(acpSessionEnvelopes);
    const streamIdx = cfg.indexes.find((i) => i.config.name === 'idx_acp_session_envelopes_stream_event');
    expect(streamIdx).toBeDefined();
    const idxCfg = (streamIdx as unknown as { config: { unique: boolean; columns: Array<{ name: string }>; where: unknown } }).config;
    expect(idxCfg.unique).toBe(true);
    expect(idxCfg.columns.map((c) => c.name)).toEqual(['session_id', 'direction', 'stream_event_id']);
    expect(flatten(idxCfg.where).text.trim()).toBe('IS NOT NULL');

    // The only OTHER unique index on this table is on event_id — but every
    // insert supplies a fresh defaultRandom() UUID (schema line ~711), never
    // reused across rows, so it can never catch a duplicate submission
    // either. There is no third mechanism.
    const eventIdx = cfg.indexes.find((i) => i.config.name === 'idx_acp_session_envelopes_event_id');
    const eventIdxCfg = (eventIdx as unknown as { config: { unique: boolean; columns: Array<{ name: string }> } }).config;
    expect(eventIdxCfg.unique).toBe(true);
    expect(eventIdxCfg.columns.map((c) => c.name)).toEqual(['event_id']);
    expect(cfg.indexes.filter((i) => i.config.unique)).toHaveLength(2);
  });

  test('VIOLATION (pin 2, client-direction sub-claim): a byte-identical retried client_to_agent POST produces a SECOND row, not a no-op — the "(direction, streamEventId) duplicate is a no-op" property does NOT hold for this direction', async () => {
    upstreamResponse = jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    await postAcp(body);
    await postAcp(body); // byte-identical retry — e.g. a client-side network retry.

    const clientRows = insertedRows.filter((r) => r.direction === 'client_to_agent');
    // The app issues the same call shape both times (no app-level self-dedup
    // — matches the proxy's documented "dedup is the DB's job" contract), and
    // both calls DO route through onConflictDoNothing(). But per the schema
    // pin directly above: streamEventId is null for both (this direction
    // never has one), the partial unique index explicitly excludes NULLs, and
    // event_id is a fresh random UUID on every insert. Nothing in the schema
    // can make the second attempt collide, so a real Postgres would accept
    // BOTH rows. This mock cannot execute Postgres constraint enforcement,
    // but it does prove the two necessary preconditions for the violation:
    // (a) two structurally-identical insert attempts happen, and (b) both
    // have a streamEventId the schema pin above proves is unprotected.
    expect(clientRows).toHaveLength(2);
    expect(clientRows[0]).toEqual(clientRows[1]);
    expect(clientRows[0]!.streamEventId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Pin 3 — transport metadata completeness + the serverId/sequence
// grounding-gap mapping (report+ledger material, not a migration).
// ═══════════════════════════════════════════════════════════════════════
describe('Pin 3 — transport metadata completeness', () => {
  test('every persisted row (both directions) carries exactly the app-supplied columns: projectId, sessionId, runtimeId, direction, envelope, streamEventId — ordinal/createdAt/eventId are DB-generated defaults, never app-supplied', async () => {
    upstreamResponse = jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    await postAcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(insertedRows.length).toBeGreaterThanOrEqual(2); // request + response
    for (const row of insertedRows) {
      expect(Object.keys(row).sort()).toEqual(
        ['direction', 'envelope', 'projectId', 'runtimeId', 'sessionId', 'streamEventId'].sort(),
      );
    }
  });

  test('the /transcript read projection returns ordinal, direction, streamEventId, envelope, createdAt per row; projectId/sessionId/runtimeId/eventId are NOT included per-row (runtime_id appears once, at the envelope-list top level only)', async () => {
    transcriptSeedRows = [transcriptRow(1, 'client_to_agent')];
    const res = await getTranscript();
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['envelopes', 'runtime_id'].sort());
    expect(Object.keys(body.envelopes[0]).sort()).toEqual(
      ['createdAt', 'direction', 'envelope', 'ordinal', 'streamEventId'].sort(),
    );
  });

  // --- Grounding-gap: does "serverId" / "sequence" (named in the grounding
  // doc) exist under other names, or are they genuinely absent? -------------
  //
  // FINDING — "sequence": maps to `streamEventId`, NOT `ordinal`. These are
  // two deliberately DIFFERENT sequences, per the SDK's own comments.
  test('grounding-gap evidence: the SDK itself names the wire event id "sequence" (transcript.ts) and documents it as a DIFFERENT sequence than the persisted row ordinal (client.ts)', () => {
    const transcriptSrc = readFileSync(repoFile('packages/sdk/src/acp/transcript.ts'), 'utf8');
    expect(transcriptSrc).toContain(
      "JSON.stringify({ sequence: event.id, envelope: event.envelope })",
    );
    const clientSrc = readFileSync(repoFile('packages/sdk/src/acp/client.ts'), 'utf8');
    expect(clientSrc).toContain('is a different sequence than');
    expect(clientSrc).toContain('`afterOrdinal` (a row');
  });

  // FINDING — "serverId": maps to `runtimeId` ONLY on the headless write
  // path (runtimeId := the daemon-reported acpServerId). The interactive
  // write path stores the Kortix session id in runtimeId instead — serverId
  // proper is not persisted anywhere for interactive-session envelopes.
  test('grounding-gap evidence: "serverId" exactly equals persisted runtimeId only on the HEADLESS write path; the INTERACTIVE write path stores the Kortix sessionId there instead', () => {
    const sharedSrc = readFileSync(repoFile('apps/api/src/projects/routes/shared.ts'), 'utf8');
    expect(sharedSrc).toContain('runtime_id: runtimeHealth.acpServerId,');
    const routeSrc = readFileSync(repoFile('apps/api/src/projects/routes/acp.ts'), 'utf8');
    expect(routeSrc).toContain('runtimeId: sessionId,');
  });
});
