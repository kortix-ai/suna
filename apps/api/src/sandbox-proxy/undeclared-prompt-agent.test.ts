import { describe, expect, test } from 'bun:test';
import { dropUndeclaredPromptAgent } from './undeclared-prompt-agent';

const json = new Headers({ 'content-type': 'application/json' });
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
const decode = (body: ArrayBuffer | undefined) =>
  body ? JSON.parse(new TextDecoder().decode(body)) : undefined;

const context = {
  projectId: 'project-1',
  sessionId: 'session-1',
  sandboxId: 'sbx_1',
  path: '/session/ses_1/prompt_async',
  sandboxAuthored: false,
  userId: 'user-1',
  userAgent: 'Mozilla/5.0',
};

describe('dropUndeclaredPromptAgent', () => {
  test('an agent the project does not declare is removed from the body and reported', async () => {
    const logged: unknown[] = [];
    const result = await dropUndeclaredPromptAgent({
      ...context,
      body: encode({ parts: [{ type: 'text', text: 'hi' }], agent: 'foreign-agent', model: 'm' }),
      headers: json,
      sessionAgent: 'project-agent',
      isLaunchable: async (name) => name === 'project-agent',
      log: (entry) => logged.push(entry),
    });

    expect(result.droppedAgent).toBe('foreign-agent');
    expect(result.requestedAgent).toBeNull();
    expect(decode(result.body)).toEqual({ parts: [{ type: 'text', text: 'hi' }], model: 'm' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      requestedAgent: 'foreign-agent',
      sessionAgent: 'project-agent',
      sandboxAuthored: false,
      userAgent: 'Mozilla/5.0',
    });
  });

  test('a declared agent passes through untouched', async () => {
    const body = encode({ parts: [], agent: 'project-admin' });
    const result = await dropUndeclaredPromptAgent({
      ...context,
      body,
      headers: json,
      sessionAgent: 'project-agent',
      isLaunchable: async () => true,
      log: () => {
        throw new Error('must not log');
      },
    });

    expect(result.droppedAgent).toBeNull();
    expect(result.requestedAgent).toBe('project-admin');
    expect(result.body).toBe(body);
  });

  test('the session agent and a body without an agent never pay the manifest read', async () => {
    let reads = 0;
    const isLaunchable = async () => {
      reads += 1;
      return false;
    };
    const same = await dropUndeclaredPromptAgent({
      ...context,
      body: encode({ agent: 'project-agent' }),
      headers: json,
      sessionAgent: 'project-agent',
      isLaunchable,
      log: () => {},
    });
    const none = await dropUndeclaredPromptAgent({
      ...context,
      body: encode({ parts: [] }),
      headers: json,
      sessionAgent: 'project-agent',
      isLaunchable,
      log: () => {},
    });

    expect(reads).toBe(0);
    expect(same.requestedAgent).toBe('project-agent');
    expect(none.requestedAgent).toBeNull();
  });

  test('a launchability read that throws drops the agent: fail closed', async () => {
    const result = await dropUndeclaredPromptAgent({
      ...context,
      body: encode({ agent: 'foreign-agent' }),
      headers: json,
      sessionAgent: 'project-agent',
      isLaunchable: async () => {
        throw new Error('git mirror unavailable');
      },
      log: () => {},
    });

    expect(result.droppedAgent).toBe('foreign-agent');
    expect(decode(result.body)).toEqual({});
  });
});
