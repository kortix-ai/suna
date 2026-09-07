import { expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import type { SessionLogItem } from './session-store.ts';
import { mintRootId } from './wire-message-id.ts';

const questions = [
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

async function fixture(
  options: {
    pause?: 'resolved' | 'released';
    steps?: number;
    repeatedCallId?: boolean;
    secondQuestion?: boolean;
    ownerLeaseMs?: number;
  } = {},
) {
  const items: SessionLogItem[] = [];
  const byKey = new Map<string, SessionLogItem>();
  const providerRequests: any[] = [];
  const effects: string[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let storeUnavailableUntil = 0;
  let failedStoreRequests = 0;
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
        if (options.secondQuestion) calls.push(['question', { questions }]);
        const first = providerRequests.length === 1;
        const repeat = options.repeatedCallId && providerRequests.length === 2;
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
                    id: 'call_0',
                    type: 'function',
                    function: {
                      name: 'bash',
                      arguments: JSON.stringify({ command: 'NEW_BOUNDARY' }),
                    },
                  },
                ],
              }
            : { role: 'assistant', content: 'QUESTION_RECOVERED' };
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
      const key = request.headers.get('idempotency-key')!;
      if (byKey.has(key))
        return new Response(null, { status: isDeepStrictEqual(byKey.get(key), item) ? 204 : 409 });
      byKey.set(key, structuredClone(item));
      items.push(structuredClone(item));
      if (
        item.kind === 'journal' &&
        item.stream === 'kortix.pi.question-checkpoints.v1' &&
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
    const code = `import {startWorker} from ${JSON.stringify(import.meta.dir + '/worker.ts')};globalThis.__KORTIX_COMPILED__=${JSON.stringify({ agentConfig: { agent: { build: { steps: options.steps } } } })};const w=await startWorker(${JSON.stringify(config)});console.log('READY_PORT='+w.port);`;
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
    outage: (durationMs: number) => { storeUnavailableUntil = Date.now() + durationMs; },
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

test('a killed worker restores the question without repeating the preceding shell action or model request', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    expect(
      (
        await first.call(`/session/${f.sessionID}/prompt_async`, {
          parts: [{ type: 'text', text: 'Ask and continue.' }],
        })
      ).status,
    ).toBe(204);
    const pending = await f.until(
      () => first.read('/question'),
      (value) => value.length === 1,
    );
    const before = await first.read(`/session/${f.sessionID}/message`);
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
    expect(f.providerRequests).toHaveLength(1);
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    const restored = await f.until(
      () => replacement.read('/question'),
      (value) => value.length === 1,
    );
    expect(restored).toEqual(pending);
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
    expect(f.providerRequests).toHaveLength(1);
    const after = await replacement.read(`/session/${f.sessionID}/message`);
    expect(after.map((m: any) => m.info.id)).toEqual(before.map((m: any) => m.info.id));
    expect(after.flatMap((m: any) => m.parts.map((p: any) => p.id))).toEqual(
      before.flatMap((m: any) => m.parts.map((p: any) => p.id)),
    );
    expect(
      (await replacement.call(`/question/${pending[0].id}/reply`, { answers: [['Blue']] })).status,
    ).toBe(200);
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) => value.some((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED')),
    );
    await f.until(
      () => replacement.read('/session/status'),
      (value) => !value[f.sessionID] || value[f.sessionID].type === 'idle',
    );
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
    expect(f.providerRequests).toHaveLength(2);
    expect(
      f.providerRequests[1].messages
        .filter((m: any) => m.role === 'tool')
        .map((m: any) => m.content),
    ).toEqual(['BEFORE_QUESTION', 'Mode: Blue', 'AFTER_QUESTION']);
    expect(await replacement.read('/question')).toEqual([]);
    const final = await replacement.read(`/session/${f.sessionID}/message`);
    replacement.child.kill('SIGKILL');
    await replacement.child.exited;
    const again = await f.start();
    expect(await again.read(`/session/${f.sessionID}/message`)).toEqual(final);
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
    expect(f.providerRequests).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
}, 30000);

test('repeated replacement preserves the same unanswered request and the remaining agent step budget', async () => {
  const f = await fixture({ steps: 2 });
  try {
    let current = await f.start();
    await current.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask.' }],
    });
    const pending = await f.until(
      () => current.read('/question'),
      (value) => value.length === 1,
    );
    for (let n = 0; n < 2; n++) {
      current.child.kill('SIGKILL');
      await current.child.exited;
      current = await f.start();
      expect(
        await f.until(
          () => current.read('/question'),
          (value) => value.length === 1,
        ),
      ).toEqual(pending);
      expect(f.effects).toEqual(['BEFORE_QUESTION']);
      expect(f.providerRequests).toHaveLength(1);
    }
    expect(
      (await current.call(`/question/${pending[0].id}/reply`, { answers: [['Blue']] })).status,
    ).toBe(200);
    await f.until(
      () => current.read(`/session/${f.sessionID}/message`),
      (value) => value.some((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED')),
    );
    expect(f.providerRequests).toHaveLength(2);
    expect(f.providerRequests[1].tools ?? []).toEqual([]);
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
  } finally {
    await f.cleanup();
  }
}, 30000);

test('a committed answer survives death before its HTTP acknowledgment and resumes once', async () => {
  const f = await fixture({ pause: 'resolved' });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask.' }],
    });
    const pending = await f.until(
      () => first.read('/question'),
      (value) => value.length === 1,
    );
    const reply = first
      .call(`/question/${pending[0].id}/reply`, { answers: [['Blue']] })
      .catch(() => null);
    await f.until(
      async () => f.items,
      (values) => values.some((item) => item.kind === 'journal' && item.record.type === 'resolved'),
    );
    first.child.kill('SIGKILL');
    await first.child.exited;
    await reply;
    const replacement = await f.start();
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) => value.some((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED')),
    );
    expect(await replacement.read('/question')).toEqual([]);
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
    expect(f.providerRequests).toHaveLength(2);
    expect(
      f.items.filter((item) => item.kind === 'journal' && item.record.type === 'resolved'),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
}, 30000);

test('death after the execution fence interrupts the turn instead of repeating an uncertain boundary', async () => {
  const f = await fixture({ pause: 'released' });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask.' }],
    });
    const pending = await f.until(
      () => first.read('/question'),
      (value) => value.length === 1,
    );
    expect(
      (await first.call(`/question/${pending[0].id}/reply`, { answers: [['Blue']] })).status,
    ).toBe(200);
    await f.until(
      async () => f.items,
      (values) => values.some((item) => item.kind === 'journal' && item.record.type === 'released'),
    );
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    expect(await replacement.read('/question')).toEqual([]);
    const messages = await replacement.read(`/session/${f.sessionID}/message`);
    expect(messages.filter((m: any) => m.info.error?.name === 'MessageAbortedError')).toHaveLength(
      1,
    );
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
    expect(f.providerRequests).toHaveLength(1);
    expect(
      (
        await replacement.call(`/session/${f.sessionID}/message`, {
          parts: [{ type: 'text', text: 'Continue.' }],
        })
      ).status,
    ).toBe(200);
    expect(f.providerRequests).toHaveLength(2);
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
  } finally {
    await f.cleanup();
  }
}, 30000);

test('Stop cancels a restored question and the next prompt still works', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask.' }],
    });
    await f.until(
      () => first.read('/question'),
      (value) => value.length === 1,
    );
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    const pending = await f.until(
      () => replacement.read('/question'),
      (value) => value.length === 1,
    );
    expect((await replacement.call(`/session/${f.sessionID}/abort`, {})).status).toBe(200);
    await f.until(
      () => replacement.read('/question'),
      (value) => value.length === 0,
    );
    expect(
      (await replacement.call(`/question/${pending[0].id}/reply`, { answers: [['Blue']] })).status,
    ).toBe(404);
    expect(
      (
        await replacement.call(`/session/${f.sessionID}/message`, {
          parts: [{ type: 'text', text: 'Continue.' }],
        })
      ).status,
    ).toBe(200);
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
    expect(f.providerRequests).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
}, 30000);

test('replacement at a second question reuses the first answer and completed actions from the same batch', async () => {
  const f = await fixture({ secondQuestion: true });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask twice.' }],
    });
    const pending = await f.until(
      () => first.read('/question'),
      (value) => value.length === 1,
    );
    expect(
      (await first.call(`/question/${pending[0].id}/reply`, { answers: [['Blue']] })).status,
    ).toBe(200);
    const second = await f.until(
      () => first.read('/question'),
      (value) => value.length === 1 && value[0].id !== pending[0].id,
    );
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    expect(
      await f.until(
        () => replacement.read('/question'),
        (value) => value.length === 1,
      ),
    ).toEqual(second);
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
    expect(f.providerRequests).toHaveLength(1);
    expect(
      (await replacement.call(`/question/${second[0].id}/reply`, { answers: [['Green']] })).status,
    ).toBe(200);
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) => value.some((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED')),
    );
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
    expect(f.providerRequests).toHaveLength(2);
    expect(
      f.providerRequests[1].messages
        .filter((m: any) => m.role === 'tool')
        .map((m: any) => m.content),
    ).toEqual(['BEFORE_QUESTION', 'Mode: Blue', 'AFTER_QUESTION', 'Mode: Green']);
  } finally {
    await f.cleanup();
  }
}, 30000);

test('cached tool results apply only to the restored batch when a later provider response reuses a call ID', async () => {
  const f = await fixture({ repeatedCallId: true });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask.' }],
    });
    const pending = await f.until(
      () => first.read('/question'),
      (value) => value.length === 1,
    );
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    await f.until(
      () => replacement.read('/question'),
      (value) => value.length === 1,
    );
    expect(
      (await replacement.call(`/question/${pending[0].id}/reply`, { answers: [['Blue']] })).status,
    ).toBe(200);
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) => value.some((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED')),
    );
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION', 'NEW_BOUNDARY']);
    expect(f.providerRequests).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
}, 30000);

test('a queued prompt on another worker first recovers an abandoned blocking question', async () => {
  const f = await fixture();
  try {
    const first = await f.start();
    const replacement = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask first.' }],
    });
    const pending = await f.until(
      () => first.read('/question'),
      (value) => value.length === 1,
    );
    expect(
      (
        await replacement.call(`/session/${f.sessionID}/prompt_async`, {
          parts: [{ type: 'text', text: 'Run next.' }],
        })
      ).status,
    ).toBe(204);
    first.child.kill('SIGKILL');
    await first.child.exited;
    expect(
      await f.until(
        () => replacement.read('/question'),
        (value) => value.length === 1,
      ),
    ).toEqual(pending);
    expect(
      (await replacement.call(`/question/${pending[0].id}/reply`, { answers: [['Blue']] })).status,
    ).toBe(200);
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) =>
        value.filter((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED'))
          .length === 2,
    );
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
    expect(f.providerRequests).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
}, 30000);


test('a temporary store outage within the owner lease keeps a pending question answerable', async () => {
  const f = await fixture({ ownerLeaseMs: 10000 });
  try {
    const worker = await f.start();
    expect((await worker.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask and continue after storage recovers.' }],
    })).status).toBe(204);
    const pending = await f.until(() => worker.read('/question'), value => value.length === 1);
    f.outage(4200);
    await Bun.sleep(4400);
    expect(f.failedStoreRequests()).toBeGreaterThanOrEqual(6);
    expect(await worker.read('/question')).toEqual(pending);
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
    expect(f.providerRequests).toHaveLength(1);
    expect((await worker.call(`/question/${pending[0].id}/reply`, { answers: [['Blue']] })).status).toBe(200);
    await f.until(() => worker.read(`/session/${f.sessionID}/message`), value => value.some((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED')));
    await f.until(() => worker.read('/session/status'), value => !value[f.sessionID] || value[f.sessionID].type === 'idle');
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
    expect(f.providerRequests).toHaveLength(2);
    expect((await worker.read(`/session/${f.sessionID}/message`)).filter((m: any) => m.info.error)).toEqual([]);
  } finally { await f.cleanup(); }
}, 30000);


test('an expired owner aborts the blocked question and settles the turn after storage returns', async () => {
  const f = await fixture({ ownerLeaseMs: 200 });
  try {
    const worker = await f.start();
    expect((await worker.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask before the long outage.' }],
    })).status).toBe(204);
    await f.until(() => worker.read('/question'), value => value.length === 1);
    f.outage(6500);
    await Bun.sleep(400);
    expect(await worker.read('/question')).toEqual([]);
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
    await Bun.sleep(6400);
    await f.until(() => worker.read('/session/status'), value => !value[f.sessionID] || value[f.sessionID].type === 'idle');
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
    expect(f.providerRequests).toHaveLength(1);
    expect((await worker.read(`/session/${f.sessionID}/message`)).filter((m: any) => m.info.error)).toHaveLength(1);
    expect((await worker.call(`/session/${f.sessionID}/prompt_async`, { parts: [{ type: 'text', text: 'Continue with a new turn.' }] })).status).toBe(204);
    await f.until(() => worker.read(`/session/${f.sessionID}/message`), value => value.some((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED')));
    expect(f.providerRequests).toHaveLength(2);
  } finally { await f.cleanup(); }
}, 30000);
