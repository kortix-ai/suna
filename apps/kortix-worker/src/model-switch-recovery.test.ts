import { expect, test } from 'bun:test';
import { fixture } from './interactive-recovery-fixture';

test.each(['question', 'permission'] as const)('a model change preserves a %s across worker replacement', async kind => {
  const f = await fixture({ selectableModel: true, ...(kind === 'permission' ? { permission: 'primary' as const } : {}) });
  try {
    const first = await f.start();
    expect((await first.call(`/session/${f.sessionID}/prompt_async`, { parts: [{ type: 'text', text: 'Ask and continue.' }] })).status).toBe(204);
    const [pending] = await f.until(() => first.read(`/${kind}`), value => value.length === 1);
    f.selectModel('openai/gpt-4.1-mini');
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    expect(await f.until(() => replacement.read(`/${kind}`), value => value.length === 1)).toEqual([pending]);
    expect((await replacement.call(`/${kind}/${pending.id}/reply`, kind === 'question'
      ? { answers: [['Blue']] } : { reply: 'once' })).status).toBe(200);
    await f.until(() => replacement.read('/session/status'), value => !value[f.sessionID]);
    expect(f.providerRequests.map(request => request.model)).toEqual(['openai/gpt-4.1', 'openai/gpt-4.1']);
    expect(new Set(f.effects).size).toBe(f.effects.length);
    expect((await replacement.call(`/session/${f.sessionID}/message`, { parts: [{ type: 'text', text: 'Continue.' }] })).status).toBe(200);
    expect(f.providerRequests.at(-1).model).toBe('openai/gpt-4.1-mini');
    const before = await replacement.read(`/session/${f.sessionID}/message`);
    replacement.child.kill('SIGKILL');
    await replacement.child.exited;
    const restored = await f.start();
    expect(await restored.read(`/session/${f.sessionID}/message`)).toEqual(before);
  } finally { await f.cleanup(); }
}, 15000);
