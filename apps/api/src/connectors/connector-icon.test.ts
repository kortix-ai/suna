import { describe, expect, test } from 'bun:test';

import {
  composioToolkitKey,
  fallbackIconSource,
  iconForHost,
  iconForName,
  resolveFallbackIcons,
} from './connector-icon';

const ICONS = new Map([
  ['resend.com', 'https://icons.example.test/resend.png'],
  ['linear.app', 'https://icons.example.test/linear.png'],
]);
const NAMES = new Map([['todoist', 'https://icons.example.test/todoist.png']]);
const CATALOG = { byDomain: ICONS, byName: NAMES };

describe('fallbackIconSource', () => {
  test('a composio connector resolves by its toolkit', () => {
    expect(fallbackIconSource('composio', { app: 'GitHub' })).toEqual({
      kind: 'composio',
      app: 'GitHub',
    });
  });

  test('an mcp, graphql, http or openapi connector carries the host it calls', () => {
    expect(fallbackIconSource('mcp', { url: 'https://mcp.resend.com/mcp?x=1' })).toEqual({
      kind: 'catalog',
      host: 'mcp.resend.com',
    });
    expect(
      fallbackIconSource('graphql', {
        endpoint: 'https://api.linear.app/graphql',
      }),
    ).toEqual({
      kind: 'catalog',
      host: 'api.linear.app',
    });
    expect(fallbackIconSource('http', { baseUrl: 'https://api.resend.com' })).toEqual({
      kind: 'catalog',
      host: 'api.resend.com',
    });
    expect(fallbackIconSource('openapi', { server: 'https://api.resend.com/v1' })).toEqual({
      kind: 'catalog',
      host: 'api.resend.com',
    });
  });

  test('a catalogue provider with no parsable URL still resolves, by name only', () => {
    const byName = { kind: 'catalog', host: null } as const;
    expect(fallbackIconSource('mcp', { url: 'not a url' })).toEqual(byName);
    expect(fallbackIconSource('openapi', { server: null })).toEqual(byName);
    expect(fallbackIconSource('postman', { spec: 'https://api.resend.com/c.json' })).toEqual(
      byName,
    );
    expect(fallbackIconSource('mcp', null)).toEqual(byName);
  });

  test('a composio connector with no app, a channel and a computer have no source', () => {
    expect(fallbackIconSource('composio', {})).toBeNull();
    expect(fallbackIconSource('channel', { baseUrl: 'https://slack.com/api' })).toBeNull();
    expect(fallbackIconSource('computer', {})).toBeNull();
  });
});

describe('iconForHost', () => {
  test('matches the host itself and any parent domain', () => {
    expect(iconForHost('resend.com', ICONS)).toBe('https://icons.example.test/resend.png');
    expect(iconForHost('MCP.Resend.com', ICONS)).toBe('https://icons.example.test/resend.png');
    expect(iconForHost('a.b.linear.app', ICONS)).toBe('https://icons.example.test/linear.png');
  });

  test('does not match a different domain that only shares a suffix', () => {
    expect(iconForHost('notresend.com', ICONS)).toBeNull();
    expect(iconForHost('localhost', ICONS)).toBeNull();
    expect(iconForHost('com', new Map([['com', 'x']]))).toBeNull();
  });
});

describe('composioToolkitKey', () => {
  test('turns a connector name into a toolkit slug', () => {
    expect(composioToolkitKey('Figma 2')).toBe('figma');
    expect(composioToolkitKey('Google Calendar')).toBe('google_calendar');
  });
});

describe('composio logo first', () => {
  test('an MCP connector takes the managed grid logo when Composio has the app', async () => {
    const icons = await resolveFallbackIcons(
      [
        {
          slug: 'figma',
          name: 'Figma',
          provider: 'mcp',
          config: { url: 'https://mcp.figma.test/mcp' },
        },
      ],
      {
        composioLogo: async (app) =>
          app === 'figma' ? 'https://logos.example.test/figma.svg' : null,
        catalogIcons: async () => CATALOG,
      },
    );
    expect(icons.get('figma')).toBe('https://logos.example.test/figma.svg');
  });
});

describe('iconForName', () => {
  test('matches the app name, ignoring case and a trailing number', () => {
    expect(iconForName('Todoist', NAMES)).toBe('https://icons.example.test/todoist.png');
    expect(iconForName(' todoist 2 ', NAMES)).toBe('https://icons.example.test/todoist.png');
  });

  test('does not match a longer or different name', () => {
    expect(iconForName('Todoist Sync', NAMES)).toBeNull();
    expect(iconForName('Tod', NAMES)).toBeNull();
  });
});

describe('resolveFallbackIcons', () => {
  const rows = [
    {
      slug: 'github',
      name: 'GitHub',
      provider: 'composio',
      config: { app: 'github' },
    },
    {
      slug: 'resend',
      name: 'Mail',
      provider: 'mcp',
      config: { url: 'https://mcp.resend.com/mcp' },
    },
    {
      slug: 'todoist',
      name: 'Todoist',
      provider: 'mcp',
      config: { url: 'https://ai.todoist.test/mcp' },
    },
    {
      slug: 'private',
      name: 'Internal',
      provider: 'mcp',
      config: { url: 'https://mcp.internal.test/mcp' },
    },
    {
      slug: 'stored',
      name: 'Stored',
      provider: 'mcp',
      config: { url: 'https://mcp.resend.com', icon_url: 'https://s/i.png' },
    },
  ];

  test('fills every connector without a stored icon from its source', async () => {
    const icons = await resolveFallbackIcons(rows, {
      composioLogo: async (app) =>
        app === 'github' ? `https://logos.example.test/${app}.svg` : null,
      catalogIcons: async () => CATALOG,
    });
    expect(Object.fromEntries(icons)).toEqual({
      github: 'https://logos.example.test/github.svg',
      resend: 'https://icons.example.test/resend.png',
      todoist: 'https://icons.example.test/todoist.png',
    });
  });

  test('a failing or slow source yields no icon and never rejects', async () => {
    const icons = await resolveFallbackIcons(rows, {
      composioLogo: async () => {
        throw new Error('provider down');
      },
      catalogIcons: () => new Promise(() => {}),
      capMs: 10,
    });
    expect(icons.size).toBe(0);
  });

  test('calls no source when no connector needs one', async () => {
    let calls = 0;
    const icons = await resolveFallbackIcons([rows[4]!], {
      composioLogo: async () => (calls++, null),
      catalogIcons: async () => (calls++, CATALOG),
    });
    expect(icons.size).toBe(0);
    expect(calls).toBe(0);
  });
});
