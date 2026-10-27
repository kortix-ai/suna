import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import { Modal } from '@kortix/ui/modal';
import { CLIENTS, mcpUrl } from '@kortix/ui/internal/layout/connect-mcp-modal';
import { getEnv } from '@/lib/env-config';

import { DEFAULT_SETTINGS_RAIL_CHROME_COPY } from '@kortix/ui/customize/settings/rail-copy-context';
import { railGroups } from '@kortix/ui/customize/settings/rail';
import { isSettingsTabAllowed, SettingsPanelShell } from './settings-panel-body';
import { parseSettingsTab } from '@kortix/ui/customize/settings/settings-tabs';
import { McpTab } from './tabs/mcp-tab';

/**
 * KRTX-1997: "Connect MCP" and "Connect your computer" were dialogs reachable
 * only from dismissible sidebar promos. They are settings tabs now —
 * `/settings/mcp` and `/settings/computer` — drawn at the foot of the rail.
 */

const groups = railGroups();
const allItems = groups.flatMap((group) => group.items);

/** A tab no row carries: no pane mounts (see `settings-panel.test.tsx`). */
const NO_TAB = 'no-active-tab' as never;

function renderShell(tab: 'mcp' | typeof NO_TAB) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Modal open onOpenChange={() => {}}>
        <SettingsPanelShell
          tab={tab}
          onTabChange={() => {}}
          isMobile={false}
          projectId={undefined}
          accountId={undefined}
          groups={groups}
          allItems={allItems}
          chrome={DEFAULT_SETTINGS_RAIL_CHROME_COPY}
        />
      </Modal>
    </QueryClientProvider>,
  );
}

describe('Settings › Connect tabs', () => {
  test('both are routable settings tabs', () => {
    expect(parseSettingsTab('mcp')).toBe('mcp');
    expect(parseSettingsTab('computer')).toBe('computer');
  });

  test('MCP renders without a project; Computer needs one', () => {
    expect(isSettingsTabAllowed('mcp', { hasProject: false })).toBe(true);
    expect(isSettingsTabAllowed('computer', { hasProject: false })).toBe(false);
    expect(isSettingsTabAllowed('computer', { hasProject: true })).toBe(true);
  });

  test('the rail ends with the Connect block, after every Personal row', () => {
    const html = renderShell(NO_TAB);
    const tabs = [...html.matchAll(/role="tab"[^>]*id="[^"]*-trigger-([a-z-]+)"/g)].map((m) => m[1]);
    expect(tabs.slice(-2)).toEqual(['mcp', 'computer']);
  });

  test('selecting MCP opens its page in the dialog, not a modal', () => {
    const html = renderShell('mcp');
    const url = mcpUrl(getEnv().BACKEND_URL);
    // The URL and one row per client render inline in the tab panel.
    const panel = html.slice(html.indexOf('role="tabpanel"'));
    expect(panel).toContain(url);
    expect((panel.match(/bg-muted flex size-9/g) ?? []).length).toBe(CLIENTS.length);
  });

  test('the MCP page renders on its own with a copy action for the URL', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <McpTab />
      </QueryClientProvider>,
    );
    expect(html).toContain(mcpUrl(getEnv().BACKEND_URL));
    expect(html).toMatch(/Copy URL|copyUrl/);
  });
});
