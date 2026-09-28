import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * KRTX-562 + KRTX-607. React Native cannot be rendered under bun here, so
 * these read the source. Each check names the one line whose return breaks
 * the device behavior.
 */

const APP_ROOT = join(import.meta.dir, '..', '..', '..');
const read = (path: string) => readFileSync(join(APP_ROOT, path), 'utf8');

/** Source without comments, so prose that names `selectable` never matches. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

/** A JSX `selectable` / `selectable={…}` prop, except an explicit `={false}`. */
function nativelySelectableProps(source: string): string[] {
  return [...code(source).matchAll(/\bselectable\b(\s*=\s*\{[^}]*\})?/g)]
    .map((match) => match[0])
    .filter((prop) => !/=\s*\{\s*false\s*\}$/.test(prop));
}

// Everything the transcript's markdown draws. On Android a `selectable` root
// Text is a selectable TextView that takes the tap: a nested link, or a
// URL/path inline-code chip, never gets `onPress` (KRTX-562).
const MARKDOWN_FILES = [
  'components/kortix/selectable-markdown.tsx',
  'components/markdown/inline-code.tsx',
  'components/markdown/code-block.tsx',
  'components/markdown/math.tsx',
];

describe('nativelySelectableProps', () => {
  test('finds bare and non-false props, skips false and comments', () => {
    const source = [
      '// a selectable comment',
      '<RNText selectable>',
      '<RNText selectable={!insideLink}>',
      '<RNText selectable={false}>',
      '{/* selectable note */}',
    ].join('\n');
    expect(nativelySelectableProps(source)).toEqual(['selectable', 'selectable={!insideLink}']);
  });
});

describe('KRTX-562: transcript links stay tappable', () => {
  for (const file of MARKDOWN_FILES) {
    test(`${file} renders no natively selectable Text`, () => {
      expect(nativelySelectableProps(read(file))).toEqual([]);
    });
  }

  test('markdown links and table-cell links open through the safe link handler', () => {
    const source = read('components/kortix/selectable-markdown.tsx');
    expect(source).toContain('onPress={() => openExternalLink(node.attributes?.href)}');
    expect(source).toContain('onPress={() => openExternalLink(n.attributes?.href)}');
  });
});

describe('KRTX-607: assistant and user messages select text the same way', () => {
  const messages = {
    user: read('components/session/turn/user-message.tsx'),
    assistant: read('components/session/turn/text-part.tsx'),
  };

  for (const [side, source] of Object.entries(messages)) {
    test(`${side} message: long press → shared MessageMenu → Select text in place → Done`, () => {
      expect(source).toMatch(
        /import \{ MessageMenu, SelectableMessageText, SelectTextDoneButton \} from '\.\/message-menu';/,
      );
      expect(source).toMatch(/onLongPress=\{selecting \? undefined : openMenu\}/);
      expect(source).toMatch(/onSelectText=\{\(\) => setSelecting\(true\)\}/);
      expect(source).toMatch(/<SelectableMessageText text=\{\w+\} isDark=\{isDark\} style=\{\w+\} \/>/);
      expect(source).toMatch(/<SelectTextDoneButton[^>]*onPress=\{\(\) => setSelecting\(false\)\}/);
      // No second, local copy of the menu or the selectable text.
      expect(source).not.toMatch(/function (MessageMenu|SelectableMessageText)\b/);
    });
  }

  test('assistant text has no second gesture: the iOS double-tap sheet is off', () => {
    expect(messages.assistant).toContain('selectOnDoubleTap={false}');
  });
});
