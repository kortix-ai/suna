import { getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection } from '@tiptap/pm/state';
import { describe, expect, test } from 'bun:test';

import { MentionNode } from './mention-node';

/**
 * No jsdom/happy-dom is registered for `bun test` in this repo
 * (`apps/web/test-setup.ts` adds none), so these tests exercise the real
 * `@tiptap/core` schema builder (`getSchema`) and the real `@tiptap/pm`
 * (prosemirror-model / prosemirror-state) directly — no browser, and nothing
 * about MentionNode itself is mocked. `Document`/`Paragraph`/`Text` stand in
 * for `baseExtensions()` (Task 3) purely because a ProseMirror schema needs
 * a root node type; MentionNode is the only extension actually under test.
 *
 * One real behaviour is NOT covered here and needs a live browser: a raw
 * Backspace keypress converting a text cursor sitting right after the badge
 * into a NodeSelection. ProseMirror decides that via
 * `view.endOfTextblock('backward', state)`, a DOM layout query with no
 * headless equivalent. What IS covered is the other half of "one backspace
 * removes it whole" — once a NodeSelection exists on the atom, deleting it
 * removes the node in a single transaction (see "deleting a duplicate"
 * below).
 */
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

function textJSON(text: string) {
  return { type: 'text', text };
}

function mentionPositions(doc: PMNode): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'mention') positions.push(pos);
  });
  return positions;
}

describe('MentionNode schema shape', () => {
  test('is an atom — the caret can never land inside the badge', () => {
    expect(schema.nodes.mention.isAtom).toBe(true);
  });

  test('is inline, so it sits alongside text in a paragraph', () => {
    expect(schema.nodes.mention.isInline).toBe(true);
  });

  test('is selectable, which is what lets a real EditorView select it whole on Backspace', () => {
    expect(schema.nodes.mention.spec.selectable).toBe(true);
  });

  test('is a leaf: no child position exists inside it', () => {
    // isLeaf is the structural reason the caret cannot enter — a leaf node
    // has no content, so ProseMirror never allocates a position between the
    // "start" and "end" of the node the way it would for a container.
    expect(schema.nodes.mention.isLeaf).toBe(true);
  });
});

describe('duplicate mentions', () => {
  // The bug this node model exists to kill: session-chat-input.tsx:1055-1080
  // resolved a mention with text.indexOf(needle), which finds only the
  // FIRST match. Type @README.md twice and the second rendered as plain
  // text. Every mention is now its own node, so duplicates cannot collapse.
  test('two mentions with the identical label are distinct nodes at different positions', () => {
    const doc = docWith(
      textJSON('see '),
      mentionJSON('file', 'README.md'),
      textJSON(' and '),
      mentionJSON('file', 'README.md'),
    );
    const positions = mentionPositions(doc);
    expect(positions).toHaveLength(2);
    expect(positions[0]).not.toBe(positions[1]);
  });

  test('both occurrences render, not just the first', () => {
    const doc = docWith(
      textJSON('see '),
      mentionJSON('file', 'README.md'),
      textJSON(' and '),
      mentionJSON('file', 'README.md'),
    );
    const rendered = doc.textBetween(0, doc.content.size, '\n', (node) =>
      node.type.name === 'mention' ? `@${node.attrs.label}` : '',
    );
    expect(rendered).toBe('see @README.md and @README.md');
  });
});

describe('deleting one duplicate leaves the other intact', () => {
  // Mirrors session-chat-input.tsx:1038, which pruned mentions by
  // `val.includes('@' + m.label)` — a check that could not tell the two
  // duplicates apart, so a delete untracked neither.
  test('a NodeSelection delete removes exactly one node in a single transaction', () => {
    const doc = docWith(
      textJSON('see '),
      mentionJSON('file', 'README.md'),
      textJSON(' and '),
      mentionJSON('file', 'README.md'),
    );
    const [firstPos] = mentionPositions(doc);
    const firstNode = doc.nodeAt(firstPos)!;
    expect(firstNode.nodeSize).toBe(1); // atomic: nothing to partially delete

    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, firstPos) });
    const after = state.apply(state.tr.deleteSelection());

    const remainingLabels: string[] = [];
    after.doc.descendants((node) => {
      if (node.type.name === 'mention') remainingLabels.push(String(node.attrs.label));
    });
    expect(remainingLabels).toEqual(['README.md']);

    // No stray fragment (e.g. "@README.m") from a partial deletion, and the
    // surviving duplicate is untouched — deleting node A never touches
    // node B, even with an identical label.
    const renderedAfter = after.doc.textBetween(0, after.doc.content.size, '\n', (node) =>
      node.type.name === 'mention' ? `@${node.attrs.label}` : '',
    );
    expect(renderedAfter).toBe('see  and @README.md');
  });
});

describe('renderHTML output', () => {
  test('carries the exact class string, the data-mention kind, and the aria-label', () => {
    const node = PMNode.fromJSON(schema, mentionJSON('file', 'README.md'));
    const toDOM = schema.nodes.mention.spec.toDOM!;
    const [tag, attrs, content] = toDOM(node) as [string, Record<string, string>, string];

    expect(tag).toBe('span');
    expect(attrs['data-mention']).toBe('file');
    expect(attrs['aria-label']).toBe('file mention: README.md');
    // Asserted by class, not by the whole string in order: the exact
    // concatenation order is an implementation detail of how `chipClass`
    // composes its base, and pinning it turns any reshuffle into a false
    // failure. What must hold is the visual contract — every chip carries the
    // faint primary tint in BOTH themes and rides the line it sits on.
    expect(attrs.class).toContain('bg-primary/[0.08]');
    expect(attrs.class).toContain('dark:bg-primary/[0.08]');
    expect(attrs.class).toContain('align-baseline');
    expect(content).toBe('@README.md');
  });

  test('a session mention carries its own kind and label in the aria-label', () => {
    const node = PMNode.fromJSON(schema, mentionJSON('session', 'Fix the parser', 'ses_abc'));
    const toDOM = schema.nodes.mention.spec.toDOM!;
    const [, attrs] = toDOM(node) as [string, Record<string, string>, string];

    expect(attrs['data-mention']).toBe('session');
    expect(attrs['aria-label']).toBe('session mention: Fix the parser');
  });

  test('a command chip renders with a slash, its own tint, and a command aria-label', () => {
    // The `/` prefix is the whole visual difference between "I am pointing at
    // this" and "I am running this" — a command chip that rendered `@name`
    // would be indistinguishable from a mention of a file with that name.
    const node = PMNode.fromJSON(schema, mentionJSON('command', 'deep-research'));
    const toDOM = schema.nodes.mention.spec.toDOM!;
    const [, attrs, content] = toDOM(node) as [string, Record<string, string>, string];

    expect(content).toBe('/deep-research');
    expect(attrs['data-mention']).toBe('command');
    expect(attrs['aria-label']).toBe('command: /deep-research');
    // Commands and mentions now share one tint; the `/` prefix above is the
    // visual difference. `not.toContain` pins that the old neutral base
    // (`bg-muted`) never resurfaces beside the tint, where stylesheet order —
    // not this file — would pick the winner.
    expect(attrs.class).toContain('bg-primary/[0.08]');
    expect(attrs.class).not.toContain('bg-muted');
    // `dark:bg-*` is a different variant group, so an unprefixed `bg-*` cannot
    // stand in for it. Without the explicit dark override the chip loses its
    // tint in dark mode only.
    expect(attrs.class).toContain('dark:bg-primary/[0.08]');
    expect(attrs.class).not.toContain('dark:bg-card');
  });
});

describe('HTML round-trip', () => {
  // Fix round 1, finding 2: parseHTML() matches span[data-mention], but the
  // node used to render kind/label/value only via TipTap's default
  // per-attribute fallback (bare, non-namespaced `kind=`/`label=`/`value=`
  // attributes) rather than the documented `data-mention-*` shape. Each
  // attribute now has its own renderHTML/parseHTML pair, so this proves the
  // actual read-back, not just that a matching tag exists.
  test('rendering to HTML and parsing it back recovers kind, label and value', () => {
    const original = PMNode.fromJSON(schema, mentionJSON('session', 'Fix the parser', 'ses_abc'));
    const toDOM = schema.nodes.mention.spec.toDOM!;
    const [, htmlAttrs] = toDOM(original) as [string, Record<string, string>, string];

    // No DOM parser exists in this test environment, so "parsing it back"
    // calls the REAL getAttrs closure TipTap built from parseHTML() below
    // (via injectExtensionAttributesToParseRule), against a minimal element
    // stand-in that implements only the one method that closure calls —
    // getAttribute(name). The closure itself is not reimplemented or mocked.
    const fakeElement = {
      getAttribute: (name: string) => htmlAttrs[name] ?? null,
    } as unknown as HTMLElement;

    const [parseRule] = schema.nodes.mention.spec.parseDOM!;
    const parsed = parseRule.getAttrs!(fakeElement);

    expect(parsed).toEqual({ kind: 'session', label: 'Fix the parser', value: 'ses_abc' });
  });

  test('a mention with no value (file/agent kinds) still round-trips label and kind', () => {
    const original = PMNode.fromJSON(schema, mentionJSON('agent', 'build', ''));
    const toDOM = schema.nodes.mention.spec.toDOM!;
    const [, htmlAttrs] = toDOM(original) as [string, Record<string, string>, string];

    const fakeElement = {
      getAttribute: (name: string) => htmlAttrs[name] ?? null,
    } as unknown as HTMLElement;

    const [parseRule] = schema.nodes.mention.spec.parseDOM!;
    const parsed = parseRule.getAttrs!(fakeElement);

    expect(parsed).toEqual({ kind: 'agent', label: 'build', value: '' });
  });
});
