import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_TRANSCRIPT_OPTIONS,
  formatTranscript,
  getTranscriptFilename,
  type MessageWithParts,
  type SessionInfo,
} from './transcript';

const session: SessionInfo = {
  id: 'ses_abc123',
  title: 'Fix the flaky test',
  time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
};

function userMessage(text: string): MessageWithParts {
  return {
    info: { id: 'msg_1', role: 'user' } as unknown as MessageWithParts['info'],
    parts: [{ id: 'prt_1', type: 'text', text } as unknown as MessageWithParts['parts'][number]],
  };
}

function assistantMessage(): MessageWithParts {
  return {
    info: {
      id: 'msg_2',
      role: 'assistant',
      agent: 'build',
      modelID: 'glm-5.2',
      time: { created: 1_700_000_000_000, completed: 1_700_000_005_000 },
    } as unknown as MessageWithParts['info'],
    parts: [
      {
        id: 'prt_2',
        type: 'text',
        text: 'Sure, looking now.',
      } as unknown as MessageWithParts['parts'][number],
      {
        id: 'prt_3',
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: 'echo hi', output: 'hi' },
      } as unknown as MessageWithParts['parts'][number],
    ],
  };
}

describe('formatTranscript', () => {
  test('renders the session header', () => {
    const md = formatTranscript(session, [], DEFAULT_TRANSCRIPT_OPTIONS);
    expect(md).toContain('# Fix the flaky test');
    expect(md).toContain('**Session ID:** `ses_abc123`');
  });

  test('falls back to "Untitled Session" when title is empty', () => {
    const md = formatTranscript({ ...session, title: '' }, []);
    expect(md).toContain('# Untitled Session');
  });

  test('renders a user message section', () => {
    const md = formatTranscript(session, [userMessage('Can you fix this?')]);
    expect(md).toContain('## User');
    expect(md).toContain('Can you fix this?');
  });

  test('renders an assistant section with agent/model/duration metadata', () => {
    const md = formatTranscript(session, [assistantMessage()]);
    expect(md).toContain('## Build (glm-5.2 · 5.0s)');
    expect(md).toContain('Sure, looking now.');
  });

  test('omits assistant metadata when assistantMetadata is false', () => {
    const md = formatTranscript(session, [assistantMessage()], {
      ...DEFAULT_TRANSCRIPT_OPTIONS,
      assistantMetadata: false,
    });
    expect(md).toContain('## Assistant');
    expect(md).not.toContain('glm-5.2');
  });

  test('includes tool input/output details when toolDetails is true', () => {
    const md = formatTranscript(session, [assistantMessage()], {
      ...DEFAULT_TRANSCRIPT_OPTIONS,
      toolDetails: true,
    });
    expect(md).toContain('**Tool: bash**');
    expect(md).toContain('echo hi');
    expect(md).toContain('<summary>Output</summary>');
  });

  test('omits tool input/output details when toolDetails is false', () => {
    const md = formatTranscript(session, [assistantMessage()], {
      ...DEFAULT_TRANSCRIPT_OPTIONS,
      toolDetails: false,
    });
    expect(md).toContain('**Tool: bash**');
    expect(md).not.toContain('<summary>Output</summary>');
  });
});

describe('getTranscriptFilename', () => {
  test('is stable and keyed off the session id', () => {
    expect(getTranscriptFilename('ses_abc123')).toBe('session-ses_abc123.md');
  });
});
