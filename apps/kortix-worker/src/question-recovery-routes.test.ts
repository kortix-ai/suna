import { expect, test } from 'bun:test';
import { fixture, questions } from './interactive-recovery-fixture.ts';

test('a later question with a reused native call ID receives a new answer and survives replacement', async () => {
  const f = await fixture({ repeatedQuestionCallId: true });
  try {
    const first = await f.start();
    await first.call(`/session/${f.sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask twice.' }],
    });
    const [earlier] = await f.until(
      () => first.read('/question'),
      (value) => value.length === 1,
    );
    expect(
      (await first.call(`/question/${earlier.id}/reply`, { answers: [['Blue']] })).status,
    ).toBe(200);
    const [later] = await f.until(
      () => first.read('/question'),
      (value) => value.length === 1 && value[0].id !== earlier.id,
    );
    expect(later.tool.messageID).not.toBe(earlier.tool.messageID);
    expect(f.providerRequests).toHaveLength(2);
    first.child.kill('SIGKILL');
    await first.child.exited;
    const replacement = await f.start();
    expect(
      await f.until(
        () => replacement.read('/question'),
        (value) => value.length === 1,
      ),
    ).toEqual([later]);
    expect(
      (await replacement.call(`/question/${later.id}/reply`, { answers: [['Green']] })).status,
    ).toBe(200);
    const messages = await f.until(
      () => replacement.read(`/session/${f.sessionID}/message`),
      (value) => value.some((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED')),
    );
    const tools = messages
      .flatMap((m: any) => m.parts)
      .filter((p: any) => p.type === 'tool' && p.tool === 'question');
    expect(tools.map((p: any) => p.state.metadata.answers)).toEqual([[['Blue']], [['Green']]]);
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
    expect(f.providerRequests).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
}, 15000);

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

test.each([false, true])('a temporary store outage within the owner lease keeps a pending question answerable, reads available=%s', async (outageReadsAvailable) => {
  const f = await fixture({ ownerLeaseMs: 10000, outageReadsAvailable });
  try {
    const worker = await f.start();
    expect(
      (
        await worker.call(`/session/${f.sessionID}/prompt_async`, {
          parts: [{ type: 'text', text: 'Ask and continue after storage recovers.' }],
        })
      ).status,
    ).toBe(204);
    const pending = await f.until(
      () => worker.read('/question'),
      (value) => value.length === 1,
    );
    f.outage(4200);
    await Bun.sleep(4400);
    expect(f.failedStoreRequests()).toBeGreaterThanOrEqual(6);
    expect(await worker.read('/question')).toEqual(pending);
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
    expect(f.providerRequests).toHaveLength(1);
    expect(
      (await worker.call(`/question/${pending[0].id}/reply`, { answers: [['Blue']] })).status,
    ).toBe(200);
    await f.until(
      () => worker.read(`/session/${f.sessionID}/message`),
      (value) => value.some((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED')),
    );
    await f.until(
      () => worker.read('/session/status'),
      (value) => !value[f.sessionID] || value[f.sessionID].type === 'idle',
    );
    expect(f.effects).toEqual(['BEFORE_QUESTION', 'AFTER_QUESTION']);
    expect(f.providerRequests).toHaveLength(2);
    expect(
      (await worker.read(`/session/${f.sessionID}/message`)).filter((m: any) => m.info.error),
    ).toEqual([]);
  } finally {
    await f.cleanup();
  }
}, 30000);

test.each([false, true])('an expired owner settles after storage returns, outage reads available=%s', async (outageReadsAvailable) => {
  const f = await fixture({ ownerLeaseMs: 200, outageReadsAvailable, pauseReadAfterCompletion: true });
  try {
    const worker = await f.start();
    expect(
      (
        await worker.call(`/session/${f.sessionID}/prompt_async`, {
          parts: [{ type: 'text', text: 'Ask before the long outage.' }],
        })
      ).status,
    ).toBe(204);
    await f.until(
      () => worker.read('/question'),
      (value) => value.length === 1,
    );
    f.outage(6500);
    await Bun.sleep(400);
    expect(await worker.read('/question')).toEqual([]);
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
    await Bun.sleep(6400);
    await f.readPaused;
    expect(await worker.read('/session/status')).toEqual({ [f.sessionID]: { type: 'busy' } });
    f.releaseRead();
    await f.until(
      () => worker.read('/session/status'),
      (value) => !value[f.sessionID] || value[f.sessionID].type === 'idle',
    );
    expect(f.effects).toEqual(['BEFORE_QUESTION']);
    expect(f.providerRequests).toHaveLength(1);
    expect(
      (await worker.read(`/session/${f.sessionID}/message`)).filter((m: any) => m.info.error),
    ).toHaveLength(1);
    expect(
      (
        await worker.call(`/session/${f.sessionID}/prompt_async`, {
          parts: [{ type: 'text', text: 'Continue with a new turn.' }],
        })
      ).status,
    ).toBe(204);
    await f.until(
      () => worker.read(`/session/${f.sessionID}/message`),
      (value) => value.some((m: any) => m.parts.some((p: any) => p.text === 'QUESTION_RECOVERED')),
    );
    expect(f.providerRequests).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
}, 30000);
