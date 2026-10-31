import { toolCallBlock } from '@kortix/sdk';
import './register';
import { TooltipProvider } from '../../../primitives/tooltip';
import { ToolRunningContext, ToolSurfaceContext } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolPartRenderer } from '../tool-part-renderer';
import type { ToolPart } from '../../../internal/session-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../../../test-utils/intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { KortixActionTool } from './kortix-action-tool';
import { KORTIX_PLATFORM_TOOLS, parseKortixToolResult } from './kortix-tool-card';

// Synthetic values only: every name, id and URL below is invented.

/** Missing catalog keys land here; every render asserts there are none. */
let intlErrors: unknown[] = [];

function render(node: ReactNode, opts: { running?: boolean; panel?: boolean } = {}) {
  intlErrors = [];
  let tree = node;
  if (opts.running) tree = <ToolRunningContext.Provider value>{tree}</ToolRunningContext.Provider>;
  if (opts.panel) tree = <ToolSurfaceContext.Provider value="panel">{tree}</ToolSurfaceContext.Provider>;
  const html = renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={(error) => intlErrors.push(error)}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>{tree}</TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>,
  );
  expect(intlErrors).toEqual([]);
  return html;
}

function part(tool: string, state: Record<string, unknown>, input: Record<string, unknown> = { action: 'list' }): ToolPart {
  return { type: 'tool', tool, callID: 'call-1', state: { input, ...state } } as unknown as ToolPart;
}

function done(tool: string, result: Record<string, unknown>, input?: Record<string, unknown>) {
  return toolCallBlock(part(tool, { status: 'completed', output: JSON.stringify(result), metadata: {} }, input));
}

/** The visible text of rendered markup: tags removed until none remain, then the entities React escapes. */
function textOf(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

const LIST = {
  ok: true,
  tool: 'kortix_agents',
  action: 'list',
  card: {
    title: '3 agents',
    status: 'done',
    rows: [
      { title: 'Researcher', detail: 'Finds sources', badge: 'active', href: '/projects/p-1/customize/agents/researcher' },
      { title: 'Writer', detail: 'Drafts posts' },
      { title: 'Unsafe', href: 'javascript:alert(1)' },
    ],
    links: [{ label: 'Agents', href: '/projects/p-1/customize/agents' }],
  },
  data: { internal_marker: 'model-only-field' },
};

const DENIED = {
  ok: false,
  tool: 'kortix_people',
  action: 'invite',
  card: {
    title: 'Could not invite the person',
    subtitle: 'Sam, Alex can grant it.',
    status: 'denied',
    links: [{ label: 'Members', href: '/projects/p-1/members' }],
  },
  error: {
    kind: 'denied',
    message: 'Kortix refused this: it needs a permission the person does not have (members.invite).',
    grantors: [
      { name: 'Sam', role: 'admin' },
      { name: 'Alex', role: 'owner' },
    ],
  },
};

describe('KortixActionTool registration', () => {
  test('one renderer draws all nine platform tools', () => {
    expect(KORTIX_PLATFORM_TOOLS).toHaveLength(9);
    expect(KORTIX_PLATFORM_TOOLS).toContain('kortix_change_requests');
    for (const name of KORTIX_PLATFORM_TOOLS) expect(ToolRegistry.get(name)).toBe(KortixActionTool);
  });
});

describe('KortixActionTool — running', () => {
  test('says what it checks, from the tool and its action', () => {
    const html = render(<KortixActionTool call={toolCallBlock(part('kortix_agents', { status: 'running' }))} />, { running: true });
    expect(textOf(html)).toContain('Checking agents…');
    // No body yet: the row is not a disclosure.
    expect(html).not.toContain('aria-expanded');
  });

  test('a changing action says it updates', () => {
    const html = render(
      <KortixActionTool call={toolCallBlock(part('kortix_schedules', { status: 'running' }, { action: 'pause' }))} />,
      { running: true },
    );
    expect(textOf(html)).toContain('Updating schedules…');
  });

  test('change requests: reading checks them, a change updates one', () => {
    const read = render(<KortixActionTool call={toolCallBlock(part('kortix_change_requests', { status: 'running' }, { action: 'list' }))} />, {
      running: true,
    });
    expect(textOf(read)).toContain('Checking change requests…');
    const change = render(
      <KortixActionTool call={toolCallBlock(part('kortix_change_requests', { status: 'running' }, { action: 'merge' }))} />,
      { running: true },
    );
    expect(textOf(change)).toContain('Updating a change request…');
  });
});

describe('KortixActionTool — done', () => {
  test('a plain list stays one closed row with the headline and a done mark', () => {
    const html = render(<KortixActionTool call={done('kortix_agents', LIST)} />);
    const text = textOf(html);
    expect(text).toContain('3 agents');
    expect(text).toContain('Done');
    expect(html).toContain('aria-expanded="false"');
    expect(text).not.toContain('Researcher');
  });

  test('open, its rows link in-app, its badge shows, and nothing unsafe or model-only renders', () => {
    const html = render(<KortixActionTool call={done('kortix_agents', LIST)} defaultOpen />);
    const text = textOf(html);
    expect(html).toContain('href="/projects/p-1/customize/agents/researcher"');
    expect(text).toContain('Finds sources');
    expect(text).toContain('active');
    expect(text).toContain('Writer');
    // A row href that is not an in-app path is dropped; the row stays.
    expect(text).toContain('Unsafe');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="/projects/p-1/customize/agents"');
    // The raw result sits folded under "Show details": the label shows, the JSON does not.
    expect(text).toContain('Show details');
    expect(text).not.toContain('model-only-field');
  });

  test('changes read as before → after, a new setting as New, and the card opens itself', () => {
    const html = render(
      <KortixActionTool
        call={done(
          'kortix_agents',
          {
            ok: true,
            tool: 'kortix_agents',
            action: 'update',
            card: {
              title: 'Updated the Researcher agent',
              status: 'done',
              changes: [
                { field: 'Model', before: 'kortix/basic', after: 'kortix/power' },
                { field: 'Connector', before: null, after: 'Gmail' },
                { field: 'Secret', before: 'API key', after: null },
              ],
            },
          },
          { action: 'update' },
        )}
      />,
    );
    const text = textOf(html);
    expect(html).toContain('aria-expanded="true"');
    expect(text).toContain('Model');
    expect(text).toContain('kortix/basic');
    expect(text).toContain('kortix/power');
    expect(text).toContain('New');
    expect(text).toContain('Gmail');
    expect(text).toContain('Removed');
  });

  test('a sign-in link is the primary action and opens a new tab; in-app links stay in the app', () => {
    const html = render(
      <KortixActionTool
        call={done(
          'kortix_connectors',
          {
            ok: true,
            tool: 'kortix_connectors',
            action: 'connect',
            card: {
              title: 'Sign in to Gmail',
              subtitle: 'Open the link to connect it.',
              status: 'needs_you',
              links: [
                { label: 'Connectors', href: '/projects/p-1/admin/connectors' },
                { label: 'Sign in', href: 'https://auth.example.test/connect?state=abc' },
                { label: 'Plain http', href: 'http://auth.example.test/insecure' },
              ],
            },
          },
          { action: 'connect' },
        )}
      />,
    );
    const text = textOf(html);
    expect(text).toContain('Needs you');
    expect(html).toContain('aria-expanded="true"');
    // `&amp;`-free URL, so the attribute matches as written.
    expect(html).toMatch(/<a [^>]*href="https:\/\/auth\.example\.test\/connect\?state=abc"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    // The external link renders before the in-app one: it is the action.
    expect(html.indexOf('auth.example.test/connect')).toBeLessThan(html.indexOf('/projects/p-1/admin/connectors'));
    expect(html).not.toMatch(/href="\/projects\/p-1\/admin\/connectors"[^>]*target=/);
    expect(html).not.toContain('insecure');
  });
});

describe('KortixActionTool — denied', () => {
  test('a refusal says it needs a permission and lists who can grant it', () => {
    const html = render(<KortixActionTool call={done('kortix_people', DENIED, { action: 'invite' })} />);
    const text = textOf(html);
    expect(text).toContain('Could not invite the person');
    expect(text).toContain('Needs a permission');
    expect(text).toContain('Who can grant it');
    expect(text).toContain('Sam');
    expect(text).toContain('admin');
    expect(text).toContain('Alex');
    expect(html).toContain('href="/projects/p-1/members"');
    expect(html).toContain('aria-expanded="true"');
    // Open, the body names the grantors; the trigger does not repeat them.
    expect(text).not.toContain('Sam, Alex can grant it.');
    // The model's wording ("the person", the grant id) stays out of the card.
    expect(text).not.toContain('Kortix refused this');
  });

  test('without grantors it says who can grant it in the product wording', () => {
    const html = render(
      <KortixActionTool call={done('kortix_people', { ...DENIED, error: { kind: 'denied', message: 'refused' } }, { action: 'invite' })} />,
    );
    expect(textOf(html)).toContain('Anyone who manages this project can grant it.');
  });

  test('a call that threw its result still draws the card, not the generic error row', () => {
    const call = toolCallBlock(part('kortix_people', { status: 'error', error: JSON.stringify(DENIED), metadata: {} }, { action: 'invite' }));
    const html = render(<ToolPartRenderer call={call} />);
    const text = textOf(html);
    expect(text).toContain('Needs a permission');
    expect(text).toContain('Sam');
    expect(text).not.toContain('Kortix People');
  });
});

describe('KortixActionTool — failed', () => {
  test('a failure shows its message in the open card and an error mark', () => {
    const result = {
      ok: false,
      tool: 'kortix_agents',
      action: 'list',
      card: { title: 'Could not list the agents', subtitle: 'The command exited 1.', status: 'error' },
      error: { kind: 'failed', message: 'The command exited 1.' },
    };
    const closed = textOf(render(<KortixActionTool call={done('kortix_agents', result)} />));
    expect(closed).toContain('Could not list the agents');
    expect(closed).toContain('The command exited 1.');
    expect(closed).toContain("Didn't finish");
    const open = render(<KortixActionTool call={done('kortix_agents', result)} defaultOpen />);
    // Once, in the body: the trigger subtitle steps aside while open.
    expect(textOf(open).split('The command exited 1.').length - 1).toBe(1);
  });
});

describe('KortixActionTool — malformed output falls back to the generic card', () => {
  for (const [name, output] of [
    ['not JSON', 'kortix agents ls: 3 agents'],
    ['no card title', JSON.stringify({ ok: true, tool: 'kortix_agents', action: 'list', card: { status: 'done' } })],
    ['an unknown tool', JSON.stringify({ ok: true, tool: 'kortix_billing', action: 'list', card: { title: 'x', status: 'done' } })],
    ['an array', '[1, 2, 3]'],
  ] as const) {
    test(name, () => {
      const call = toolCallBlock(part('kortix_agents', { status: 'completed', output, metadata: {} }));
      const text = textOf(render(<KortixActionTool call={call} />));
      expect(text).toContain('Kortix Agents');
      expect(text).not.toContain('Checking agents');
    });
  }

  test('the panel surface draws the same card', () => {
    const text = textOf(render(<KortixActionTool call={done('kortix_agents', LIST)} />, { panel: true }));
    expect(text).toContain('3 agents');
  });
});

describe('parseKortixToolResult', () => {
  test('keeps in-app row paths and https links only', () => {
    const result = parseKortixToolResult(
      JSON.stringify({
        ok: true,
        tool: 'kortix_sessions',
        action: 'list',
        card: {
          title: '2 sessions',
          status: 'done',
          rows: [
            { title: 'A', href: '//evil.example.test/x' },
            { title: 'B', href: 'https://elsewhere.example.test' },
            { title: 'C', href: '/projects/p-1/sessions/s-1' },
          ],
          links: [
            { label: 'Open', href: '/projects/p-1/sessions' },
            { label: 'Out', href: 'https://example.test/a' },
            { label: 'Script', href: 'javascript:void(0)' },
            { label: '', href: '/projects/p-1' },
          ],
        },
      }),
    );
    expect(result?.card.rows.map((row) => row.href)).toEqual([undefined, undefined, '/projects/p-1/sessions/s-1']);
    expect(result?.card.links).toEqual([
      { label: 'Open', href: '/projects/p-1/sessions', external: false },
      { label: 'Out', href: 'https://example.test/a', external: true },
    ]);
  });

  test('a denied error is a denied card whatever status the card names', () => {
    const result = parseKortixToolResult(JSON.stringify({ ...DENIED, card: { ...DENIED.card, status: 'error' } }));
    expect(result?.card.status).toBe('denied');
    expect(result?.error?.grantors).toEqual([
      { name: 'Sam', role: 'admin' },
      { name: 'Alex', role: 'owner' },
    ]);
  });

  test('an unknown status falls back to ok: done, else error', () => {
    const base = { tool: 'kortix_usage', action: 'show', card: { title: 'Usage', status: 'weird' } };
    expect(parseKortixToolResult(JSON.stringify({ ...base, ok: true }))?.card.status).toBe('done');
    expect(parseKortixToolResult(JSON.stringify({ ...base, ok: false }))?.card.status).toBe('error');
  });

  test('null for anything that is not the result object', () => {
    for (const raw of [undefined, '', 'plain text', '{', 'null', '{"ok":true}', JSON.stringify({ ok: 'yes', tool: 'kortix_usage', card: { title: 'x' } })]) {
      expect(parseKortixToolResult(raw)).toBeNull();
    }
  });
});
