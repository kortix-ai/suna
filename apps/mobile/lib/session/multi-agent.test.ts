import { describe, expect, test } from 'bun:test';
import { peerHeadline, taskGlyph } from './multi-agent';

describe('team results', () => {
  test('a task status reads as a session glyph; a blocked open task is the stopped ring', () => {
    expect(taskGlyph({ status: 'completed', blocked: false })).toBe('done');
    expect(taskGlyph({ status: 'in_progress', blocked: false })).toBe('running');
    expect(taskGlyph({ status: 'pending', blocked: false })).toBe('starting');
    expect(taskGlyph({ status: 'pending', blocked: true })).toBe('stopped');
  });
});

describe('peer messages', () => {
  test('the headline names the sender and the kind', () => {
    expect(peerHeadline('message', '@scout')).toBe('Message from @scout');
    expect(peerHeadline('idle_notice', '@scout')).toBe('@scout finished');
  });
});
