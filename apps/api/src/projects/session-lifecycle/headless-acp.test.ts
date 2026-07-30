import { expect, test } from 'bun:test';

import {
  consumeHeadlessAcpSse,
  deliverHeadlessAcpPrompt,
  queueInitialAcpPrompt,
  selectHeadlessPermissionOption,
  shouldScheduleInitialAcpPrompt,
} from './headless-acp';

test('selectHeadlessPermissionOption selects allow-once only', () => {
  expect(
    selectHeadlessPermissionOption({
      options: [
        { optionId: 'reject', kind: 'reject_once' },
        { optionId: 'allow-once', kind: 'allow_once' },
      ],
    }),
  ).toBe('allow-once');
  expect(selectHeadlessPermissionOption({ options: [{ optionId: 'always' }] })).toBeNull();
});

test('consumeHeadlessAcpSse skips poison data and continues with valid envelopes', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('id: 1\ndata: not-json\n\n'));
      controller.enqueue(
        encoder.encode('id: 2\ndata: {"jsonrpc":"2.0","method":"session/update"}\n\n'),
      );
      controller.close();
    },
  });
  const seen: unknown[] = [];

  await consumeHeadlessAcpSse(body, async (eventId, envelope) => {
    seen.push({ eventId, envelope });
  });

  expect(seen).toEqual([
    {
      eventId: 2,
      envelope: { jsonrpc: '2.0', method: 'session/update' },
    },
  ]);
});

test('deliverHeadlessAcpPrompt initializes, creates, streams, persists, and prompts', async () => {
  const calls: Array<{ method: string; rpcMethod: string | null }> = [];
  const persisted: unknown[] = [];
  const persistedEnvelopes: unknown[] = [];

  const delivered = await deliverHeadlessAcpPrompt(
    {
      acpServerId: 'project-session-1',
      acpSessionId: null,
      runtimeHarness: 'codex',
      nativeAgent: 'reviewer',
      projectId: 'project-1',
      projectSessionId: 'project-session-1',
      text: 'inspect this repo',
    },
    {
      request: async (method, _route, _query, _headers, body) => {
        const envelope = body
          ? (JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>)
          : null;
        const rpcMethod = typeof envelope?.method === 'string' ? envelope.method : null;
        calls.push({ method, rpcMethod });
        if (method === 'GET') {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {},
            }),
            { status: 200 },
          );
        }
        const id = envelope?.id;
        if (rpcMethod === 'session/new') {
          return Response.json({
            jsonrpc: '2.0',
            id,
            result: { sessionId: 'codex-native-1' },
          });
        }
        if (rpcMethod === 'session/prompt') {
          return Response.json({
            jsonrpc: '2.0',
            id,
            result: { stopReason: 'end_turn' },
          });
        }
        return Response.json({ jsonrpc: '2.0', id, result: {} });
      },
      persistIdentity: async (identity) => {
        persisted.push(identity);
      },
      persistEnvelope: async (envelope) => {
        persistedEnvelopes.push(envelope);
      },
    },
  );

  expect(delivered).toEqual({ ok: true, acpSessionId: 'codex-native-1' });
  expect(calls).toEqual([
    { method: 'POST', rpcMethod: 'initialize' },
    { method: 'POST', rpcMethod: 'session/new' },
    { method: 'POST', rpcMethod: 'session/set_config_option' },
    { method: 'GET', rpcMethod: null },
    { method: 'POST', rpcMethod: 'session/prompt' },
  ]);
  expect(persisted).toEqual([
    {
      projectId: 'project-1',
      projectSessionId: 'project-session-1',
      acpServerId: 'project-session-1',
      runtimeHarness: 'codex',
      acpSessionId: 'codex-native-1',
    },
  ]);
  expect(persistedEnvelopes).toEqual([
    expect.objectContaining({
      direction: 'client_to_agent',
      envelope: expect.objectContaining({ method: 'initialize' }),
    }),
    expect.objectContaining({
      direction: 'agent_to_client',
      envelope: expect.objectContaining({ result: {} }),
    }),
    expect.objectContaining({
      direction: 'client_to_agent',
      envelope: expect.objectContaining({ method: 'session/new' }),
    }),
    expect.objectContaining({
      direction: 'agent_to_client',
      envelope: expect.objectContaining({
        result: { sessionId: 'codex-native-1' },
      }),
    }),
    expect.objectContaining({
      direction: 'client_to_agent',
      envelope: expect.objectContaining({ method: 'session/set_config_option' }),
    }),
    expect.objectContaining({
      direction: 'agent_to_client',
      envelope: expect.objectContaining({ result: {} }),
    }),
    expect.objectContaining({
      direction: 'client_to_agent',
      envelope: expect.objectContaining({ method: 'session/prompt' }),
    }),
    expect.objectContaining({
      direction: 'agent_to_client',
      envelope: expect.objectContaining({
        result: { stopReason: 'end_turn' },
      }),
    }),
  ]);
});

test('shouldScheduleInitialAcpPrompt selects ACP creates without duplicate post-create delivery', () => {
  expect(
    shouldScheduleInitialAcpPrompt({
      initialPrompt: 'inspect this repo',
      runtimeMetadata: { runtime_transport: 'acp' },
      postCreateOwnsPrompt: false,
      hasSessionRow: true,
    }),
  ).toBe(true);
  expect(
    shouldScheduleInitialAcpPrompt({
      initialPrompt: 'inspect this repo',
      runtimeMetadata: { runtime_transport: 'acp' },
      postCreateOwnsPrompt: true,
      hasSessionRow: true,
    }),
  ).toBe(false);
});

test('queueInitialAcpPrompt persists a deduplicated delivery command and kicks the drain', async () => {
  const enqueued: unknown[] = [];
  let drains = 0;

  await queueInitialAcpPrompt(
    {
      source: 'ui',
      projectId: 'project-1',
      accountId: 'account-1',
      sessionId: 'session-1',
      actorUserId: 'user-1',
      text: 'inspect this repo',
    },
    {
      enqueue: async (input) => {
        enqueued.push(input);
      },
      drain: async () => {
        drains += 1;
      },
    },
  );

  expect(enqueued).toEqual([
    {
      source: 'ui',
      projectId: 'project-1',
      accountId: 'account-1',
      sessionId: 'session-1',
      actorUserId: 'user-1',
      text: 'inspect this repo',
      idempotencyKey: 'initial-acp-prompt:session-1',
    },
  ]);
  expect(drains).toBe(1);
});
