import { describe, expect, test } from 'bun:test';

import { convertPendingPromptToInboxRow } from './pending-prompt';

const BASE = {
  projectId: 'proj-1',
  accountId: 'acct-1',
  sessionId: 'sess-1',
  actorUserId: 'user-1',
  nowMs: 1_770_000_000_000,
};

describe('convertPendingPromptToInboxRow', () => {
  test('a text prompt becomes one durable row plus metadata picks without the text', () => {
    const result = convertPendingPromptToInboxRow({
      ...BASE,
      pendingPrompt: {
        text: 'Map this parcel.',
        agent: 'default',
        model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
        variant: 'high',
        attachment_names: ['parcel.geojson'],
      },
    });

    expect(result.error).toBeNull();
    expect(result.metadataPicks).toEqual({
      agent: 'default',
      model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
      variant: 'high',
      attachment_names: ['parcel.geojson'],
    });
    const values = result.rowValues as any;
    expect(values.commandType).toBe('continue_session');
    expect(values.idempotencyKey).toBe('prompt:sess-1:pending-first');
    expect(values.payload.clientMessageId).toBe('pending:sess-1');
    expect(values.payload.wireMessageId).toMatch(/^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/);
    expect(values.payload.remintOnDelivery).toBe(true);
    expect(values.payload.parts).toEqual([{ type: 'text', text: 'Map this parcel.' }]);
    expect(values.payload.overrides).toEqual({
      agent: 'default',
      model: { providerID: 'kortix', modelID: 'claude-sonnet-4-5' },
      variant: 'high',
      directory: null,
    });
  });

  test('explicit parts (data-URL attachments) win over the flat text', () => {
    const result = convertPendingPromptToInboxRow({
      ...BASE,
      pendingPrompt: {
        text: 'Look at this screenshot.',
        parts: [
          { type: 'text', text: 'Look at this screenshot.' },
          { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA', filename: 's.png' },
        ],
      },
    });
    expect(result.error).toBeNull();
    expect((result.rowValues as any).payload.parts).toHaveLength(2);
  });

  test('an empty prompt makes no row and no error — picks still stored', () => {
    const result = convertPendingPromptToInboxRow({
      ...BASE,
      pendingPrompt: { text: '   ', agent: 'default' },
    });
    expect(result.rowValues).toBeNull();
    expect(result.error).toBeNull();
    expect(result.metadataPicks).toEqual({ agent: 'default' });
  });

  test('a part-level refusal surfaces as an error, never a silent drop', () => {
    const result = convertPendingPromptToInboxRow({
      ...BASE,
      pendingPrompt: {
        text: 'x',
        parts: Array.from({ length: 65 }, () => ({ type: 'text', text: 'x' })),
      },
    });
    expect(result.rowValues).toBeNull();
    expect(result.error).toContain('1..');
  });
});
