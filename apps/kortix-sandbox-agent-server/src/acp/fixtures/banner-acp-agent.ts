import { createInterface } from 'node:readline';

/**
 * Mimics pi-acp 0.0.32: a CLI banner on raw stdout, then the same banner
 * re-sent as a pre-turn `agent_message_chunk` right after `session/new`.
 */
export const BANNER =
  'pi v0.80.6\n---\n\n## Context\n- /workspace/AGENTS.md\n\n---\n' +
  'New version available: v0.83.0 (installed v0.80.6). ' +
  'Run: `npm i -g @earendil-works/pi-coding-agent`\n';

const send = (envelope: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...envelope })}\n`);
};

const chunk = (sessionId: unknown, text: string) => ({
  method: 'session/update',
  params: {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  },
});

process.stdout.write(BANNER);

const lines = createInterface({ input: process.stdin });

lines.on('line', (line) => {
  const envelope = JSON.parse(line) as {
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (envelope.id === undefined || !envelope.method) return;

  if (envelope.method === 'initialize') {
    send({ id: envelope.id, result: { protocolVersion: 1 } });
    return;
  }

  if (envelope.method === 'session/new') {
    send({
      id: envelope.id,
      result: {
        sessionId: 'banner-session',
        _meta: { piAcp: { startupInfo: BANNER } },
      },
    });
    send(chunk('banner-session', BANNER));
    return;
  }

  if (envelope.method === 'session/prompt') {
    send(chunk(envelope.params?.sessionId, 'real model text'));
    send({ id: envelope.id, result: { stopReason: 'end_turn' } });
    return;
  }

  send({ id: envelope.id, result: {} });
});
