import { expect, test } from 'bun:test';
import { fixture } from './interactive-recovery-fixture.ts';

test('an uncertain permission release stops the tool batch until a fresh worker reconciles it', async () => {
  const f = await fixture({
    permission: 'primary',
    rejectPermissionRelease: true,
    ownerLeaseMs: 1000,
  });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Run the operation.' }],
    });
    const [permission] = await f.until(
      () => first.read('/permission'),
      (value) => value.length === 1,
    );
    expect((await first.call(`/permission/${permission.id}/reply`, { reply: 'once' })).status).toBe(
      200,
    );
    await f.until(
      () => first.read('/health'),
      (value) => Boolean(value.storeError),
    );
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    expect(f.providerRequests).toHaveLength(1);
    first.child.kill('SIGKILL');
    await first.child.exited;
    f.allowPermissionRelease();
    const replacement = await f.start();
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) =>
        value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')),
    );
    expect(f.effects).toEqual(['BEFORE_PERMISSION', 'APPROVE_PERMISSION', 'AFTER_PERMISSION']);
    expect(await replacement.read('/permission')).toEqual([]);
  } finally {
    await f.cleanup();
  }
}, 20000);

test('recovered repeated tools retain the doom-loop guard for the next call', async () => {
  const f = await fixture({ permission: 'doom', continuedDoom: true });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Repeat the operation.' }],
    });
    const [third] = await f.until(
      () => first.read('/permission'),
      (value) => value.length === 1,
    );
    expect(f.effects).toHaveLength(2);
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    await f.until(
      () => replacement.read('/permission'),
      (value) => value[0]?.id === third.id,
    );
    expect(
      (await replacement.call(`/permission/${third.id}/reply`, { reply: 'once' })).status,
    ).toBe(200);
    const [fourth] = await f.until(
      () => replacement.read('/permission'),
      (value) => value.length === 1 && value[0].id !== third.id,
    );
    expect(fourth.permission).toBe('doom_loop');
    expect(f.effects).toHaveLength(3);
    expect(
      (await replacement.call(`/permission/${fourth.id}/reply`, { reply: 'once' })).status,
    ).toBe(200);
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) =>
        value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')),
    );
    expect(f.effects).toHaveLength(4);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('a killed worker restores permission without repeating earlier tools or model requests', async () => {
  const f = await fixture({ permission: 'primary' });
  try {
    const first = await f.start();
    expect(
      (
        await first.call(`/session/${f.sessionID}/prompt_async`, {
          parts: [{ type: 'text', text: 'Run the approved operation.' }],
        })
      ).status,
    ).toBe(204);
    const pending = await f.until(
      () => first.read('/permission'),
      (value) => value.length === 1,
    );
    const before = await first.read(`/session/${f.sessionID}/message`);
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    expect(f.providerRequests).toHaveLength(1);
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    expect(
      await f.until(
        () => replacement.read('/permission'),
        (value) => value.length === 1,
      ),
    ).toEqual(pending);
    expect(
      (await replacement.read(`/session/${f.sessionID}/message`)).map((m: any) => m.info.id),
    ).toEqual(before.map((m: any) => m.info.id));
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    expect(f.providerRequests).toHaveLength(1);
    expect(
      (await replacement.call(`/permission/${pending[0].id}/reply`, { reply: 'once' })).status,
    ).toBe(200);
    const messages = await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) =>
        value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')),
    );
    expect(messages.filter((m: any) => m.info.error)).toEqual([]);
    expect(f.effects).toEqual(['BEFORE_PERMISSION', 'APPROVE_PERMISSION', 'AFTER_PERMISSION']);
    expect(f.providerRequests).toHaveLength(2);
    await f.until(
      () => replacement.read('/session/status'),
      (value) => Object.keys(value).length === 0,
    );
  } finally {
    await f.cleanup();
  }
}, 15000);

test('replacement preserves the earlier once approval while waiting for an external-directory approval', async () => {
  const f = await fixture({ permission: 'external' });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Read the external path.' }],
    });
    const [primary] = await f.until(
      () => first.read('/permission'),
      (value) => value.length === 1,
    );
    expect(primary.permission).toBe('bash');
    expect((await first.call(`/permission/${primary.id}/reply`, { reply: 'once' })).status).toBe(
      200,
    );
    const [external] = await f.until(
      () => first.read('/permission'),
      (value) => value[0]?.permission === 'external_directory',
    );
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    expect(
      await f.until(
        () => replacement.read('/permission'),
        (value) => value.length === 1,
      ),
    ).toEqual([external]);
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    expect(f.providerRequests).toHaveLength(1);
    expect(
      (await replacement.call(`/permission/${external.id}/reply`, { reply: 'once' })).status,
    ).toBe(200);
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) =>
        value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')),
    );
    expect(f.effects).toEqual(['BEFORE_PERMISSION', 'cat /etc/hostname', 'AFTER_PERMISSION']);
    expect(f.providerRequests).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('replacement restores a pending doom-loop approval after cached repeated tools', async () => {
  const f = await fixture({ permission: 'doom' });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Repeat the operation.' }],
    });
    const pending = await f.until(
      () => first.read('/permission'),
      (value) => value.length === 1,
    );
    expect(pending[0].permission).toBe('doom_loop');
    expect(f.effects).toEqual(['SAME_PERMISSION_ACTION', 'SAME_PERMISSION_ACTION']);
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    expect(
      await f.until(
        () => replacement.read('/permission'),
        (value) => value.length === 1,
      ),
    ).toEqual(pending);
    expect(f.effects).toHaveLength(2);
    expect(
      (await replacement.call(`/permission/${pending[0].id}/reply`, { reply: 'once' })).status,
    ).toBe(200);
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) =>
        value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')),
    );
    expect(f.effects).toEqual(Array(3).fill('SAME_PERMISSION_ACTION'));
    expect(f.providerRequests).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
}, 15000);

test.each(['once', 'always', 'reject'] as const)(
  'a committed %s response survives death before HTTP acknowledgment',
  async (reply) => {
    const f = await fixture({ permission: 'primary', pause: 'resolved' });
    try {
      const first = await f.start();
      await first.call(`/session/${f.sessionID}/prompt_async`, {
        parts: [{ type: 'text', text: 'Run the approved operation.' }],
      });
      const [permission] = await f.until(
        () => first.read('/permission'),
        (value) => value.length === 1,
      );
      const pendingReply = first
        .call(`/permission/${permission.id}/reply`, { reply })
        .catch(() => null);
      await f.until(
        async () => f.items,
        (items) =>
          items.some(
            (item) =>
              item.kind === 'journal' &&
              item.stream === 'kortix.pi.permission-checkpoints.v1' &&
              item.record.type === 'resolved',
          ),
      );
      expect(f.effects).toEqual(['BEFORE_PERMISSION']);
      first.child.kill('SIGKILL');
      await first.child.exited;
      await pendingReply;
      const replacement = await f.start();
      await f.until(
        () => replacement.read(`/session/${f.sessionID}/message`),
        (value) =>
          value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')),
      );
      expect(await replacement.read('/permission')).toEqual([]);
      expect(f.effects).toEqual(
        reply === 'reject'
          ? ['BEFORE_PERMISSION', 'AFTER_PERMISSION']
          : ['BEFORE_PERMISSION', 'APPROVE_PERMISSION', 'AFTER_PERMISSION'],
      );
      expect(f.providerRequests).toHaveLength(2);
      await f.until(
        () => replacement.read('/session/status'),
        (value) => Object.keys(value).length === 0,
      );
    } finally {
      await f.cleanup();
    }
  },
  15000,
);

test('death after permission release interrupts instead of repeating an uncertain tool execution', async () => {
  const f = await fixture({ permission: 'primary', pause: 'released' });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Run the operation.' }],
    });
    const [permission] = await f.until(
      () => first.read('/permission'),
      (value) => value.length === 1,
    );
    expect((await first.call(`/permission/${permission.id}/reply`, { reply: 'once' })).status).toBe(
      200,
    );
    await f.until(
      async () => f.items,
      (items) =>
        items.some(
          (item) =>
            item.kind === 'journal' &&
            item.stream === 'kortix.pi.permission-checkpoints.v1' &&
            item.record.type === 'released',
        ),
    );
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    await f.until(
      () => replacement.read('/session/status'),
      (value) => Object.keys(value).length === 0,
    );
    expect(await replacement.read('/permission')).toEqual([]);
    const messages = await replacement.read(`/session/${f.sessionID}/message`);
    expect(messages.filter((m: any) => m.info.error)).toHaveLength(1);
    expect(messages.at(-1).info.error.name).toBe('MessageAbortedError');
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    expect(f.providerRequests).toHaveLength(1);
    expect(
      (
        await replacement.call(`/session/${f.sessionID}/prompt_async`, {
          parts: [{ type: 'text', text: 'Continue with another prompt.' }],
        })
      ).status,
    ).toBe(204);
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) =>
        value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')),
    );
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('Stop cancels a restored permission without executing its tool and allows the next prompt', async () => {
  const f = await fixture({ permission: 'primary' });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Run the operation.' }],
    });
    await f.until(
      () => first.read('/permission'),
      (value) => value.length === 1,
    );
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    const [permission] = await f.until(
      () => replacement.read('/permission'),
      (value) => value.length === 1,
    );
    expect((await replacement.call(`/session/${f.sessionID}/abort`, {})).status).toBe(200);
    await f.until(
      () => replacement.read('/session/status'),
      (value) => Object.keys(value).length === 0,
    );
    expect(await replacement.read('/permission')).toEqual([]);
    expect(
      (await replacement.call(`/permission/${permission.id}/reply`, { reply: 'once' })).status,
    ).toBe(404);
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    expect(
      (
        await replacement.call(`/session/${f.sessionID}/prompt_async`, {
          parts: [{ type: 'text', text: 'Continue.' }],
        })
      ).status,
    ).toBe(204);
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) =>
        value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')),
    );
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
  } finally {
    await f.cleanup();
  }
}, 15000);

test('a queued prompt on another worker first recovers an abandoned blocking permission', async () => {
  const f = await fixture({ permission: 'primary' });
  try {
    const first = await f.start();
    const replacement = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask first.' }],
    });
    const pending = await f.until(
      () => first.read('/permission'),
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
        () => replacement.read('/permission'),
        (value) => value.length === 1,
      ),
    ).toEqual(pending);
    expect(
      (await replacement.call(`/permission/${pending[0].id}/reply`, { reply: 'once' })).status,
    ).toBe(200);
    await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) =>
        value.filter((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED'))
          .length === 2,
    );
    expect(f.effects).toEqual(['BEFORE_PERMISSION', 'APPROVE_PERMISSION', 'AFTER_PERMISSION']);
    expect(f.providerRequests).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
}, 30000);
