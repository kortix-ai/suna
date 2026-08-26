import { KATEX_FENCE_LANGUAGES } from '@/components/markdown/katex-markdown';
import {
  probeFileAvailability,
  resetFileAvailability,
} from '@/features/session/file-availability';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownCode, type MarkdownCodeProps } from './markdown-code';

const render = (props: MarkdownCodeProps) => renderToStaticMarkup(<MarkdownCode {...props} />);

/**
 * The card header's language chip, found by its test hook rather than a
 * styling class — the card also renders the code itself, so a whole-markup
 * match on the language name would pass with the header blank.
 *
 * The hook may sit ANYWHERE in the tag: an earlier version required
 * `data-testid` to be the first attribute, so adding one prop ahead of it in
 * `code-block.tsx` would have re-broken this the same way the `uppercase` →
 * `lowercase` class change did — silently, by returning `''`. And a miss throws
 * rather than returning `''`, because a selector that has stopped matching must
 * fail the test, not quietly assert about an empty string.
 */
const LANGUAGE_CHIP =
  /<span\b[^>]*\bdata-testid="code-block-language"[^>]*>([^<]*)<\/span>/;
const labelOf = (html: string) => {
  const found = html.match(LANGUAGE_CHIP);
  if (!found) throw new Error('no [data-testid="code-block-language"] span in the rendered card');
  return found[1] ?? '';
};

/** `not-prose` sits on the card root and nowhere else in this subtree. */
const CARD = 'not-prose';
const COPY = 'aria-label="Copy code"';

describe('MarkdownCode — fenced blocks', () => {
  test('a mermaid fence takes the diagram path, not the code card', () => {
    // MermaidRenderer is lazy() inside a Suspense with a null fallback, and a
    // server render emits the fallback for anything that suspends — so the
    // diagram's SSR footprint is the empty string. Asserting emptiness is what
    // proves the card was skipped; a diagram cannot appear here at all.
    const markup = render({ className: 'language-mermaid', children: 'graph TD;\n  A-->B;' });

    expect(markup).toBe('');
    expect(markup).not.toContain(CARD);
    expect(markup).not.toContain(COPY);
  });

  test('mermaid-looking content with no language hint also skips the card', () => {
    const markup = render({ children: 'sequenceDiagram\n  A->>B: hi' });

    expect(markup).toBe('');
  });

  test('every KaTeX fence language renders the math block', () => {
    expect(KATEX_FENCE_LANGUAGES.size).toBeGreaterThan(0);

    for (const language of KATEX_FENCE_LANGUAGES) {
      const markup = render({ className: `language-${language}`, children: 'E = mc^2' });

      expect(markup).toContain('katex-math-block');
      expect(markup).not.toContain(CARD);
      expect(markup).not.toContain(COPY);
    }
  });

  test('a KaTeX fence is matched case-insensitively', () => {
    expect(render({ className: 'language-LaTeX', children: 'E = mc^2' })).toContain(
      'katex-math-block',
    );
  });

  test('a plain fence renders the code card with its language label and a copy button', () => {
    // Single-line on purpose: `language-` in the className is what makes this a
    // block, not the newline the other fences here happen to carry.
    const markup = render({ className: 'language-typescript', children: 'const a = 1;' });

    expect(markup).toContain(CARD);
    expect(markup).toContain(COPY);
    expect(labelOf(markup)).toBe('typescript');
  });

  test('isStreaming keeps the copy button and the label', () => {
    // The message-wide streaming flag must not strip copy from blocks whose
    // fence already closed; a mid-stream click copies the visible snapshot.
    const markup = render({
      className: 'language-typescript',
      children: 'const a = 1;',
      isStreaming: true,
    });

    expect(markup).toContain(COPY);
    expect(markup).toContain(CARD);
    expect(labelOf(markup)).toBe('typescript');
  });

  test('a fence with no language hint still renders the card, labelled text', () => {
    const markup = render({ children: 'const a = 1;\nconst b = 2;' });

    expect(markup).toContain(CARD);
    expect(markup).toContain(COPY);
    expect(labelOf(markup)).toBe('text');
  });
});

describe('MarkdownCode — inline code', () => {
  test('plain inline code renders the inline chip, not a card', () => {
    const markup = render({ children: 'npm run dev' });

    expect(markup.startsWith('<code')).toBe(true);
    expect(markup).toContain('npm run dev');
    expect(markup).not.toContain(CARD);
    expect(markup).not.toContain(COPY);
    // Neither of the ClickableInlineCode treatments applies to a bare command.
    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain('href');
  });

  test('inline code holding a setup-link path renders the setup chip', () => {
    const markup = render({ children: '/secret-intake/ksl_7f3a91c2b4' });

    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).toContain('Enter credentials');
    // The chip replaces the token entirely; a wall of token characters in the
    // transcript is the thing this interception exists to prevent.
    expect(markup).not.toContain('ksl_7f3a91c2b4');
  });

  test('a connector setup link gets the connector chip', () => {
    // Agents mint these against FRONTEND_URL, so the absolute form is the one
    // that actually arrives; server-side there is no window to compare origins.
    const markup = render({ children: 'http://localhost:3000/connect/ksl_7f3a91c2b4' });

    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).toContain('Connect app');
  });

  test('an absolute file path becomes a preview target', () => {
    const markup = render({ children: '/workspace/src/app.ts' });

    expect(markup).toContain('role="button"');
    expect(markup).toContain('Click to preview /workspace/src/app.ts');
    expect(markup).toContain('cursor-pointer');
    expect(markup).not.toContain('href');
  });

  test('a relative file path is a preview target too — the panel takes that form', () => {
    // It used to render `cursor-not-allowed` with a `role="button"` wired to
    // `undefined`: an element announcing itself as a button while doing
    // nothing. The panel has always accepted project-relative paths — it is
    // exactly what `useOcFileOpen` hands it — so the affordance was wrong,
    // not the path.
    const markup = render({ children: 'src/app.ts' });

    expect(markup).toContain('role="button"');
    expect(markup).toContain('Click to preview src/app.ts');
    expect(markup).toContain('cursor-pointer');
    expect(markup).not.toContain('cursor-not-allowed');
  });

  test('a path is keyboard-reachable, not mouse-only', () => {
    const markup = render({ children: '/workspace/src/app.ts' });

    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('focus-visible:ring-2');
  });

  test('a path the runtime cannot produce loses its affordance entirely', async () => {
    // The reported bug: the agent deleted build_comp_xlsx.py, the row
    // announcing the deletion still painted it hover-blue and `role="button"`,
    // and clicking it dead-ended the viewer on "This file couldn't be opened".
    // Seed the verdict the way a hover probe would, then render.
    resetFileAvailability();
    await probeFileAvailability('/workspace/build_comp_xlsx.py', {
      resolve: async (p) => p,
      read: async () => {
        throw new Error('ENOENT');
      },
    });

    const markup = render({ children: '/workspace/build_comp_xlsx.py' });

    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain('cursor-pointer');
    expect(markup).not.toContain('Click to preview');
    expect(markup).toContain('not available in this session');
    expect(markup).toContain('text-muted-foreground');

    resetFileAvailability();
  });

  test('a URL becomes a link that opens in a new tab', () => {
    const markup = render({ children: 'https://kortix.com/docs' });

    expect(markup.startsWith('<a')).toBe(true);
    expect(markup).toContain('href="https://kortix.com/docs"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain('role="button"');
  });
});

// ─── Children are not always a bare string ──────────────────────────────────
// The parser hands `code` a plain string, but anything in the render path may
// replace it with an element — `wrapChildrenWithPaths` did, for every fence
// whose body held a file path. `String(children)` then produced the literal
// `[object Object]`: Shiki highlighted it, the copy button copied it, and the
// Mermaid/KaTeX routing stopped recognising its own content.
// ────────────────────────────────────────────────────────────────────────────

describe('MarkdownCode with wrapped children', () => {
  test('reads the math out of a wrapping element', () => {
    const markup = render({ className: 'language-latex', children: <span>E = mc^2</span> });

    expect(markup).toContain('katex-math-block');
    expect(markup).not.toContain('[object Object]');
    expect(markup).toContain('E = mc^2');
  });

  test('still recognises mermaid content behind a wrapping element', () => {
    const markup = render({ children: <span>{'sequenceDiagram\n  A->>B: hi'}</span> });

    expect(markup).toBe('');
  });

  test('still detects a fenced block by its newline behind a wrapping element', () => {
    const markup = render({ children: <span>{'cd ~/UnrealEngine\n./Setup.sh\n'}</span> });

    expect(markup).toContain(CARD);
    expect(markup).not.toContain('[object Object]');
  });

  test('inline code keeps its file affordance behind a wrapping element', () => {
    const markup = render({ children: <span>docs/readme.md</span> });

    expect(markup).toContain('Click to preview docs/readme.md');
  });
});
