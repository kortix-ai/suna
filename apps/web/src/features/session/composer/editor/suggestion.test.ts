import { Editor } from '@tiptap/core';
import type { PluginKey } from '@tiptap/pm/state';
import { findSuggestionMatch } from '@tiptap/suggestion';
import { PluginKey as PMPluginKey } from '@tiptap/pm/state';
import { describe, expect, test } from 'bun:test';

import { baseExtensions } from './extensions';
import { MentionNode } from './mention-node';
import { baseSuggestion } from './suggestion';
import type { MenuController } from './suggestion';

/**
 * Pins the two headline spec fixes this task exists for, DIRECTLY against
 * `baseSuggestion`'s real config — not a hand-copied regex — by feeding that
 * config straight into `@tiptap/suggestion`'s own exported `findSuggestionMatch`.
 * This is the same function the live plugin runs on every transaction
 * (`plugin/state.ts`'s `apply()`), so a match/no-match verdict here is exactly
 * what the plugin would decide in a real editor — no browser needed.
 *
 * `$position` comes from a REAL headless `@tiptap/core` `Editor` (same
 * approach as `composer-editor.test.ts` — no DOM required as long as no
 * `element` option is passed to `new Editor()`), typed into via
 * `insertContent`, exactly the way `mention-menu.tsx`/`slash-menu.tsx`'s
 * production code will encounter it.
 */
function resolvedPositionAfterTyping(text: string) {
  const editor = new Editor({
    extensions: [...baseExtensions(() => ''), MentionNode],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  editor.commands.insertContent({ type: 'text', text });
  return editor.state.selection.$from;
}

const noopController: MenuController<unknown> = {
  onStart: () => {},
  onUpdate: () => {},
  onKeyDown: () => false,
  onExit: () => {},
};

function matchFor(char: string, pluginKey: PluginKey, text: string) {
  const options = baseSuggestion(char, pluginKey, noopController);
  return findSuggestionMatch({
    char: options.char ?? char,
    allowSpaces: options.allowSpaces ?? false,
    allowToIncludeChar: options.allowToIncludeChar ?? false,
    allowedPrefixes: options.allowedPrefixes ?? null,
    startOfLine: options.startOfLine ?? false,
    $position: resolvedPositionAfterTyping(text),
  });
}

describe('baseSuggestion(\'@\', ...) — allowedPrefixes: [\' \', \'\\n\'] keeps emails out', () => {
  const key = new PMPluginKey('t-mention');

  test('user@example.com never opens the mention menu — "@" is mid-word, not after whitespace', () => {
    expect(matchFor('@', key, 'user@example.com')).toBeNull();
  });

  test('@foo at the very start of input matches, query "foo"', () => {
    expect(matchFor('@', key, '@foo')?.query).toBe('foo');
  });

  test('hi @foo — "@" right after whitespace — matches, query "foo"', () => {
    expect(matchFor('@', key, 'hi @foo')?.query).toBe('foo');
  });

  test('an empty query right after "@" still matches (menu opens with no filter yet)', () => {
    expect(matchFor('@', key, 'hi @')?.query).toBe('');
  });
});

describe('baseSuggestion(\'/\', ...) — startOfLine: false is the fix for "/" stuck at position 0', () => {
  const key = new PMPluginKey('t-slash');

  test('hello /dep matches MID-LINE, query "dep" — impossible under the old /^\\/(\\S*)$/ regex', () => {
    expect(matchFor('/', key, 'hello /dep')?.query).toBe('dep');
  });

  test('/dep at the start of input still matches too', () => {
    expect(matchFor('/', key, '/dep')?.query).toBe('dep');
  });

  test('a bare word with no trigger char never matches', () => {
    expect(matchFor('/', key, 'hello world')).toBeNull();
  });

  test('a slash embedded in a word (a/b) does not match — still gated by allowedPrefixes', () => {
    expect(matchFor('/', key, 'a/b')).toBeNull();
  });
});
