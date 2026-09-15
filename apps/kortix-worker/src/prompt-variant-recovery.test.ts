import { expect, test } from 'bun:test';
import { fixture } from './interactive-recovery-fixture';

test('reasoning survives a question and worker replacement without changing the next turn', async () => {
  const f = await fixture({
    modelId: 'gpt-5.6-luna',
    modelLimits: {
      model: 'gpt-5.6-luna', context: 1050000, output: 128000,
      reasoning: true, reasoningEfforts: ['none', 'low', 'high', 'max'],
    },
  });
  try {
    const first = await f.start();
    const parts = [{ type: 'text', text: 'Ask and continue.' }];
    expect((await first.call(`/session/${f.sessionID}/prompt_async`, { variant: 'max', parts })).status).toBe(204);
    const [question] = await f.until(() => first.read('/question'), value => value.length === 1);
    const before = await first.read(`/session/${f.sessionID}/message`);
    const user = before.find((message: any) => message.info.role === 'user');
    expect(user.info.variant).toBe('max');
    expect((await first.call(`/session/${f.sessionID}/prompt_async`, {
      messageID: user.info.id, variant: 'low', parts,
    })).status).toBe(409);
    expect(f.providerRequests).toHaveLength(1);
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    expect(await f.until(() => replacement.read('/question'), value => value.length === 1)).toEqual([question]);
    expect((await replacement.call(`/question/${question.id}/reply`, { answers: [['Blue']] })).status).toBe(200);
    await f.until(() => replacement.read('/session/status'), value => !value[f.sessionID]);
    expect(f.providerRequests.map(request => request.reasoning_effort ?? request.reasoning?.effort)).toEqual(['max', 'max']);
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
    const followup = await replacement.call(`/session/${f.sessionID}/message`, {
      variant: 'none', parts: [{ type: 'text', text: 'Continue.' }],
    });
    expect(followup.status).toBe(200);
    await followup.json();
    expect(f.providerRequests.at(-1).reasoning_effort ?? f.providerRequests.at(-1).reasoning?.effort).toBe('none');
    const final = await replacement.read(`/session/${f.sessionID}/message`);
    expect(final.filter((message: any) => message.info.role === 'user').map((message: any) => message.info.variant)).toEqual(['max', 'none']);
    replacement.child.kill('SIGKILL');
    await replacement.child.exited;
    const again = await f.start();
    expect(await again.read(`/session/${f.sessionID}/message`)).toEqual(final);
    expect(f.providerRequests).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
}, 15000);
