import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConnectedAccountsTabView } from './connected-tab';

const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

describe('ConnectedAccountsTabView', () => {
  test('renders one row per provider, in order', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect(headings(out)).toEqual(['GitHub', 'ChatGPT', 'Claude Code']);
  });

  test('every row states which scope it writes to', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect(out).toMatch(/for this account/i);
    expect(out).toMatch(/for this workspace/i);
  });

  test('the GitHub row is absent without account.write', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount={false} />);
    expect(headings(out)).toEqual(['ChatGPT', 'Claude Code']);
  });

  test('each row carries exactly one action button', () => {
    const out = renderToStaticMarkup(<ConnectedAccountsTabView canManageAccount />);
    expect([...out.matchAll(/<button/g)]).toHaveLength(3);
  });
});
