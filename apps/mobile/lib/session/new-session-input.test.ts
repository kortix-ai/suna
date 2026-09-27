import { describe, expect, test } from 'bun:test';

import { newSessionCreateInput } from './new-session-input';
import { promptParts } from './prompt-parts';

const filePart = {
  type: 'file' as const,
  attachment_id: '11111111-1111-1111-1111-111111111111',
  mime: 'image/jpeg',
  filename: 'photo_1.jpg',
};

const picks = { model: { providerID: 'kortix', modelID: 'model-a' }, variant: 'high' };

const base = { text: 'hi', fileParts: [], fileNames: [], model: null, picks: null, agent: null };

describe('newSessionCreateInput', () => {
  test('sends the client session_id when given', () => {
    expect(newSessionCreateInput({ ...base, sessionId: 'ses_1' }).session_id).toBe('ses_1');
    expect('session_id' in newSessionCreateInput(base)).toBe(false);
  });

  test('files go in pending_prompt.parts with attachment_names', () => {
    const input = newSessionCreateInput({ ...base, fileParts: [filePart], fileNames: ['photo_1.jpg'] });
    expect(input.pending_prompt?.parts).toEqual(promptParts('hi', [filePart]));
    expect(input.pending_prompt?.attachment_names).toEqual(['photo_1.jpg']);
    expect(input.pending_prompt?.model).toBeNull();
    expect(input.pending_prompt?.variant).toBeNull();
    expect(input.initial_prompt).toBeUndefined();
  });

  test('files carry the picked model and level', () => {
    const input = newSessionCreateInput({
      ...base,
      fileParts: [filePart],
      fileNames: ['photo_1.jpg'],
      picks,
      agent: 'build',
    });
    expect(input.pending_prompt?.model).toEqual(picks.model);
    expect(input.pending_prompt?.variant).toBe('high');
    expect(input.pending_prompt?.agent).toBe('build');
  });

  test('image only builds parts without a text part', () => {
    const input = newSessionCreateInput({ ...base, text: '', fileParts: [filePart], fileNames: ['photo_1.jpg'] });
    expect(input.pending_prompt?.parts?.length).toBe(1);
    expect(input.pending_prompt?.text).toBe('');
  });

  test('text with picks keeps pending_prompt without parts', () => {
    const input = newSessionCreateInput({ ...base, picks });
    expect(input.pending_prompt).toEqual({ text: 'hi', agent: null, model: picks.model, variant: 'high' });
    expect(input.pending_prompt?.parts).toBeUndefined();
    expect(input.initial_prompt).toBeUndefined();
  });

  test('plain text keeps initial_prompt', () => {
    const input = newSessionCreateInput(base);
    expect(input.initial_prompt).toBe('hi');
    expect(input.pending_prompt).toBeUndefined();
  });

  test('model and agent map to opencode_model and agent_name', () => {
    const input = newSessionCreateInput({ ...base, model: 'kortix/model-a', agent: 'build' });
    expect(input.opencode_model).toBe('kortix/model-a');
    expect(input.agent_name).toBe('build');
    const bare = newSessionCreateInput(base);
    expect('opencode_model' in bare).toBe(false);
    expect('agent_name' in bare).toBe(false);
  });
});
