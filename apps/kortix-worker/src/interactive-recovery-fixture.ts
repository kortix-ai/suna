import { expect } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import type { SessionLogItem } from './session-store.ts';
import { mintRootId } from './wire-message-id.ts';

export const questions = [
  {
    header: 'Mode',
    question: 'Choose a test mode.',
    custom: false,
    options: [
      { label: 'Blue', description: 'First.' },
      { label: 'Green', description: 'Second.' },
    ],
  },
];

export async function fixture(
  options: {
    pause?: 'resolved' | 'released';
    steps?: number;
    repeatedCallId?: boolean;
    repeatedQuestionCallId?: boolean;
    secondQuestion?: boolean;
    continuedDoom?: boolean;
    rejectPermissionRelease?: boolean;
    ownerLeaseMs?: number;
    permission?: 'primary' | 'external' | 'doom';
  } = {},
) {
  const items: SessionLogItem[] = [];
  const byKey = new Map<string, SessionLogItem>();
  const providerRequests: any[] = [];
  const effects: string[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let storeUnavailableUntil = 0;
  let failedStoreRequests = 0;
  let rejectPermissionRelease = options.rejectPermissionRelease ?? false;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/rpc')) {
        if (request.method !== 'POST') return new Response(null, { status: 404 });
        const body = (await request.json()) as any;
        if (body.op !== 'exec')
          return Response.json({ ok: false, error: { code: 'unsupported', message: body.op } });
        effects.push(body.args.command);
        return Response.json({
          ok: true,
          value: { stdout: body.args.command, stderr: '', exitCode: 0 },
        });
      }
      if (path.includes('/chat/completions')) {
        const body = (await request.json()) as any;
        providerRequests.push(body);
        const calls = [
          ['bash', { command: 'BEFORE_QUESTION' }],
          ['question', { questions }],
          ['bash', { command: 'AFTER_QUESTION' }],
        ];
        if (options.permission) {
          calls.splice(
            0,
            calls.length,
            ...(options.permission === 'doom'
              ? Array.from({ length: options.continuedDoom ? 4 : 3 }, () => [
                  'bash',
                  { command: 'SAME_PERMISSION_ACTION' },
                ])
              : [
                  ['bash', { command: 'BEFORE_PERMISSION' }],
                  [
                    'bash',
                    {
                      command:
                        options.permission === 'external'
                          ? 'cat /etc/hostname'
                          : 'APPROVE_PERMISSION',
                    },
                  ],
                  ['bash', { command: 'AFTER_PERMISSION' }],
                ]),
          );
        }
        if (options.secondQuestion) calls.push(['question', { questions }]);
        const first = providerRequests.length === 1;
        const repeat =
          (options.repeatedCallId || options.repeatedQuestionCallId) &&
          providerRequests.length === 2;
        const delta = first
          ? {
              role: 'assistant',
              tool_calls: calls.map(([name, args], index) => ({
                index,
                id: `call_${index}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              })),
            }
          : repeat
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: options.repeatedQuestionCallId ? 'call_1' : 'call_0',
                    type: 'function',
                    function: {
                      name: options.repeatedQuestionCallId ? 'question' : 'bash',
                      arguments: JSON.stringify(
                        options.repeatedQuestionCallId
                          ? { questions }
                          : { command: 'NEW_BOUNDARY' },
                      ),
                    },
                  },
                ],
              }
            : {
                role: 'assistant',
                content: options.permission ? 'PERMISSION_RECOVERED' : 'QUESTION_RECOVERED',
              };
        return new Response(
          [
            { choices: [{ index: 0, delta, finish_reason: null }] },
            {
              choices: [
                { index: 0, delta: {}, finish_reason: first || repeat ? 'tool_calls' : 'stop' },
              ],
            },
          ]
            .map(
              (frame) =>
                `data: ${JSON.stringify({ id: 'response', model: body.model, ...frame })}\n\n`,
            )
            .join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (Date.now() < storeUnavailableUntil) {
        failedStoreRequests++;
        return new Response('Store temporarily unavailable', { status: 503 });
      }
      if (request.method === 'GET') return Response.json(items);
      const item = (await request.json()) as SessionLogItem;
      if (
        rejectPermissionRelease &&
        item.kind === 'journal' &&
        item.stream === 'kortix.pi.permission-checkpoints.v1' &&
        item.record.type === 'released'
      )
        return new Response('Release unavailable', { status: 503 });
      const key = request.headers.get('idempotency-key')!;
      if (byKey.has(key))
        return new Response(null, { status: isDeepStrictEqual(byKey.get(key), item) ? 204 : 409 });
      byKey.set(key, structuredClone(item));
      items.push(structuredClone(item));
      if (
        item.kind === 'journal' &&
        item.stream ===
          (options.permission
            ? 'kortix.pi.permission-checkpoints.v1'
            : 'kortix.pi.question-checkpoints.v1') &&
        item.record.type === options.pause
      )
        return new Promise<Response>(() => {});
      return new Response(null, { status: 204 });
    },
  });
  const sessionId = 'question-recovery';
  const sessionID = mintRootId(sessionId);
  const config = {
    port: 0,
    envUrl: server.url + 'rpc',
    envUrlExplicit: true,
    envCwd: '/workspace',
    systemPrompt: 'Follow the user.',
    modelMode: 'real',
    providerId: 'openrouter',
    modelId: 'openai/gpt-4.1',
    gatewayUrl: server.url + 'v1',
    apiKey: 'fixture',
    sessionId,
    kortixToken: 'fixture',
    storeUrl: server.url + 'store',
    turnOwnerLeaseMs: options.ownerLeaseMs ?? 100,
    turnOwnerHeartbeatMs: 20,
    turnAbortPollMs: 10,
  };
  let output = '';
  const start = async () => {
    const code = `import {startWorker} from ${JSON.stringify(import.meta.dir + '/worker.ts')};globalThis.__KORTIX_COMPILED__=${JSON.stringify({ agentConfig: { agent: { build: { steps: options.steps, ...(options.permission ? { permission: options.permission === 'doom' ? { bash: 'allow', doom_loop: 'ask' } : { bash: { '*': 'ask', BEFORE_PERMISSION: 'allow', AFTER_PERMISSION: 'allow' }, external_directory: 'ask' } } : {}) } } } })};const w=await startWorker(${JSON.stringify(config)});console.log('READY_PORT='+w.port);`;
    const child = Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' });
    children.push(child);
    let port: number | undefined;
    void (async () => {
      for await (const chunk of child.stdout as any) {
        const text = new TextDecoder().decode(chunk);
        output += text;
        const match = text.match(/READY_PORT=(\d+)/);
        if (match) port = Number(match[1]);
      }
    })();
    void (async () => {
      for await (const chunk of child.stderr as any) output += new TextDecoder().decode(chunk);
    })();
    const deadline = Date.now() + 8000;
    while (!port && Date.now() < deadline && child.exitCode === null) await Bun.sleep(10);
    if (!port) throw new Error('Worker failed to listen: ' + output.slice(-3000));
    const call = (path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      });
    const read = async (path: string) => {
      const r = await call(path);
      expect(r.status).toBe(200);
      return r.json() as Promise<any>;
    };
    return { child, call, read };
  };
  const until = async <T>(read: () => Promise<T>, match: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + 5000;
    let last: T | undefined;
    while (Date.now() < deadline) {
      last = await read();
      if (match(last)) return last;
      await Bun.sleep(10);
    }
    throw new Error(
      'Question recovery did not settle: ' +
        JSON.stringify({ last, effects, requests: providerRequests.length }) +
        '\n' +
        output.slice(-3000),
    );
  };
  return {
    items,
    allowPermissionRelease: () => {
      rejectPermissionRelease = false;
    },
    outage: (durationMs: number) => {
      storeUnavailableUntil = Date.now() + durationMs;
    },
    failedStoreRequests: () => failedStoreRequests,
    providerRequests,
    effects,
    sessionID,
    start,
    until,
    cleanup: async () => {
      for (const child of children) {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }
      server.stop(true);
    },
  };
}
