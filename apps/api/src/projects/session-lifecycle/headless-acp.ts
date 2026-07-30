import type { HarnessId } from '@kortix/shared/harnesses';
import type { SessionInvocationSource } from './types';

export type HeadlessAcpEnvelope = Record<string, unknown>;

export type HeadlessAcpIdentity = {
  projectId: string;
  projectSessionId: string;
  acpServerId: string;
  runtimeHarness: HarnessId;
  acpSessionId: string;
};

export type HeadlessAcpDependencies = {
  request: (
    method: 'GET' | 'POST',
    route: string,
    query: string,
    headers: Headers,
    body?: Uint8Array,
  ) => Promise<Response>;
  persistIdentity: (identity: HeadlessAcpIdentity) => Promise<void>;
  persistEnvelope: (input: {
    projectId: string;
    sessionId: string;
    runtimeInstanceId: string;
    direction: 'client_to_agent' | 'agent_to_client';
    envelope: HeadlessAcpEnvelope;
    upstreamEventId?: number | null;
  }) => Promise<unknown>;
};

export function shouldScheduleInitialAcpPrompt(input: {
  initialPrompt: string;
  runtimeMetadata: Record<string, unknown>;
  postCreateOwnsPrompt: boolean;
  hasSessionRow: boolean;
}): boolean {
  return (
    input.initialPrompt.trim().length > 0 &&
    input.runtimeMetadata.runtime_transport === 'acp' &&
    !input.postCreateOwnsPrompt &&
    input.hasSessionRow
  );
}

export async function queueInitialAcpPrompt(
  input: {
    source: SessionInvocationSource;
    projectId: string;
    accountId: string;
    sessionId: string;
    actorUserId: string;
    text: string;
  },
  dependencies: {
    enqueue: (input: {
      source: SessionInvocationSource;
      projectId: string;
      accountId: string;
      sessionId: string;
      actorUserId: string | null;
      text: string;
      idempotencyKey: string;
    }) => Promise<void>;
    drain: () => Promise<unknown>;
  },
): Promise<void> {
  await dependencies.enqueue({
    ...input,
    idempotencyKey: `initial-acp-prompt:${input.sessionId}`,
  });
  void dependencies.drain().catch((error) => {
    console.warn('[session-lifecycle] initial ACP prompt drain kick failed', {
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function selectHeadlessPermissionOption(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const options = (params as { options?: unknown }).options;
  if (!Array.isArray(options)) return null;
  for (const option of options) {
    if (!option || typeof option !== 'object') continue;
    const id = (option as { optionId?: unknown }).optionId;
    const kind = (option as { kind?: unknown }).kind;
    if (typeof id === 'string' && (/^allow[_-]?once$/i.test(id) || kind === 'allow_once')) {
      return id;
    }
  }
  return null;
}

function parseSseBlock(block: string): { eventId: number; envelope: HeadlessAcpEnvelope } | null {
  let eventId: number | null = null;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('id:')) eventId = Number(line.slice(3).trim());
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!Number.isSafeInteger(eventId) || eventId === null || data.length === 0) {
    return null;
  }
  try {
    const envelope = JSON.parse(data.join('\n')) as HeadlessAcpEnvelope;
    return { eventId, envelope };
  } catch (error) {
    console.warn('[session-lifecycle] skipping poison ACP SSE event', {
      eventId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function consumeHeadlessAcpSse(
  body: ReadableStream<Uint8Array>,
  onEnvelope: (eventId: number, envelope: HeadlessAcpEnvelope) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const abort = () => {
    void reader.cancel();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done }).replaceAll('\r\n', '\n');
      const blocks = pending.split('\n\n');
      pending = blocks.pop() ?? '';
      if (done && pending.trim()) blocks.push(pending);
      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (parsed) await onEnvelope(parsed.eventId, parsed.envelope);
      }
      if (done) return;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export async function deliverHeadlessAcpPrompt(
  input: {
    acpServerId: string;
    acpSessionId: string | null;
    runtimeHarness: HarnessId;
    nativeAgent: string | null;
    projectId: string;
    projectSessionId: string;
    text: string;
  },
  dependencies: HeadlessAcpDependencies,
): Promise<{ ok: boolean; acpSessionId: string | null }> {
  let rpcId = Date.now();
  const route = `/kortix/acp/${encodeURIComponent(input.acpServerId)}`;
  const query = `?agent=${encodeURIComponent(input.runtimeHarness)}`;
  let runtimeInstanceId = input.acpServerId;

  const postEnvelope = async (
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> => {
    await dependencies.persistEnvelope({
      projectId: input.projectId,
      sessionId: input.projectSessionId,
      runtimeInstanceId,
      direction: 'client_to_agent',
      envelope: request,
    });
    const body = new TextEncoder().encode(JSON.stringify(request));
    const response = await dependencies.request(
      'POST',
      route,
      query,
      new Headers({ 'Content-Type': 'application/json' }),
      body,
    );
    if (!response.ok) {
      throw new Error(`ACP request returned HTTP ${response.status}`);
    }
    if (response.status === 202 || response.status === 204) return null;
    runtimeInstanceId = response.headers.get('x-kortix-acp-runtime-instance') ?? runtimeInstanceId;
    const envelope = (await response.json()) as Record<string, unknown>;
    await dependencies.persistEnvelope({
      projectId: input.projectId,
      sessionId: input.projectSessionId,
      runtimeInstanceId,
      direction: 'agent_to_client',
      envelope,
    });
    return envelope;
  };

  const call = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const envelope = await postEnvelope({
      jsonrpc: '2.0',
      id: rpcId++,
      method,
      params,
    });
    if (!envelope || (!('result' in envelope) && !('error' in envelope))) {
      throw new Error(`ACP ${method} returned no JSON-RPC response`);
    }
    const error =
      envelope.error && typeof envelope.error === 'object' && !Array.isArray(envelope.error)
        ? (envelope.error as Record<string, unknown>)
        : null;
    if (error) {
      throw new Error(typeof error.message === 'string' ? error.message : `ACP ${method} failed`);
    }
    return envelope.result && typeof envelope.result === 'object' && !Array.isArray(envelope.result)
      ? (envelope.result as Record<string, unknown>)
      : {};
  };

  let acpSessionId = input.acpSessionId;
  try {
    await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'kortix-api',
        title: 'Kortix Automations',
        version: '1',
      },
    });
    if (acpSessionId) {
      await call('session/load', {
        sessionId: acpSessionId,
        cwd: '/workspace',
        mcpServers: [],
      });
    } else {
      const created = await call('session/new', {
        cwd: '/workspace',
        mcpServers: [],
      });
      acpSessionId = typeof created.sessionId === 'string' ? created.sessionId : null;
      if (!acpSessionId) {
        throw new Error('ACP session/new returned no sessionId');
      }
      await dependencies.persistIdentity({
        projectId: input.projectId,
        projectSessionId: input.projectSessionId,
        acpServerId: input.acpServerId,
        runtimeHarness: input.runtimeHarness,
        acpSessionId,
      });
    }
    if (input.nativeAgent) {
      await call('session/set_config_option', {
        sessionId: acpSessionId,
        configId: 'mode',
        value: input.nativeAgent,
      });
    }

    const stream = await dependencies.request(
      'GET',
      route,
      query,
      new Headers({ Accept: 'text/event-stream' }),
    );
    if (!stream.ok || !stream.body) {
      throw new Error(`ACP stream returned HTTP ${stream.status}`);
    }
    const streamRuntimeInstanceId =
      stream.headers.get('x-kortix-acp-runtime-instance') ?? runtimeInstanceId;

    const streamAbort = new AbortController();
    const streamTask = consumeHeadlessAcpSse(
      stream.body,
      async (eventId, envelope) => {
        if (envelope.method === 'kortix/cursor') return;
        await dependencies.persistEnvelope({
          projectId: input.projectId,
          sessionId: input.projectSessionId,
          runtimeInstanceId: streamRuntimeInstanceId,
          direction: 'agent_to_client',
          upstreamEventId: eventId,
          envelope,
        });
        if (!('id' in envelope) || typeof envelope.method !== 'string') {
          return;
        }
        const params =
          envelope.params && typeof envelope.params === 'object' && !Array.isArray(envelope.params)
            ? (envelope.params as Record<string, unknown>)
            : {};
        if (envelope.method === 'session/request_permission') {
          const optionId = selectHeadlessPermissionOption(params);
          await postEnvelope({
            jsonrpc: '2.0',
            id: envelope.id,
            result: optionId
              ? {
                  outcome: {
                    outcome: 'selected',
                    optionId,
                  },
                }
              : { outcome: { outcome: 'cancelled' } },
          });
          return;
        }
        await postEnvelope({
          jsonrpc: '2.0',
          id: envelope.id,
          error: {
            code: -32601,
            message: 'Interactive request unavailable in this headless session',
          },
        });
      },
      streamAbort.signal,
    ).catch((error) => {
      if (!streamAbort.signal.aborted) throw error;
    });

    try {
      const prompt = call('session/prompt', {
        sessionId: acpSessionId,
        prompt: [{ type: 'text', text: input.text }],
      });
      const completed = await Promise.race([
        prompt,
        streamTask.then(() => {
          throw new Error('ACP event stream closed before the prompt completed');
        }),
      ]);
      if (typeof completed.stopReason !== 'string') {
        throw new Error('ACP prompt returned no stopReason');
      }
    } finally {
      streamAbort.abort();
      await streamTask;
    }
    return { ok: true, acpSessionId };
  } catch (error) {
    console.warn('[session-lifecycle] ACP prompt delivery failed', {
      sessionId: input.projectSessionId,
      harness: input.runtimeHarness,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, acpSessionId };
  }
}
