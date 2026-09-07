import { describe, expect, test } from 'bun:test';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

import {
  PermissionBroker,
  PermissionDeniedError,
  type PermissionEvent,
} from './permission-broker.ts';
import {
  compilePermissionRules,
  evaluatePermission,
  permissionNameForTool,
} from './permission-policy.ts';
import { protectToolsWithPermissions } from './permission-tools.ts';

function broker(
  permission: ConstructorParameters<typeof PermissionBroker>[0]['permission'] = undefined,
) {
  const events: PermissionEvent[] = [];
  const instance = new PermissionBroker({
    sessionId: 'ses_pi_1',
    permission,
    publish: (event) => events.push(event),
    createId: () => `per_${events.length + 1}`,
  });
  return { broker: instance, events };
}

function first<T>(items: T[]): T {
  const item = items[0];
  if (!item) throw new Error('expected one item');
  return item;
}

describe('permission policy', () => {
  test('preserves permissive defaults with protected environment reads', () => {
    const rules = compilePermissionRules();

    expect(evaluatePermission('bash', 'git status', rules).action).toBe('allow');
    expect(evaluatePermission('question', '*', rules).action).toBe('allow');
    expect(evaluatePermission('external_directory', '/tmp/file', rules).action).toBe('ask');
    expect(evaluatePermission('doom_loop', 'bash', rules).action).toBe('ask');
    expect(evaluatePermission('read', 'src/config.ts', rules).action).toBe('allow');
    expect(evaluatePermission('read', '.env', rules).action).toBe('deny');
    expect(evaluatePermission('read', 'services/api.env', rules).action).toBe('deny');
    expect(evaluatePermission('read', 'services/.env.prod', rules).action).toBe('deny');
    expect(evaluatePermission('read', 'services/.env.example', rules).action).toBe('allow');
  });

  test('uses simple wildcards and lets the last matching compiled rule win', () => {
    const rules = compilePermissionRules({
      '*': 'ask',
      bash: {
        '*': 'deny',
        'git ?tatus*': 'allow',
        'git status --ignored': 'ask',
      },
    });

    expect(evaluatePermission('read', 'README.md', rules).action).toBe('ask');
    expect(evaluatePermission('bash', 'git status --short', rules).action).toBe('allow');
    expect(evaluatePermission('bash', 'git status --ignored', rules).action).toBe('ask');
    expect(evaluatePermission('bash', 'rm file', rules).action).toBe('deny');
  });

  test('maps both write tools onto the edit permission', () => {
    expect(permissionNameForTool('write')).toBe('edit');
    expect(permissionNameForTool('edit')).toBe('edit');
    expect(permissionNameForTool('bash')).toBe('bash');
  });
});

describe('PermissionBroker', () => {
  test('publishes one OpenCode request and resolves a once reply', async () => {
    const { broker: instance, events } = broker({ bash: 'ask' });
    const authorization = instance.authorize({
      permission: 'bash',
      patterns: ['git status'],
      always: ['git status'],
      metadata: { command: 'git status' },
    });

    expect(instance.list()).toEqual([
      {
        id: 'per_1',
        sessionID: 'ses_pi_1',
        permission: 'bash',
        patterns: ['git status'],
        always: ['git status'],
        metadata: { command: 'git status' },
      },
    ]);
    expect(events[0]).toEqual({
      type: 'permission.asked',
      properties: instance.list()[0],
    });

    expect(await instance.reply('per_1', 'once')).toBe(true);
    await expect(authorization).resolves.toBeUndefined();
    expect(instance.list()).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: 'permission.replied',
      properties: { sessionID: 'ses_pi_1', requestID: 'per_1', reply: 'once' },
    });
  });

  test('denies before creating a pending request', async () => {
    const { broker: instance, events } = broker({ bash: 'deny' });

    await expect(
      instance.authorize({
        permission: 'bash',
        patterns: ['rm -rf build'],
        always: ['rm -rf build'],
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(instance.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  test('keeps an always approval for matching calls in this broker session', async () => {
    const { broker: instance, events } = broker({ bash: 'ask' });
    const first = instance.authorize({
      permission: 'bash',
      patterns: ['git status --short'],
      always: ['git status*'],
      metadata: {},
    });
    expect(await instance.reply('per_1', 'always')).toBe(true);
    await first;

    await expect(
      instance.authorize({
        permission: 'bash',
        patterns: ['git status --porcelain'],
        always: ['git status*'],
        metadata: {},
      }),
    ).resolves.toBeUndefined();
    expect(instance.list()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['permission.asked', 'permission.replied']);
  });

  test('removes an ask and rejects it with the caller abort reason', async () => {
    const { broker: instance, events } = broker({ edit: 'ask' });
    const controller = new AbortController();
    const authorization = instance.authorize({
      permission: 'edit',
      patterns: ['src/index.ts'],
      always: ['*'],
      metadata: {},
      signal: controller.signal,
    });

    controller.abort(new Error('turn stopped'));

    await expect(authorization).rejects.toThrow('turn stopped');
    expect(instance.list()).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: 'permission.replied',
      properties: { sessionID: 'ses_pi_1', requestID: 'per_1', reply: 'reject' },
    });
  });
});

describe('permission-protected tools', () => {
  test('evaluates every Pi tool against its OpenCode permission name', async () => {
    const cases = [
      { tool: 'bash', permission: 'bash', params: { command: 'pwd' } },
      { tool: 'read', permission: 'read', params: { path: 'README.md' } },
      { tool: 'write', permission: 'edit', params: { path: 'a.ts', content: '' } },
      { tool: 'edit', permission: 'edit', params: { path: 'a.ts', edits: [] } },
      { tool: 'glob', permission: 'glob', params: { pattern: '*.ts' } },
      { tool: 'grep', permission: 'grep', params: { pattern: 'token' } },
      { tool: 'skill', permission: 'skill', params: { name: 'release' } },
      { tool: 'question', permission: 'question', params: { questions: [] } },
    ];

    for (const item of cases) {
      let executions = 0;
      const tool: AgentTool = {
        name: item.tool,
        label: item.tool,
        description: 'test',
        parameters: Type.Object({}),
        async execute() {
          executions += 1;
          return { content: [{ type: 'text', text: 'ran' }], details: undefined };
        },
      };
      const { broker: instance } = broker({ [item.permission]: 'deny' });
      const protectedTool = first(protectToolsWithPermissions([tool], instance, '/workspace'));

      await expect(protectedTool.execute('call_1', item.params)).rejects.toMatchObject({
        name: 'PermissionDeniedError',
        permission: item.permission,
      });
      expect(executions).toBe(0);
    }
  });

  test('blocks a denied tool before its execution boundary', async () => {
    let executions = 0;
    const tool: AgentTool = {
      name: 'bash',
      label: 'bash',
      description: 'test',
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        executions += 1;
        return { content: [{ type: 'text', text: 'ran' }], details: undefined };
      },
    };
    const { broker: instance } = broker({ bash: 'deny' });
    const protectedTool = first(protectToolsWithPermissions([tool], instance, '/workspace'));

    await expect(protectedTool.execute('call_1', { command: 'rm file' })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(executions).toBe(0);
  });

  test('asks for an external path before calling the tool', async () => {
    let executions = 0;
    const tool: AgentTool = {
      name: 'read',
      label: 'read',
      description: 'test',
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        executions += 1;
        return { content: [{ type: 'text', text: 'ran' }], details: undefined };
      },
    };
    const { broker: instance } = broker();
    const protectedTool = first(
      protectToolsWithPermissions([tool], instance, '/workspace', (callID) => ({
        messageID: 'msg_1',
        callID,
      })),
    );

    const execution = protectedTool.execute('call_1', { path: '/tmp/secret.txt' });
    await Promise.resolve();

    expect(executions).toBe(0);
    expect(instance.list()[0]).toMatchObject({
      permission: 'external_directory',
      tool: { messageID: 'msg_1', callID: 'call_1' },
      patterns: ['/tmp/secret.txt'],
    });
    await instance.reply(first(instance.list()).id, 'once');
    await execution;
    expect(executions).toBe(1);
  });

  test('detects an external path inside a quoted bash argument', async () => {
    let executions = 0;
    const tool: AgentTool = {
      name: 'bash',
      label: 'bash',
      description: 'test',
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        executions += 1;
        return { content: [{ type: 'text', text: 'ran' }], details: undefined };
      },
    };
    const { broker: instance } = broker();
    const protectedTool = first(protectToolsWithPermissions([tool], instance, '/workspace'));

    const execution = protectedTool.execute('call_1', { command: 'cat "/tmp/secret.txt"' });
    await Promise.resolve();

    expect(executions).toBe(0);
    expect(instance.list()[0]).toMatchObject({
      permission: 'external_directory',
      patterns: ['/tmp/secret.txt'],
    });
    await instance.reply(first(instance.list()).id, 'once');
    await execution;
    expect(executions).toBe(1);
  });

  test('denies an external path in every command of a compound bash call', async () => {
    let executions = 0;
    const tool: AgentTool = {
      name: 'bash',
      label: 'bash',
      description: 'test',
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        executions += 1;
        return { content: [{ type: 'text', text: 'ran' }], details: undefined };
      },
    };
    const { broker: instance } = broker({ external_directory: 'deny' });
    const protectedTool = first(protectToolsWithPermissions([tool], instance, '/workspace'));

    await expect(
      protectedTool.execute('call_1', { command: 'echo ok; cat /tmp/secret.txt' }),
    ).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      permission: 'external_directory',
    });
    expect(executions).toBe(0);
  });

  test('denies a matching command inside a compound bash call', async () => {
    let executions = 0;
    const tool: AgentTool = {
      name: 'bash',
      label: 'bash',
      description: 'test',
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        executions += 1;
        return { content: [{ type: 'text', text: 'ran' }], details: undefined };
      },
    };
    const { broker: instance } = broker({
      bash: { '*': 'allow', 'rm *': 'deny' },
    });
    const protectedTool = first(protectToolsWithPermissions([tool], instance, '/workspace'));

    await expect(
      protectedTool.execute('call_1', { command: 'printf ok; rm secret.txt' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(executions).toBe(0);
  });

  test('asks on the third identical tool call before executing it', async () => {
    let executions = 0;
    const tool: AgentTool = {
      name: 'bash',
      label: 'bash',
      description: 'test',
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        executions += 1;
        return { content: [{ type: 'text', text: 'ran' }], details: undefined };
      },
    };
    const { broker: instance } = broker();
    const protectedTool = first(protectToolsWithPermissions([tool], instance, '/workspace'));

    await protectedTool.execute('call_1', { command: 'git status' });
    await protectedTool.execute('call_2', { command: 'git status' });
    const third = protectedTool.execute('call_3', { command: 'git status' });
    await Promise.resolve();

    expect(executions).toBe(2);
    expect(instance.list()[0]).toMatchObject({
      permission: 'doom_loop',
      patterns: ['bash'],
      always: ['bash'],
    });
    await instance.reply(first(instance.list()).id, 'once');
    await third;
    expect(executions).toBe(3);
  });
});
