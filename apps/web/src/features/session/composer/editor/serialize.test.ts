import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Node as PMNode } from '@tiptap/pm/model';
import { describe, expect, test } from 'bun:test';

import { MentionNode } from './mention-node';
import { collectMentions, serializeDocument, type SerializableNode } from './serialize';

const mention = (kind: string, label: string, value = ''): SerializableNode => ({
  type: 'mention',
  attrs: { kind, label, value },
});
const text = (t: string): SerializableNode => ({ type: 'text', text: t });

describe('collectMentions', () => {
  test('every occurrence is tracked, not just the first', () => {
    // The bug this whole node model exists to kill: the old string version
    // used text.indexOf(needle) and found ONE match per label.
    const nodes = [mention('file', 'README.md'), text(' and '), mention('file', 'README.md')];
    expect(collectMentions(nodes)).toEqual([
      { kind: 'file', label: 'README.md' },
      { kind: 'file', label: 'README.md' },
    ]);
  });

  test('a session mention carries its id, other kinds do not', () => {
    const nodes = [mention('session', 'Fix the parser', 'ses_abc'), mention('agent', 'build')];
    expect(collectMentions(nodes)).toEqual([
      { kind: 'session', label: 'Fix the parser', value: 'ses_abc' },
      { kind: 'agent', label: 'build' },
    ]);
  });

  test('plain text contributes no mentions', () => {
    expect(collectMentions([text('just an @email@example.com here')])).toEqual([]);
  });

  test('an empty document yields an empty list', () => {
    expect(collectMentions([])).toEqual([]);
  });
});

// ── serializeDocument — built on a real ProseMirror doc, same house pattern
// as mention-node.test.ts (getSchema + PMNode.fromJSON, no jsdom). ──────────

const schema = getSchema([Document, Paragraph, Text, HardBreak, MentionNode]);

function docWith(...paragraphContent: unknown[]) {
  return PMNode.fromJSON(schema, {
    type: 'doc',
    content: [{ type: 'paragraph', content: paragraphContent }],
  });
}

function mentionJSON(kind: string, label: string, value = label) {
  return { type: 'mention', attrs: { kind, label, value } };
}

function textJSON(t: string) {
  return { type: 'text', text: t };
}

describe('serializeDocument', () => {
  test('renders plain text unchanged and reports no mentions', () => {
    const doc = docWith(textJSON('hello world'));
    expect(serializeDocument(doc)).toEqual({ text: 'hello world', mentions: [] });
  });

  test('renders every mention occurrence as @label inline, in document order', () => {
    const doc = docWith(
      textJSON('see '),
      mentionJSON('file', 'README.md'),
      textJSON(' and '),
      mentionJSON('file', 'README.md'),
    );
    const result = serializeDocument(doc);
    expect(result.text).toBe('see @README.md and @README.md');
    expect(result.mentions).toEqual([
      { kind: 'file', label: 'README.md' },
      { kind: 'file', label: 'README.md' },
    ]);
  });

  test('a session mention renders @label in text but keeps its id only in mentions', () => {
    const doc = docWith(textJSON('check '), mentionJSON('session', 'Fix the parser', 'ses_abc'));
    const result = serializeDocument(doc);
    expect(result.text).toBe('check @Fix the parser');
    expect(result.mentions).toEqual([{ kind: 'session', label: 'Fix the parser', value: 'ses_abc' }]);
  });

  test('a mention with an empty label still renders the @ sigil, not undefined/null', () => {
    const doc = docWith(textJSON('see '), mentionJSON('file', ''));
    const result = serializeDocument(doc);
    expect(result.text).toBe('see @');
    expect(result.mentions).toEqual([{ kind: 'file', label: '' }]);
  });

  test('a document containing only a mention and no other text', () => {
    const doc = docWith(mentionJSON('agent', 'build', ''));
    const result = serializeDocument(doc);
    expect(result.text).toBe('@build');
    expect(result.mentions).toEqual([{ kind: 'agent', label: 'build' }]);
  });

  test('leading/trailing whitespace around the doc is trimmed', () => {
    const doc = docWith(textJSON('  hello  '));
    expect(serializeDocument(doc).text).toBe('hello');
  });

  test('multiple paragraphs join with a newline separator', () => {
    const doc = PMNode.fromJSON(schema, {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [textJSON('line one')] },
        { type: 'paragraph', content: [textJSON('line two')] },
      ],
    });
    expect(serializeDocument(doc).text).toBe('line one\nline two');
  });
});

/**
 * The `/` command chip. Everything here defends one invariant that the submit
 * path relies on without re-checking it: when `commandName` is set, `text` IS
 * the command's arguments — nothing to strip, nothing to re-parse.
 */
describe('serializeDocument — command chips', () => {
  test('a command chip is reported as commandName and contributes no text', () => {
    const doc = docWith(mentionJSON('command', 'deep-research'), textJSON(' the tiptap docs'));
    const result = serializeDocument(doc);

    expect(result.commandName).toBe('deep-research');
    // Not "/deep-research the tiptap docs". `onCommand(command, args)` already
    // carries the command; leaving it in the text too would send the agent the
    // command name prepended to its own arguments.
    expect(result.text).toBe('the tiptap docs');
  });

  test('a command chip is NOT a tracked mention', () => {
    // If it leaked into `mentions` it would reach `buildFileRefsBlock` and the
    // agent would be handed a `<file_ref>` for a path that does not exist.
    const doc = docWith(mentionJSON('command', 'deep-research'), textJSON(' about '), mentionJSON('file', 'README.md'));
    const result = serializeDocument(doc);

    expect(result.mentions).toEqual([{ kind: 'file', label: 'README.md' }]);
  });

  test('a command chip with no arguments yields empty text, not whitespace', () => {
    const doc = docWith(mentionJSON('command', 'compact'), textJSON(' '));
    const result = serializeDocument(doc);

    expect(result.commandName).toBe('compact');
    expect(result.text).toBe('');
  });

  test('the FIRST command chip wins when a document somehow holds two', () => {
    // Reordering which command runs behind the user's back is worse than
    // ignoring the extra chip — see `collectCommandName`.
    const doc = docWith(
      mentionJSON('command', 'first'),
      textJSON(' x '),
      mentionJSON('command', 'second'),
    );

    expect(serializeDocument(doc).commandName).toBe('first');
  });

  test('a document with no command chip reports no commandName', () => {
    const doc = docWith(textJSON('just a message'), mentionJSON('file', 'README.md'));

    expect(serializeDocument(doc).commandName).toBeUndefined();
  });
});

// ── Where the chip actually sat ────────────────────────────────────────────
//
// A command chip contributes no characters, so serializing threw its POSITION
// away — and "threw away" meant "silently moved to the front". Typing
// `explain /webapp to me` produced a sent message reading `/webapp explain to
// me`, because every consumer downstream rebuilt the display as `/name` + args
// and had nothing to say otherwise.
describe('serializeDocument — command chip position', () => {
  test('a chip between words reports the text on each side', () => {
    const doc = docWith(
      textJSON('explain '),
      mentionJSON('command', 'webapp'),
      textJSON(' to me'),
    );
    const result = serializeDocument(doc);
    expect(result.commandName).toBe('webapp');
    // The wire value is unchanged — the server still gets the whole prose.
    expect(result.text).toBe('explain to me');
    expect(result.commandSplit).toEqual({ before: 'explain', after: 'to me' });
  });

  test('a leading chip reports an empty prefix', () => {
    const doc = docWith(mentionJSON('command', 'webapp'), textJSON(' build a site'));
    expect(serializeDocument(doc).commandSplit).toEqual({ before: '', after: 'build a site' });
  });

  test('a trailing chip reports an empty suffix', () => {
    const doc = docWith(textJSON('do this '), mentionJSON('command', 'webapp'));
    expect(serializeDocument(doc).commandSplit).toEqual({ before: 'do this', after: '' });
  });

  test('re-joining the halves reconstructs the args', () => {
    const doc = docWith(
      textJSON('explain '),
      mentionJSON('command', 'webapp'),
      textJSON(' to me'),
    );
    const { text, commandSplit } = serializeDocument(doc);
    expect([commandSplit!.before, commandSplit!.after].filter(Boolean).join(' ')).toBe(text);
  });

  test('a mention chip before the command does not shift the split', () => {
    // `@README.md` DOES contribute characters, so the prefix must be measured
    // through the same walk rather than counted from the source text.
    const doc = docWith(
      mentionJSON('file', 'README.md'),
      textJSON(' then '),
      mentionJSON('command', 'webapp'),
      textJSON(' go'),
    );
    const result = serializeDocument(doc);
    expect(result.text).toBe('@README.md then go');
    expect(result.commandSplit).toEqual({ before: '@README.md then', after: 'go' });
  });

  test('no command chip means no split', () => {
    expect(serializeDocument(docWith(textJSON('just text'))).commandSplit).toBeUndefined();
  });
});

describe('serializeDocument — command split across blocks', () => {
  // The split slices `rawText` by the LENGTH of a second `textBetween` call.
  // That is only sound if the prefix walk emits the same characters as the full
  // walk — block separators and hard breaks included. A paragraph boundary
  // between the prefix and the chip is where that assumption would break.
  const multi = (blocks: unknown[][]) =>
    PMNode.fromJSON(schema, {
      type: 'doc',
      content: blocks.map((content) => ({ type: 'paragraph', content })),
    });

  test('a chip in the SECOND paragraph keeps the first paragraph as its prefix', () => {
    const doc = multi([
      [textJSON('first para')],
      [textJSON('second '), mentionJSON('command', 'webapp'), textJSON(' tail')],
    ]);
    const result = serializeDocument(doc);
    expect(result.commandName).toBe('webapp');
    expect(result.commandSplit).toEqual({ before: 'first para\nsecond', after: 'tail' });
    // Whatever the split says, the halves must still reconstruct the args.
    expect(
      [result.commandSplit!.before, result.commandSplit!.after].filter(Boolean).join(' '),
    ).toBe(result.text);
  });

  test('a chip that OPENS the second paragraph still splits cleanly', () => {
    const doc = multi([[textJSON('first para')], [mentionJSON('command', 'webapp'), textJSON(' go')]]);
    const result = serializeDocument(doc);
    expect(result.commandSplit!.before).toBe('first para');
    expect(result.commandSplit!.after).toBe('go');
  });

  test('a hard break before the chip is counted, not skipped', () => {
    const doc = docWith(
      textJSON('line one'),
      { type: 'hardBreak' },
      textJSON('line two '),
      mentionJSON('command', 'webapp'),
      textJSON(' end'),
    );
    const result = serializeDocument(doc);
    expect(result.commandSplit).toEqual({ before: 'line one\nline two', after: 'end' });
  });
});
