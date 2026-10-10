import { describe, expect, test } from 'bun:test';

import { appNameKey, withDirectIds } from './connect-direct-twins';

describe('appNameKey', () => {
  test('one key per app across catalogues and "<App> MCP" toolkits', () => {
    expect(appNameKey('Linear')).toBe('linear');
    expect(appNameKey('Linear MCP')).toBe('linear');
    expect(appNameKey('Google Sheets')).toBe('googlesheets');
    expect(appNameKey('google-sheets')).toBe('googlesheets');
  });
});

describe('withDirectIds', () => {
  const ids = new Map([
    ['linear', 'mcp/linear'],
    ['stripe', 'mcp/stripe'],
  ]);

  test('marks every managed app that also has an API/MCP entry, in pages and sections', () => {
    const page = withDirectIds(
      {
        apps: [
          { slug: 'linear', name: 'Linear' },
          { slug: 'mural', name: 'Mural' },
        ],
      },
      ids,
    );
    expect(page).toEqual({
      apps: [
        { slug: 'linear', name: 'Linear', directId: 'mcp/linear' },
        { slug: 'mural', name: 'Mural', directId: null },
      ],
    });
    const sections = withDirectIds(
      {
        popular: [{ slug: 'stripe', name: 'Stripe' }],
        sections: [{ key: 'pm', items: [{ slug: 'linear_mcp', name: 'Linear MCP' }] }],
      },
      ids,
    ) as {
      popular: Array<{ directId: string }>;
      sections: Array<{ items: Array<{ directId: string }> }>;
    };
    expect(sections.popular[0]!.directId).toBe('mcp/stripe');
    expect(sections.sections[0]!.items[0]!.directId).toBe('mcp/linear');
  });

  test('leaves anything that is not a listing untouched', () => {
    expect(withDirectIds(null, ids)).toBeNull();
    expect(withDirectIds({ total: 3 }, ids)).toEqual({ total: 3 });
  });
});
