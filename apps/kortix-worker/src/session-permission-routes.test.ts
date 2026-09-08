import { expect, test } from 'bun:test';
import { fixture } from './interactive-recovery-fixture.ts';

const allow = [{ permission: '*', pattern: '*', action: 'allow' }];

test('session permission updates survive replacement and reset restores compiled policy', async () => {
  const f = await fixture({ permission: 'external', repeatPermissionPerPrompt: true });
  try {
    const first = await f.start();
    const path = `/session/${f.sessionID}`;
    const update = await first.call(path, { permission: allow }, 'PATCH');
    expect(update.status).toBe(200);
    expect(((await update.json()) as any).permission).toEqual(allow);
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    expect((await replacement.read(path)).permission).toEqual(allow);
    expect(
      (
        await replacement.call(path + '/message', {
          parts: [{ type: 'text', text: 'Run the external operation.' }],
        })
      ).status,
    ).toBe(200);
    expect(f.effects).toEqual(['BEFORE_PERMISSION', 'cat /etc/hostname', 'AFTER_PERMISSION']);
    expect(await replacement.read('/permission')).toEqual([]);
    expect((await replacement.call(path, { permission: [] }, 'PATCH')).status).toBe(200);
    expect((await replacement.read(path)).permission).toEqual([]);
    expect(
      (
        await replacement.call(path + '/prompt_async', {
          parts: [{ type: 'text', text: 'Run the external operation again.' }],
        })
      ).status,
    ).toBe(204);
    const [pending] = await f.until(
      () => replacement.read('/permission'),
      (value) => value.length === 1,
    );
    expect(pending.permission).toBe('bash');
    expect(f.effects).toEqual([
      'BEFORE_PERMISSION',
      'cat /etc/hostname',
      'AFTER_PERMISSION',
      'BEFORE_PERMISSION',
    ]);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('permission updates authenticate, validate, and leave the journal unchanged on invalid inputs', async () => {
  const f = await fixture();
  try {
    const worker = await f.start();
    const path = `/session/${f.sessionID}`;
    const before = structuredClone(f.items);
    expect(
      (
        await fetch(worker.origin + path, {
          method: 'PATCH',
          body: JSON.stringify({ permission: allow }),
        })
      ).status,
    ).toBe(401);
    expect((await worker.call('/session/foreign', { permission: allow }, 'PATCH')).status).toBe(
      404,
    );
    expect((await worker.call('/session/%GG', { permission: allow }, 'PATCH')).status).toBe(400);
    for (const body of [{}, { title: 'Unsupported' }, { permission: allow, title: 'Unsupported' }])
      expect((await worker.call(path, body, 'PATCH')).status).toBe(422);
    for (const permission of [
      null,
      {},
      ['allow'],
      [{ permission: '*', pattern: '*', action: 'yes' }],
      [{ permission: ' ', pattern: '*', action: 'allow' }],
      [{ permission: '*', pattern: '*', action: 'allow', extra: true }],
    ])
      expect((await worker.call(path, { permission }, 'PATCH')).status).toBe(400);
    expect(f.items).toEqual(before);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('a failed permission update keeps the current ask and can be retried without running its tool', async () => {
  const f = await fixture({ permission: 'external', rejectPermissionUpdates: true });
  try {
    const worker = await f.start();
    const path = `/session/${f.sessionID}`;
    await worker.call(path + '/prompt_async', {
      parts: [{ type: 'text', text: 'Read the external file.' }],
    });
    const pending = await f.until(
      () => worker.read('/permission'),
      (value) => value.length === 1,
    );
    expect((await worker.call(path, { permission: allow }, 'PATCH')).status).toBe(503);
    expect(await worker.read('/permission')).toEqual(pending);
    expect((await worker.read(path)).permission).toEqual([]);
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    f.allowPermissionUpdates();
    expect((await worker.call(path, { permission: allow }, 'PATCH')).status).toBe(200);
    expect(await worker.read('/permission')).toEqual(pending);
    expect(
      (await worker.call(`/permission/${pending[0].id}/reply`, { reply: 'once' })).status,
    ).toBe(200);
    await f.until(
      () => worker.read(path + '/message'),
      (value) =>
        value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')),
    );
    expect(f.effects).toEqual(['BEFORE_PERMISSION', 'cat /etc/hostname', 'AFTER_PERMISSION']);
    expect(await worker.read('/permission')).toEqual([]);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('a running owner observes a permission update made through another worker before the next approval stage', async () => {
  const f = await fixture({ permission: 'external' });
  try {
    const owner = await f.start();
    const other = await f.start();
    const path = `/session/${f.sessionID}`;
    await owner.call(path + '/prompt_async', {
      parts: [{ type: 'text', text: 'Read the external file.' }],
    });
    const pending = await f.until(
      () => owner.read('/permission'),
      (value) => value.length === 1,
    );
    expect((await other.call(path, { permission: allow }, 'PATCH')).status).toBe(200);
    expect((await owner.call(`/permission/${pending[0].id}/reply`, { reply: 'once' })).status).toBe(
      200,
    );
    await f.until(
      () => owner.read(path + '/message'),
      (value) =>
        value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')),
    );
    expect(f.effects).toEqual(['BEFORE_PERMISSION', 'cat /etc/hostname', 'AFTER_PERMISSION']);
    expect((await owner.read(path)).permission).toEqual(allow);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('an already running second worker learns an always grant before executing its queued prompt', async () => {
  const f = await fixture({ permission: 'primary', repeatPermissionPerPrompt: true });
  try {
    const owner = await f.start();
    const other = await f.start();
    const path = `/session/${f.sessionID}`;
    await owner.call(path + '/prompt_async', { parts: [{ type: 'text', text: 'Ask first.' }] });
    const [pending] = await f.until(
      () => owner.read('/permission'),
      (value) => value.length === 1,
    );
    expect(
      (await other.call(path + '/prompt_async', { parts: [{ type: 'text', text: 'Run next.' }] }))
        .status,
    ).toBe(204);
    expect((await owner.call(`/permission/${pending.id}/reply`, { reply: 'always' })).status).toBe(
      200,
    );
    await f.until(
      () => other.read(path + '/message'),
      (value) =>
        value.filter((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED'))
          .length === 2,
    );
    expect(f.effects).toEqual(
      Array(2).fill(['BEFORE_PERMISSION', 'APPROVE_PERMISSION', 'AFTER_PERMISSION']).flat(),
    );
    expect(await other.read('/permission')).toEqual([]);
    expect(f.providerRequests).toHaveLength(4);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('prompt tool controls and explicit session rules apply in started order and reset restores the registry', async () => {
  const f = await fixture({ permission: 'primary' });
  try {
    const worker = await f.start();
    const path = `/session/${f.sessionID}`;
    const denied = [{ permission: '*', pattern: '*', action: 'deny' }];
    const context = (tools?: Record<string, boolean>) => ({
      noReply: true,
      ...(tools ? { tools } : {}),
      parts: [{ type: 'text', text: 'Save controls.' }],
    });
    expect((await worker.call(path + '/message', context({ '*': false }))).status).toBe(200);
    expect((await worker.read(path)).permission).toEqual(denied);
    expect((await worker.call(path, { permission: allow }, 'PATCH')).status).toBe(200);
    expect((await worker.call(path + '/message', context({}))).status).toBe(200);
    expect((await worker.read(path)).permission).toEqual(allow);
    expect((await worker.call(path + '/message', context({ '*': false }))).status).toBe(200);
    expect((await worker.read(path)).permission).toEqual(denied);
    expect((await worker.call(path, { permission: [] }, 'PATCH')).status).toBe(200);
    expect((await worker.call(path + '/message', context())).status).toBe(200);
    expect((await worker.read(path)).permission).toEqual([]);
    await worker.call(path + '/prompt_async', {
      parts: [{ type: 'text', text: 'Run a command.' }],
    });
    await f.until(
      () => worker.read('/permission'),
      (value) => value.length === 1,
    );
    expect(f.providerRequests[0].tools.some((t: any) => t.function.name === 'bash')).toBe(true);
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('completed permission tool timestamps survive worker replacement exactly', async () => {
  const f = await fixture({ permission: 'primary' });
  try {
    const worker = await f.start();
    const path = `/session/${f.sessionID}`;
    await worker.call(path + '/prompt_async', { parts: [{ type: 'text', text: 'Run the operation.' }] });
    const [pending] = await f.until(() => worker.read('/permission'), value => value.length === 1);
    await Bun.sleep(30);
    expect((await worker.call(`/permission/${pending.id}/reply`, { reply: 'once' })).status).toBe(200);
    await f.until(() => worker.read('/session/status'), value => Object.keys(value).length === 0);
    const before = await worker.read(path + '/message');
    worker.child.kill('SIGKILL');
    await worker.child.exited;
    const replacement = await f.start();
    expect(await replacement.read(path + '/message')).toEqual(before);
  } finally { await f.cleanup(); }
}, 15000);
