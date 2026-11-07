import { describe, expect, test } from 'bun:test';
import {
  inAppHref,
  isReadAction,
  KORTIX_PLATFORM_TOOLS,
  kortixCardTool,
  kortixPlatformTool,
  MULTI_AGENT_TOOLS,
  multiAgentTool,
  parseKortixToolResult,
} from './kortix-tool-card';

// Synthetic values only: every name, id and path below is invented.

const DENIED = {
  ok: false,
  tool: 'kortix_people',
  action: 'invite',
  card: {
    title: 'Could not invite the person',
    subtitle: 'Sam, Alex can grant it.',
    status: 'denied',
    links: [{ label: 'Members', href: '/workspaces/p-1/members' }],
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

describe('tool names', () => {
  test('every platform and multi-agent tool is a card tool, under any spelling; other tools are not', () => {
    expect(KORTIX_PLATFORM_TOOLS).toHaveLength(9);
    for (const name of KORTIX_PLATFORM_TOOLS) expect(kortixCardTool(name)).toBe(name);
    for (const name of MULTI_AGENT_TOOLS) expect(kortixCardTool(name)).toBe(name);
    expect(kortixPlatformTool('oc-kortix-agents')).toBe('kortix_agents');
    expect(multiAgentTool('send-message')).toBe('send_message');
    expect(multiAgentTool('kortix_agents')).toBeUndefined();
    expect(kortixCardTool('bash')).toBeUndefined();
  });

  test('inAppHref keeps one leading slash only; isReadAction knows the read verbs', () => {
    expect(inAppHref('/workspaces/p-1')).toBe('/workspaces/p-1');
    expect(inAppHref('//evil.example.test')).toBeUndefined();
    expect(inAppHref('https://example.test')).toBeUndefined();
    expect(isReadAction('list')).toBe(true);
    expect(isReadAction(undefined)).toBe(true);
    expect(isReadAction('invite')).toBe(false);
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
            { title: 'C', href: '/workspaces/p-1/sessions/s-1' },
          ],
          links: [
            { label: 'Open', href: '/workspaces/p-1/sessions' },
            { label: 'Out', href: 'https://example.test/a' },
            { label: 'Script', href: 'javascript:void(0)' },
            { label: '', href: '/workspaces/p-1' },
          ],
        },
      }),
    );
    expect(result?.card.rows.map((row) => row.href)).toEqual([undefined, undefined, '/workspaces/p-1/sessions/s-1']);
    expect(result?.card.links).toEqual([
      { label: 'Open', href: '/workspaces/p-1/sessions', external: false },
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

  test('a result without `tool` takes the call name', () => {
    const raw = JSON.stringify({ ok: true, card: { title: '2 agents', status: 'done' } });
    expect(parseKortixToolResult(raw)).toBeNull();
    expect(parseKortixToolResult(raw, 'list_agents')?.tool).toBe('list_agents');
  });

  test('null for anything that is not the result object', () => {
    for (const raw of [undefined, '', 'plain text', '{', 'null', '{"ok":true}', JSON.stringify({ ok: 'yes', tool: 'kortix_usage', card: { title: 'x' } })]) {
      expect(parseKortixToolResult(raw)).toBeNull();
    }
  });
});
