import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { UnifiedMarkdown } from './unified-markdown';

/**
 * While a turn works, every text part renders with `streaming-active`
 * (`session-chat.tsx` passes `isStreaming={working}`), and `globals.css` sets
 * `display: inline` on the trailing blocks of the streamed text.
 *
 * That rule reached into a setup-link card: the card is the only ELEMENT in
 * its paragraph, so `div:last-child` matched it, and an inline box around
 * block children split into an empty bordered box after "→", a centred plug
 * tile, the stacked text and button, and a second empty box before the
 * trailing prose.
 *
 * `apps/web` has no DOM, so the real rules from `globals.css` are evaluated
 * against the real rendered markup by the small matcher below. The matcher
 * throws on any selector syntax it does not implement, so a rewritten rule
 * fails loudly instead of matching nothing and passing.
 */

const CONNECT_URL = 'http://localhost:3000/connect/ksl_7f3a91c2b4';
const REPORTED_MARKDOWN = [
  'If you want work repos in this sync, authorize it here:',
  '',
  `→ [Authorize the second GitHub account](${CONNECT_URL}) (opens a GitHub authorization; I never see the credential)`,
  '',
  "Meanwhile, here's what the personal account exposes:",
].join('\n');

// ── Markup → tree ────────────────────────────────────────────────────────────

interface El {
  tag: string;
  attrs: Record<string, string>;
  classes: Set<string>;
  children: El[];
  parent: El | null;
}

/** React static markup only: every void element is emitted self-closed. */
function parseMarkup(html: string): El {
  const root: El = { tag: '#root', attrs: {}, classes: new Set(), children: [], parent: null };
  let current = root;
  const tagPattern = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  for (const [, closing, tag, rawAttrs, selfClosing] of html.matchAll(tagPattern)) {
    if (closing) {
      if (current.tag !== tag) throw new Error(`unbalanced </${tag}> inside <${current.tag}>`);
      current = current.parent!;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, name, value] of rawAttrs.matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)) {
      attrs[name] = value ?? '';
    }
    const el: El = {
      tag,
      attrs,
      classes: new Set((attrs.class ?? '').split(/\s+/).filter(Boolean)),
      children: [],
      parent: current,
    };
    current.children.push(el);
    if (!selfClosing) current = el;
  }
  if (current !== root) throw new Error(`unclosed <${current.tag}>`);
  return root;
}

function descendants(el: El): El[] {
  return el.children.flatMap((child) => [child, ...descendants(child)]);
}

// ── The rules under test ─────────────────────────────────────────────────────

function splitTopLevel(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (depth === 0 && separator.test(text[i])) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Every selector in `globals.css` that sets `display: inline` under `streaming-active`. */
function streamingInlineSelectors(): string[] {
  const css = readFileSync(join(import.meta.dir, '../../app/globals.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const selectors: string[] = [];
  for (const [, selectorText, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorText.includes('streaming-active')) continue;
    if (!/(^|;)\s*display:\s*inline\s*(;|$)/.test(body.trim())) continue;
    selectors.push(...splitTopLevel(selectorText.replace(/\s+/g, ' '), /,/));
  }
  return selectors;
}

// ── Selector matcher: exactly the grammar those rules use ────────────────────

type Compound = (el: El) => boolean;

function parseCompound(source: string): Compound {
  const checks: Compound[] = [];
  let rest = source;
  const tag = /^(?:\*|[a-zA-Z][\w-]*)/.exec(rest);
  if (tag) {
    if (tag[0] !== '*') checks.push((el) => el.tag === tag[0]);
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    const attr = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]/.exec(rest);
    if (attr) {
      const [, name, dq, sq, bare] = attr;
      const value = dq ?? sq ?? bare;
      checks.push((el) => name in el.attrs && (value === undefined || el.attrs[name] === value));
      rest = rest.slice(attr[0].length);
      continue;
    }
    const cls = /^\.([\w-]+)/.exec(rest);
    if (cls) {
      checks.push((el) => el.classes.has(cls[1]));
      rest = rest.slice(cls[0].length);
      continue;
    }
    if (rest.startsWith(':last-child')) {
      checks.push((el) => el.parent !== null && el.parent.children.at(-1) === el);
      rest = rest.slice(':last-child'.length);
      continue;
    }
    const fn = /^:(not|has)\(/.exec(rest);
    if (fn) {
      let depth = 1;
      let end = fn[0].length;
      while (depth > 0) {
        if (end >= rest.length) throw new Error(`unclosed :${fn[1]}( in ${source}`);
        if (rest[end] === '(') depth++;
        if (rest[end] === ')') depth--;
        end++;
      }
      const inner = parseCompound(rest.slice(fn[0].length, end - 1));
      checks.push(
        fn[1] === 'not' ? (el) => !inner(el) : (el) => descendants(el).some((d) => inner(d)),
      );
      rest = rest.slice(end);
      continue;
    }
    throw new Error(`selector syntax this test does not implement: "${rest}" in "${source}"`);
  }
  return (el) => checks.every((check) => check(el));
}

/** Descendant (` `) and child (`>`) combinators; anything else throws via `parseCompound`. */
function matches(selector: string, el: El): boolean {
  const tokens = splitTopLevel(selector.replace(/\s*>\s*/g, ' > '), /\s/);
  const compounds: Compound[] = [];
  const combinators: Array<' ' | '>'> = [];
  for (const token of tokens) {
    if (token === '>') combinators[compounds.length - 1] = '>';
    else {
      if (compounds.length > combinators.length) combinators.push(' ');
      compounds.push(parseCompound(token));
    }
  }
  // Right to left with backtracking: compound `i` must match `node`, then
  // compound `i - 1` must match its parent (`>`) or some ancestor (` `).
  const matchFrom = (i: number, node: El): boolean => {
    if (!compounds[i](node)) return false;
    if (i === 0) return true;
    if (combinators[i - 1] === '>') return node.parent !== null && matchFrom(i - 1, node.parent);
    for (let a = node.parent; a; a = a.parent) if (matchFrom(i - 1, a)) return true;
    return false;
  };
  return matchFrom(compounds.length - 1, el);
}

// ── Render ───────────────────────────────────────────────────────────────────

function render(content: string, isStreaming: boolean): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <UnifiedMarkdown content={content} isStreaming={isStreaming} />
    </NextIntlClientProvider>,
  );
}

/**
 * Streamdown renders streaming content on the client only, so the server
 * render of `isStreaming` is an empty shell. The block tree is the one the
 * static render produces; the only thing streaming adds on the wrapper is the
 * class, which the first test pins so this substitution cannot drift.
 */
function renderAsStreaming(content: string): El {
  return parseMarkup(
    render(content, false).replace(
      'class="kortix-markdown ',
      'class="kortix-markdown streaming-active ',
    ),
  );
}

function inlinedBy(el: El, selectors: string[]): string[] {
  return selectors.filter((selector) => matches(selector, el));
}

describe('streaming-active display:inline rule vs the setup-link card', () => {
  test('a streaming render carries `streaming-active` on the markdown root', () => {
    const root = parseMarkup(render(REPORTED_MARKDOWN, true));
    const wrapper = descendants(root).find((el) => el.classes.has('kortix-markdown'));

    expect(wrapper?.classes.has('streaming-active')).toBe(true);
  });

  test('globals.css still defines the streaming display:inline rules', () => {
    // Guards the rest of this suite: with zero selectors, every "not
    // inlined" assertion below would hold for any stylesheet.
    expect(streamingInlineSelectors().length).toBeGreaterThan(0);
  });

  test('the connect card keeps its block layout while the turn is working', () => {
    const selectors = streamingInlineSelectors();
    const tree = renderAsStreaming(REPORTED_MARKDOWN);
    const card = descendants(tree).find((el) => el.attrs['data-slot'] === 'item');
    if (!card) throw new Error('setup-link card did not render');
    const actions = descendants(card).find((el) => el.attrs['data-slot'] === 'item-actions');
    if (!actions) throw new Error('setup-link card rendered without its actions slot');

    expect({ card: inlinedBy(card, selectors), actions: inlinedBy(actions, selectors) }).toEqual({
      card: [],
      actions: [],
    });
  });

  test('the trailing text block still goes inline so the caret stays on its line', () => {
    const selectors = streamingInlineSelectors();
    const tree = renderAsStreaming(REPORTED_MARKDOWN);
    const blocks = descendants(tree).filter((el) => el.classes.has('text-foreground/95'));
    const trailing = blocks.at(-1);
    if (!trailing) throw new Error('no markdown paragraph blocks rendered');

    expect(inlinedBy(trailing, selectors).length).toBeGreaterThan(0);
  });
});

describe('the selector matcher this suite relies on', () => {
  const tree = parseMarkup(
    '<div class="a"><div class="b"><span></span><div class="c" data-slot="x">text</div></div>tail text</div>',
  );
  const [a] = tree.children;
  const [b] = a.children;
  const c = b.children[1];

  test('descendant and child combinators', () => {
    expect(matches('.a .c', c)).toBe(true);
    expect(matches('.a > .c', c)).toBe(false);
    expect(matches('.a > .b > .c', c)).toBe(true);
    expect(matches('.a > * > div', c)).toBe(true);
  });

  test(':last-child counts elements only, never text nodes', () => {
    expect(matches('div:last-child', b)).toBe(true);
    expect(matches('div:last-child', c)).toBe(true);
    expect(matches('span:last-child', b.children[0])).toBe(false);
  });

  test(':not, :has and attribute selectors', () => {
    expect(matches('div:has(.c)', a)).toBe(true);
    expect(matches('div:not(:has(.c))', a)).toBe(false);
    expect(matches('div:not([data-slot])', c)).toBe(false);
    expect(matches('div[data-slot="x"]', c)).toBe(true);
  });

  test('unimplemented syntax throws instead of silently not matching', () => {
    expect(() => matches('.a + .b', b)).toThrow('does not implement');
    expect(() => matches('div:first-child', b)).toThrow('does not implement');
  });

  test('a rule scoped to top-level blocks spares the card and keeps the trailing block', () => {
    const scoped = ['.kortix-markdown.streaming-active > div > div:last-child'];
    const rendered = renderAsStreaming(REPORTED_MARKDOWN);
    const card = descendants(rendered).find((el) => el.attrs['data-slot'] === 'item')!;
    const trailing = descendants(rendered)
      .filter((el) => el.classes.has('text-foreground/95'))
      .at(-1)!;

    expect(inlinedBy(card, scoped)).toEqual([]);
    expect(inlinedBy(trailing, scoped)).toEqual(scoped);
  });
});
