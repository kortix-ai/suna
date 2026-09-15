import { expect, test } from 'bun:test';
import { sessionImageAttachmentsEnabled } from './session-image-attachments';

test('Pi image input requires the bound model capability from this worker', () => {
  const config = {
    model: 'kortix/pinned',
    provider: { kortix: { models: { pinned: { attachment: true } } } },
  };
  expect(sessionImageAttachmentsEnabled('pi-worker', config)).toBe(true);
  for (const value of [
    undefined,
    {},
    { model: 'bad' },
    { ...config, model: 'kortix/missing' },
    { ...config, provider: { kortix: { models: { pinned: { attachment: false } } } } },
  ]) {
    expect(sessionImageAttachmentsEnabled('pi-worker', value)).toBe(false);
  }
  expect(sessionImageAttachmentsEnabled(undefined, config)).toBe(false);
  expect(sessionImageAttachmentsEnabled('opencode', config)).toBe(false);
});
