import { TooltipProvider } from '@/components/ui/tooltip';
import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';

/**
 * Task 16 follow-up. `ToolPartRenderer` is the funnel every tool call passes
 * through, and it hands `defaultOpen` / `forceOpen` / `locked` down to whatever
 * component draws the call. Nothing pinned that hand-off, and two of its three
 * branches silently dropped the props — invisible while the panel surface
 * rendered every body unconditionally, and a dead row the moment the panel
 * became a disclosure.
 *
 * The two branches tested here are exactly the two that were broken, and they
 * are the two with no component file of their own to test through:
 *
 *  - the THROWN-ERROR branch, which builds its `BasicTool` inline;
 *  - the FALLBACK branch, `GenericTool`, which draws every unregistered tool —
 *    i.e. every MCP tool a user has connected.
 *
 * Both are asserted on the panel surface, where a closed row means the content
 * is genuinely unreachable, and where `defaultOpen` is what the Advanced panel
 * and a single-call Easy detail both pass.
 */
function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
}

function renderPanel(part: ToolPart, opts: { defaultOpen?: boolean } = {}) {
  return renderToStaticMarkup(
    withProviders(
      <ToolSurfaceContext.Provider value="panel">
        <ToolPartRenderer part={part} sessionId="s1" defaultOpen={opts.defaultOpen} />
      </ToolSurfaceContext.Provider>,
    ),
  );
}

const THROWN = {
  type: 'tool',
  tool: 'bash',
  callID: 'call-thrown',
  state: { status: 'error', input: {}, error: 'ENOENT: no such file or directory' },
} as unknown as ToolPart;

// No registered renderer — the shape every MCP tool arrives in.
const UNREGISTERED = {
  type: 'tool',
  tool: 'linear/create_issue',
  callID: 'call-mcp',
  state: {
    status: 'completed',
    input: { title: 'Fix the panel' },
    output: 'Created issue JAY-1234.',
    metadata: {},
  },
} as unknown as ToolPart;

describe('ToolPartRenderer forwards the open props to every branch', () => {
  test('a thrown error opens with defaultOpen — the error text IS the content', () => {
    const html = renderPanel(THROWN, { defaultOpen: true });

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('ENOENT: no such file or directory');
  });

  test('without defaultOpen the errored row is closed, but still openable', () => {
    const html = renderPanel(THROWN);

    // Closed — and a real control, not the dead row a dropped prop produced.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="button"');
    expect(html).not.toContain('ENOENT: no such file or directory');
  });

  test('an unregistered (MCP) tool opens with defaultOpen — GenericTool gets the prop', () => {
    const html = renderPanel(UNREGISTERED, { defaultOpen: true });

    // GenericTool's own trigger, so the fallback really is what rendered.
    expect(html).toContain('Create Issue');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Created issue JAY-1234.');
  });

  test('without defaultOpen the unregistered row is closed, but still openable', () => {
    const html = renderPanel(UNREGISTERED);

    expect(html).toContain('Create Issue');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="button"');
    expect(html).not.toContain('Created issue JAY-1234.');
  });
});

/**
 * The two render tests above cover the two branches that actually broke. This
 * covers the other ~60 call sites they cannot reach.
 *
 * Sixteen renderers had already silently dropped `defaultOpen` before the panel
 * became a disclosure — harmless then, a dead row now — and two more slipped
 * through the conversion itself. The failure is invisible by construction: the
 * row still renders, just shut, so nothing throws and nothing looks broken
 * until you click it. A source sweep is the only guard that scales to every
 * renderer without a render test per tool.
 *
 * The rule is narrow on purpose: a `<BasicTool>` WITH children must mention
 * `defaultOpen` among its props. A self-closing one has nothing to open and is
 * exempt (`agent-stop`, `project-delete`). What the value is — the prop, a
 * literal, an `||` of both — is the renderer's business.
 */
describe('every BasicTool with a body accepts defaultOpen', () => {
  const toolDir = join(__dirname, 'tools');
  const sources: [string, string][] = [
    ...readdirSync(toolDir)
      .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .sort()
      .map((f): [string, string] => [`tools/${f}`, readFileSync(join(toolDir, f), 'utf8')]),
    ['generic-tool.tsx', readFileSync(join(__dirname, 'generic-tool.tsx'), 'utf8')],
    ['tool-part-renderer.tsx', readFileSync(join(__dirname, 'tool-part-renderer.tsx'), 'utf8')],
  ];

  /** Every `<BasicTool …>` open tag in `source`, as `{ props, selfClosing }`. */
  function openTags(source: string): { props: string; selfClosing: boolean; line: number }[] {
    const tags: { props: string; selfClosing: boolean; line: number }[] = [];
    for (const match of source.matchAll(/<BasicTool\b/g)) {
      const start = match.index + match[0].length;
      // Scan to the `>` that closes the tag, ignoring any inside a `{…}` prop
      // value (every trigger object and JSX-node trigger contains `>`).
      let depth = 0;
      let i = start;
      for (; i < source.length; i++) {
        const c = source[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) break;
      }
      const selfClosing = source[i - 1] === '/';
      tags.push({
        props: source.slice(start, selfClosing ? i - 1 : i),
        selfClosing,
        line: source.slice(0, match.index).split('\n').length,
      });
    }
    return tags;
  }

  test('the sweep finds the call sites it claims to check (it is not silently empty)', () => {
    const total = sources.reduce((n, [, src]) => n + openTags(src).length, 0);
    expect(total).toBeGreaterThan(50);
    // And it can tell the two shapes apart — otherwise the rule below is vacuous.
    const bodied = sources.flatMap(([, src]) => openTags(src)).filter((t) => !t.selfClosing);
    expect(bodied.length).toBeGreaterThan(40);
    expect(bodied.length).toBeLessThan(total);
  });

  test('no body-bearing call site drops it', () => {
    const gaps = sources.flatMap(([name, src]) =>
      openTags(src)
        .filter((t) => !t.selfClosing && !t.props.includes('defaultOpen'))
        .map((t) => `${name}:${t.line}`),
    );
    expect(gaps).toEqual([]);
  });
});
