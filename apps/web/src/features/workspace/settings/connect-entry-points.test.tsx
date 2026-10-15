import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConnectedApps } from './tabs/connected-apps';

/**
 * KRTX-1997: "Connect MCP" was reachable only from a dismissible sidebar promo.
 * The Connected apps section (Settings → Personal access keys) lists the MCP
 * clients a person approved, so it carries the permanent way to add one.
 */
describe('ConnectedApps — Connect MCP entry point', () => {
  test('the section header offers Connect MCP before the grants load', () => {
    const out = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ConnectedApps relativeTime={(iso) => iso} />
      </QueryClientProvider>,
    );
    // The English copy, or its bare key: in a batch run a sibling test file's
    // global `mock.module` swaps `useTranslations` for one that returns keys.
    const button = out.match(/<button[^>]*>([\s\S]*?)<\/button>/);
    expect(button?.[1]).toMatch(/Connect MCP|connectMcp/);
    // The button sits after the section heading, not inside the list.
    expect(out.indexOf('<h2')).toBeLessThan(out.indexOf('<button'));
  });
});

describe('SettingsConnectRows — the settings rail footer', () => {
  test('offers Connect MCP with no project open, and no computer row', async () => {
    const { SettingsConnectRows } = await import('./settings-connect-rows');
    const out = renderToStaticMarkup(<SettingsConnectRows />);
    const buttons = [...out.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatch(/Connect MCP|workspace\.connectMcp/);
    // Not a dismissible promo: nothing on the row hides it.
    expect(out).not.toMatch(/dismiss/i);
  });
});
