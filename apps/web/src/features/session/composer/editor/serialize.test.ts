import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
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

const schema = getSchema([Document, Paragraph, Text, MentionNode]);

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
