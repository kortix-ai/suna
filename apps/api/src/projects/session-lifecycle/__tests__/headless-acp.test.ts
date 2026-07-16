import { describe, expect, test } from 'bun:test';
import { consumeHeadlessAcpSse, selectHeadlessPermissionOption } from '../headless-acp';

describe('headless ACP lifecycle', () => {
  test('only auto-selects a one-turn permission grant', () => {
    expect(selectHeadlessPermissionOption({ options: [
      { optionId: 'allow_always', kind: 'allow_always' },
      { optionId: 'allow_once', kind: 'allow_once' },
    ] })).toBe('allow_once');
    expect(selectHeadlessPermissionOption({ options: [{ optionId: 'allow_always' }] })).toBeNull();
  });

  test('decodes fragmented SSE envelopes in order', async () => {
    const chunks = ['id: 1\nda', 'ta: {"jsonrpc":"2.0","method":"session/update"}\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const seen: unknown[] = [];
    await consumeHeadlessAcpSse(body, async (id, envelope) => { seen.push([id, envelope.method]); });
    expect(seen).toEqual([[1, 'session/update']]);
  });

  // --- Adjudication 3: headless-specific semantics preserved (framing only, byte-identical). ---
  test('a permission-request envelope survives the shared-core swap with id/method/params intact', async () => {
    const permissionRequest = {
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        options: [
          { optionId: 'allow_once', kind: 'allow_once' },
          { optionId: 'allow_always', kind: 'allow_always' },
        ],
      },
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`id: 7\ndata: ${JSON.stringify(permissionRequest)}\n\n`));
        controller.close();
      },
    });
    const seen: Array<[number, unknown]> = [];
    await consumeHeadlessAcpSse(body, async (eventId, envelope) => { seen.push([eventId, envelope]); });
    expect(seen).toEqual([[7, permissionRequest]]);
    // The permission-request-shaped envelope is exactly what
    // selectHeadlessPermissionOption expects — pinning the auto-answer flow
    // end to end at the framing boundary.
    expect(selectHeadlessPermissionOption((seen[0][1] as typeof permissionRequest).params)).toBe('allow_once');
  });

  // --- Adjudication 1: poison intolerance — FIXED DEFECT. -------------------
  // OLD (pre-swap, headless-acp.ts blob 26f4ea416b07f8634b98d0cd3d0994e7c9d98901):
  // `JSON.parse(data.join('\n'))` at line 42 was NOT wrapped in try/catch, so a
  // single malformed `data:` payload threw out of `consumeHeadlessAcpSse` and
  // killed the whole run. Empirically pinned against that exact code before
  // this swap with this fixture — same three-block shape (valid/poison/valid)
  // — and it threw after delivering exactly event 1, never reaching event 3:
  //   `bun test src/projects/session-lifecycle/__tests__/headless-acp.test.ts`
  //   -> 4 pass (poison-dies pin included), `seen` == [1] before the reject.
  // A cron/trigger run dying on one bad SSE frame is a real operational
  // defect (see the WS3-P0-a follow-up note that flagged this exact gap).
  // Adopting `client.ts`-style tolerance (skip the poison block, keep
  // consuming) matches `AcpClient`'s own `consumeSse` behavior — headless runs
  // now survive a poison frame instead of dying; the permission auto-answer
  // flow for any OTHER event in the same stream is unaffected (still delivered
  // in order, still on its own `id`).
  test('FIXED DEFECT: a poison frame is skipped, not fatal — the run continues past it', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 1\ndata: {"a":1}\n\n'));
        controller.enqueue(new TextEncoder().encode('id: 2\ndata: not-json\n\n'));
        controller.enqueue(new TextEncoder().encode('id: 3\ndata: {"a":3}\n\n'));
        controller.close();
      },
    });
    const seen: Array<[number, unknown]> = [];
    await consumeHeadlessAcpSse(body, async (id, envelope) => { seen.push([id, envelope]); });
    expect(seen).toEqual([
      [1, { a: 1 }],
      [3, { a: 3 }],
    ]);
  });

  // --- Adjudication 2: `data:`-line stripping divergence — PURE REFACTOR. ---
  // OLD (pre-swap): `line.slice(5).trimStart()` stripped ALL leading
  // whitespace after `data:`. The shared core (`createSseBlockParser`, same
  // as `client.ts`) strips exactly the one canonical SSE space
  // (`'data: '` -> slice(6), else slice(5)), leaving residual whitespace on a
  // multi-space line. Empirically pinned against the pre-swap code with this
  // exact fixture before the swap: `seen` == `[[1, {a:1}]]` (trimStart fully
  // absorbed the extra spaces). Carried over from the P0-b review (documented
  // for the SSE proxy there, left unpinned) — pinned here for the headless
  // consumer, and see `acp-sse-proxy.test.ts` for the matching proxy-side pin.
  //
  // Verdict: PURE REFACTOR, not a fixed defect. `JSON.parse` ignores
  // insignificant leading whitespace outside string literals, so the
  // envelope this callback receives is byte-identical either way — the
  // divergence is real at the raw `data:` string layer but invisible at the
  // parsed-envelope layer, which is `consumeHeadlessAcpSse`'s only public
  // contract. Checked against the only known real producer
  // (`apps/kortix-sandbox-agent-server/src/routes/acp.ts:79`,
  // `` `id: ${event.id}\ndata: ${JSON.stringify(event.envelope)}\n\n` ``):
  // `JSON.stringify` never emits leading whitespace, so this fixture (three
  // spaces) exercises a shape the real emitter never produces — inert on the
  // one real producer, pinned here purely to close the divergence class.
  test('PURE REFACTOR: a data: line with multiple leading spaces still parses to the identical envelope', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 1\ndata:   {"a":1}\n\n'));
        controller.close();
      },
    });
    const seen: Array<[number, unknown]> = [];
    await consumeHeadlessAcpSse(body, async (id, envelope) => { seen.push([id, envelope]); });
    expect(seen).toEqual([[1, { a: 1 }]]);
  });

  // Regression guard for the no-space SSE convention (`data:X`, no space at
  // all) — both old and new implementations have always handled this
  // identically (`line.slice(5)` either way once there's no leading space to
  // strip); pinned so the swap can't quietly regress it.
  test('a data: line with no leading space still parses correctly', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id: 1\ndata:{"a":1}\n\n'));
        controller.close();
      },
    });
    const seen: Array<[number, unknown]> = [];
    await consumeHeadlessAcpSse(body, async (id, envelope) => { seen.push([id, envelope]); });
    expect(seen).toEqual([[1, { a: 1 }]]);
  });
});
