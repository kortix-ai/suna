import { describe, expect, test } from 'bun:test';
import { buildAgentRefsBlock } from '@/lib/project-preamble';
import type { QueueRow } from '../queue-projection';
import {
  planQueueEditExit,
  queueRowEditable,
  rebuildEditedPromptText,
  withEditedText,
  rowForArrowEdit,
} from './queue-edit';

const row = (over: Partial<QueueRow> & { id: string }): QueueRow => ({
  clientMessageId: `c-${over.id}`,
  text: `text ${over.id}`,
  attachmentCount: 0,
  state: 'queued',
  removable: true,
  retryable: false,
  takeBackEligible: true,
  canSendNow: true,
  ...over,
});

describe('queueRowEditable', () => {
  test('a queued, take-back-eligible row with nothing in flight', () => {
    expect(queueRowEditable(row({ id: 'a' }))).toBe(true);
    expect(queueRowEditable(row({ id: 'a', takeBackEligible: false }))).toBe(false);
    expect(queueRowEditable(row({ id: 'a', state: 'delivering' }))).toBe(false);
    expect(queueRowEditable(row({ id: 'a', pendingAction: 'remove' }))).toBe(false);
  });
});

describe('rowForArrowEdit — the ↑ key in an empty composer', () => {
  test('picks the LAST editable row', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', takeBackEligible: false })];
    expect(rowForArrowEdit(rows, true)).toBe('b');
  });

  test('does nothing when the composer has text, or nothing is editable', () => {
    expect(rowForArrowEdit([row({ id: 'a' })], false)).toBeNull();
    expect(rowForArrowEdit([row({ id: 'a', state: 'failed' })], true)).toBeNull();
    expect(rowForArrowEdit([], true)).toBeNull();
  });
});

describe('planQueueEditExit — what the composer holds after the edit', () => {
  const stash = { text: 'also check the lint', files: [] };

  test('saved or cancelled: the stashed draft comes back exactly, and nothing above it', () => {
    expect(planQueueEditExit({ outcome: 'saved', stash, editedText: 'x' })).toEqual({ stash, above: null });
    expect(planQueueEditExit({ outcome: 'cancelled', stash, editedText: 'x' })).toEqual({
      stash,
      above: null,
    });
  });

  test('refused (already sent): the edited words stay, above the stashed draft', () => {
    expect(planQueueEditExit({ outcome: 'refused', stash, editedText: 'fix the tests' })).toEqual({
      stash,
      above: 'fix the tests',
    });
    expect(planQueueEditExit({ outcome: 'refused', stash, editedText: '   ' })).toEqual({
      stash,
      above: null,
    });
  });
});

describe('rebuildEditedPromptText — the wire text an in-place save sends', () => {
  test('plain text is replaced whole', () => {
    expect(rebuildEditedPromptText('fix the tests', 'fix the unit tests')).toBe('fix the unit tests');
  });

  test('a reply context and trailing reference blocks survive the edit', () => {
    // Built the way `handleSend` builds them, so the parser that hides them from
    // the composer is the one that finds them here.
    const refs = buildAgentRefsBlock([{ name: 'build' }]);
    const original = `<reply_context>earlier answer</reply_context>\n\nfix the tests\n\n${refs}`;
    expect(rebuildEditedPromptText(original, 'fix the unit tests')).toBe(
      `<reply_context>earlier answer</reply_context>\n\nfix the unit tests\n\n${refs}`,
    );
  });

  test('every reply quote survives the edit, not only the first', () => {
    // The composer sends one `<reply_context>` line per quote (`withReplyQuotes`).
    const original =
      '<reply_context>first quote</reply_context>\n<reply_context>second aa quote</reply_context>\naa';
    expect(rebuildEditedPromptText(original, 'bb')).toBe(
      '<reply_context>first quote</reply_context>\n<reply_context>second aa quote</reply_context>\nbb',
    );
  });

  test('words that also appear inside the reply context are replaced where the user wrote them', () => {
    const original = '<reply_context>yes</reply_context>\n\nyes';
    expect(rebuildEditedPromptText(original, 'no')).toBe('<reply_context>yes</reply_context>\n\nno');
  });
});

describe('withEditedText — the parts an edited message is re-queued with', () => {
  test('the first text part takes the new words, other text parts go, files stay in place', () => {
    const file = { type: 'file' as const, mime: 'image/png', url: 'kortix-attachment://x' };
    expect(
      withEditedText(
        [{ type: 'text', text: 'old' }, file, { type: 'text', text: 'more' }],
        'new words',
      ),
    ).toEqual([{ type: 'text', text: 'new words' }, file]);
  });

  test('a message with only files gets a text part first', () => {
    const file = { type: 'file' as const, mime: 'image/png', url: 'kortix-attachment://x' };
    expect(withEditedText([file], 'caption')).toEqual([{ type: 'text', text: 'caption' }, file]);
  });
});
