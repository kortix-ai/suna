import { describe, expect, test } from 'bun:test';
import { normalizeOpenCodeMessageId, openCodePromptPayload } from './opencode-message-id';

describe('OpenCode 1.17.11 message ID compatibility', () => {
  test('new deterministic lifecycle IDs satisfy the runtime msg prefix schema', () => {
    for (const deterministicId of [
      'task-worker:task-1:worker-1',
      'task-no-progress:task-1:worker-1',
      'task-escalate:task-1:settlement-2',
      'task-bound-escalate:task-1',
    ]) {
      expect(normalizeOpenCodeMessageId(deterministicId)).toMatch(/^msg/);
    }
  });

  test('delivery repairs persisted pre-upgrade lifecycle IDs without changing valid IDs', () => {
    expect(openCodePromptPayload('continue', 'task-no-progress:task-1:worker-1')).toEqual({
      messageID: 'msg_task-no-progress:task-1:worker-1',
      parts: [{ type: 'text', text: 'continue' }],
    });
    expect(openCodePromptPayload('continue', 'msg_existing')).toEqual({
      messageID: 'msg_existing',
      parts: [{ type: 'text', text: 'continue' }],
    });
  });

  test('delivery omits an absent message ID so ordinary user prompts remain unchanged', () => {
    expect(openCodePromptPayload('hello', null)).toEqual({
      parts: [{ type: 'text', text: 'hello' }],
    });
  });
  test('worker, continuation, and escalation commands persist normalized IDs', async () => {
    const source = await Bun.file(new URL('../generated-state-store.ts', import.meta.url)).text();
    expect(source).toContain('const messageId = normalizeOpenCodeMessageId(`task-worker-');
    expect(source).toContain('messageId: normalizeOpenCodeMessageId(idempotencyKey)');
    expect(source).toContain('messageId: normalizeOpenCodeMessageId(`task-bound-escalate:');
  });

  test('worker registration accepts an equivalent persisted legacy ID on replay', async () => {
    const source = await Bun.file(new URL('../generated-state-store.ts', import.meta.url)).text();
    expect(source).toContain("typeof payload.messageId === 'string'");
    expect(source).toContain('normalizeOpenCodeMessageId(payload.messageId)');
  });

  test('deployment repair requeues persisted dead-lettered legacy prompts before claiming work', async () => {
    const store = await Bun.file(new URL('./store.ts', import.meta.url)).text();
    expect(store).toContain('export async function repairLegacyLifecycleMessageIds');
    expect(store).toContain("when ${sessionLifecycleCommands.status} = 'dead_lettered' then 'queued'");
    expect(store).toContain("to_jsonb('msg_' || (${sessionLifecycleCommands.payload}->>'messageId'))");
    expect(store).toContain('else ${sessionLifecycleCommands.availableAt}');

    const engine = await Bun.file(new URL('./engine.ts', import.meta.url)).text();
    expect(engine.indexOf('await repairLegacyLifecycleMessageIds()')).toBeLessThan(
      engine.indexOf('const rows = await claimDueLifecycleCommands'),
    );
  });

});
