import { describe, expect, test } from 'bun:test';
import { botId, readRecordingConfig } from './meet';

describe('botId', () => {
  test('extracts the Recall bot id from the create response', () => {
    expect(botId({ id: 'bot_abc123', status: 'joining' })).toBe('bot_abc123');
  });

  test('returns undefined when absent or malformed', () => {
    expect(botId({ status: 'joining' })).toBeUndefined();
    expect(botId(null)).toBeUndefined();
    expect(botId('nope')).toBeUndefined();
  });
});

describe('readRecordingConfig', () => {
  test('undefined when no flag passed (CLI falls back to the default)', () => {
    expect(readRecordingConfig(undefined)).toBeUndefined();
  });

  test('parses a JSON override', () => {
    expect(readRecordingConfig('{"transcript":{"provider":{"assembly_ai_streaming":{}}}}')).toEqual({
      transcript: { provider: { assembly_ai_streaming: {} } },
    });
  });

  test('throws a clear error on invalid JSON', () => {
    expect(() => readRecordingConfig('{not json')).toThrow(/recording-config/);
  });
});
