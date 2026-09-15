import { expect, test } from 'bun:test';
import { fixture } from './interactive-recovery-fixture.ts';

test('a recovered permission cannot execute until the control plane acknowledges its new owner', async () => {
  const f = await fixture({ permission: 'primary', turnRecovery: 'pause', pause: 'resolved' });
  try {
    const first = await f.start();
    expect((await first.call(`/session/${f.sessionID}/prompt_async`, { parts: [{ type: 'text', text: 'Run the operation.' }] })).status).toBe(204);
    const [permission] = await f.until(() => first.read('/permission'), (value) => value.length === 1);
    void first.call(`/permission/${permission.id}/reply`, { reply: 'once' }).catch(() => {});
    await f.until(async () => f.items, (value) => value.some((item) => item.kind === 'journal'
      && item.stream === 'kortix.pi.permission-checkpoints.v1' && item.record.type === 'resolved'));
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    await f.until(async () => f.controlRequests, (value) => value.some((r) => r.kind === 'turn_resume'));
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    expect(f.providerRequests).toHaveLength(1);
    const resume = f.controlRequests.find((r) => r.kind === 'turn_resume');
    const claim = f.items.findLast((item) => item.kind === 'journal' && item.record.type === 'reclaimed');
    expect(resume.turn_owner_id).toBe((claim as any).record.ownerId);
    f.releaseTurnResume();
    await f.until(() => replacement.read(`/session/${f.sessionID}/message`), (value) => value.some((m: any) => m.parts.some((p: any) => p.text === 'PERMISSION_RECOVERED')));
    await f.until(async () => f.controlRequests, (value) => value.some((r) => r.kind === 'turn_end' && r.turn_message_id === resume.turn_message_id));
    expect(f.effects).toEqual(['BEFORE_PERMISSION', 'APPROVE_PERMISSION', 'AFTER_PERMISSION']);
    expect(f.controlRequests.find((r) => r.kind === 'turn_end' && r.turn_message_id === resume.turn_message_id).turn_owner_id).toBe(resume.turn_owner_id);
  } finally {
    await f.cleanup();
  }
}, 20000);

test('a control-plane recovery rejection interrupts the restored turn before a tool executes', async () => {
  const f = await fixture({ permission: 'primary', turnRecovery: 'reject' });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, { parts: [{ type: 'text', text: 'Run the operation.' }] });
    await f.until(() => first.read('/permission'), (value) => value.length === 1);
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    await f.until(async () => f.items, (value) => value.some((item) => item.kind === 'journal' && item.record.type === 'completed'));
    expect(f.effects).toEqual(['BEFORE_PERMISSION']);
    expect(f.providerRequests).toHaveLength(1);
    expect(await replacement.read('/permission')).toEqual([]);
    expect(f.controlRequests.filter((r) => r.kind === 'turn_resume')).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
}, 20000);
