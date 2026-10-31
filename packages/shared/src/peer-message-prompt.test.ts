import { describe, expect, test } from 'bun:test';
import { parsePeerMessagePrompt, peerMessagePromptText } from './peer-message-prompt';

describe('peer message prompt', () => {
  test('round-trips sender, id, summary and text', () => {
    const text = peerMessagePromptText({
      kind: 'message',
      from: 'reviewer',
      fromShortId: '3f2a1b9c',
      messageId: 'm_7Kq2',
      summary: 'Schema [v2] changed',
      text: 'The users table has a new column.\n\n---\nnot a footer',
    });
    expect(parsePeerMessagePrompt(text)).toEqual({
      kind: 'message',
      from: 'reviewer',
      fromShortId: '3f2a1b9c',
      messageId: 'm_7Kq2',
      summary: 'Schema (v2) changed',
      text: 'The users table has a new column.\n\n---\nnot a footer',
    });
  });

  test('a shutdown request tells the receiver how to answer', () => {
    const text = peerMessagePromptText({ kind: 'shutdown_request', from: 'lead', fromShortId: 'aaaabbbb', messageId: 'm1', summary: null, text: 'Wrap up.' });
    expect(text).toContain('type: "shutdown_response"');
    expect(parsePeerMessagePrompt(text)).toMatchObject({ kind: 'shutdown_request', from: 'lead', summary: null, text: 'Wrap up.' });
  });

  test('any other text is not a peer message', () => {
    expect(parsePeerMessagePrompt('[room dev · #4 · from Ana]\n\nhi')).toBeUndefined();
    expect(parsePeerMessagePrompt('hello')).toBeUndefined();
    expect(parsePeerMessagePrompt(null)).toBeUndefined();
  });
});

describe('peerHandleLabel', () => {
  test("My Kortix's generated handle reads as My Kortix; a named agent as @name", async () => {
    const { peerHandleLabel } = await import('./my-kortix-agent');
    expect(peerHandleLabel('mykortix-d755ceea')).toBe('My Kortix');
    expect(peerHandleLabel('meta-0a1b2c3d')).toBe('My Kortix');
    expect(peerHandleLabel('reviewer')).toBe('@reviewer');
    expect(peerHandleLabel('worker-02ed0ab3')).toBe('@worker-02ed0ab3');
  });
});
