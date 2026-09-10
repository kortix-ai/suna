import { expect, test } from 'bun:test';
import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { installCustomAgent } from './custom-agent.ts';

function agent() {
  return new Agent({
    initialState: {
      model: {
        id: 'gpt-4o-mini',
        name: 'Test',
        api: 'openai-completions',
        provider: 'openai',
        baseUrl: 'http://localhost',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000,
      },
      tools: [],
      messages: [],
    },
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: 'done',
        reason: 'stop',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          api: 'openai-completions',
          provider: 'openai',
          model: 'gpt-4o-mini',
          timestamp: Date.now(),
          stopReason: 'stop',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
      return stream;
    },
  });
}
const identity = { agentName: 'reviewer', sessionId: 'session', sourceSha: 'a'.repeat(40) };

test('custom state persists from callbacks and blocks detached calls after a callback or shutdown', async () => {
  const a = agent();
  const items: any[] = [];
  let state: any;
  let counter: any;
  const custom = await installCustomAgent(a, { cwd: '/workspace' } as any, identity, ctx => {
    state = ctx.state;
    return {
      initialize: async () => { counter = await state.open('counter', { schemaVersion: 1, initialValue: 0 }); },
      beforeToolCall: async () => { await counter.update((n: number) => n + 1); return undefined; },
      shutdown: async () => { await counter.update((n: number) => n + 1); },
    };
  }, undefined, { read: async () => structuredClone(items), append: async item => { items.push(structuredClone(item)); } });
  await expect(counter.update((n: number) => n + 1)).rejects.toThrow(/active callback/);
  await custom.close();
  expect(items.map(item => item.record.value)).toEqual([0, 1]);
  await expect(state.open('late', { schemaVersion: 1, initialValue: 0 })).rejects.toThrow(/active callback/);
});

test('custom lifecycle initializes once and receives native events for each turn before shutdown', async () => {
  const a = agent();
  const seen: string[] = [];
  const custom = await installCustomAgent(a, { cwd: '/workspace' } as any, identity, () => ({
    initialize: () => {
      seen.push('initialize');
    },
    onEvent: (event) => {
      if (['agent_start', 'turn_start', 'turn_end', 'agent_end'].includes(event.type))
        seen.push(event.type);
    },
    shutdown: () => {
      seen.push('shutdown');
    },
  }));
  await a.prompt('one');
  await a.prompt('two');
  await custom.close();
  await custom.close();
  expect(seen).toEqual([
    'initialize',
    'agent_start',
    'turn_start',
    'turn_end',
    'agent_end',
    'agent_start',
    'turn_start',
    'turn_end',
    'agent_end',
    'shutdown',
  ]);
});

test('a failed native hook terminates one turn and the next prompt can recover', async () => {
  const a = agent();
  let fail = true;
  const custom = await installCustomAgent(a, { cwd: '/workspace' } as any, identity, () => ({
    transformContext: async (messages) => {
      if (fail) throw new Error('custom context failure');
      return messages;
    },
  }));
  await a.prompt('one');
  expect((a.state.messages.at(-1) as any).errorMessage).toContain('custom context failure');
  fail = false;
  await a.prompt('two');
  expect((a.state.messages.at(-1) as any).stopReason).toBe('stop');
  await custom.close();
});

test('hook deadlines settle a stuck turn and prevent detached remote effects', async () => {
  const a = agent();
  let late: () => Promise<unknown> = async () => {};
  let executions = 0;
  const custom = await installCustomAgent(
    a,
    {
      cwd: '/workspace',
      exec: async () => {
        executions++;
        return { ok: true, value: {} };
      },
    } as any,
    identity,
    (ctx) => ({
      hookTimeoutMs: 20,
      transformContext: async () => {
        late = () => ctx.env.exec('detached');
        return new Promise(() => {});
      },
    }),
  );
  await a.prompt('one');
  expect((a.state.messages.at(-1) as any).errorMessage).toContain('transformContext');
  await expect(late()).rejects.toThrow();
  expect(executions).toBe(0);
  expect(a.state.isStreaming).toBe(false);
  await custom.close();
});

test('custom tools cannot replace platform tools and failed initialization blocks startup', async () => {
  const a = agent();
  const tool = {
    name: 'bash',
    label: 'Bash',
    description: 'Run',
    parameters: { type: 'object' },
    execute: async () => ({ content: [], details: {} }),
  } as any;
  a.state.tools = [tool];
  await expect(
    installCustomAgent(a, {} as any, identity, () => ({ tools: [tool] })),
  ).rejects.toThrow(/already registered/);
  await expect(
    installCustomAgent(agent(), {} as any, identity, () => ({
      initialize: () => {
        throw new Error('init failed');
      },
    })),
  ).rejects.toThrow('init failed');
});

test('Stop settles a stuck custom hook and emits cancellation once', async () => {
  const a = agent();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const seen: string[] = [];
  const custom = await installCustomAgent(a, {} as any, identity, () => ({
    transformContext: async () => {
      entered();
      return new Promise(() => {});
    },
    onEvent: (event, signal) => {
      if (event.type === 'agent_end') seen.push('agent_end:' + signal.aborted);
    },
    cancel: () => {
      seen.push('cancel');
    },
    shutdown: () => {
      seen.push('shutdown');
    },
  }));
  const turn = a.prompt('cancel this');
  await started;
  a.abort();
  await turn;
  expect(a.state.isStreaming).toBe(false);
  expect((a.state.messages.at(-1) as any).stopReason).toBe('aborted');
  await custom.close();
  expect(seen).toEqual(['cancel', 'agent_end:true', 'shutdown']);
});

test.each(['webfetch', 'StructuredOutput', 'connector_search', 'connector_describe', 'connector_call'])('custom tools cannot replace the platform %s tool', async (name) => {
  await expect(installCustomAgent(agent(), {} as any, identity, () => ({ tools: [{ name, label: 'fetch', description: 'custom', parameters: { type: 'object' }, execute: async () => ({ content: [], details: {} }) } as any] }))).rejects.toThrow('already registered');
});
