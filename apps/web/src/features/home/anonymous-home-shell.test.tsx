import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two things must stay true about the logged-out homepage.
 *
 * 1. It renders the SAME shell as the signed-in one. It is a preview of the
 *    product, so a hand-rolled look-alike would drift and stop being one.
 * 2. It does not pull in the authenticated data tree. ProjectShell is a project
 *    data root and the real composer reaches for the sandbox runtime client
 *    when no project is present — either one is a 401 on every anonymous visit.
 *
 * Source-level, because both failures are imports rather than renders.
 */

const HERE = import.meta.dir;
const SHELL = readFileSync(join(HERE, 'anonymous-home-shell.tsx'), 'utf8');
const PROJECT_HOME = readFileSync(
  join(HERE, '..', 'workspace', 'project-layout', 'project-home.tsx'),
  'utf8',
);

/**
 * Only the code. The doc comment names the very symbols being banned — in
 * order to explain why — so a whole-file grep would flag its own rationale.
 */
const SHELL_CODE = SHELL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the logged-out shell reuses the real one', () => {
  const SHARED = [
    'SidebarProvider',
    'SidebarInset',
    'SidebarShell',
    'SidebarBrandHeader',
    'SidebarBody',
    'SidebarNewButton',
    'SidebarFooterSlot',
    'SidebarSectionLabel',
    'SidebarPlainLink',
    'ProjectNavGroup',
    'ProjectHomeWelcomeBody',
  ];

  for (const symbol of SHARED) {
    test(`renders through the shared ${symbol}`, () => {
      expect(SHELL_CODE).toContain(symbol);
    });
  }

  test('takes the nav items from the same source as the sidebar', () => {
    expect(SHELL_CODE).toContain('PROJECT_NAV_ITEMS');
  });
});

describe('the logged-out shell stays out of the authenticated tree', () => {
  const BANNED = [
    'ComposerChatInput',
    'SessionChatInput',
    'ProjectShell',
    'AppProviders',
    'BillingAccountProvider',
    'useRuntimeSessions',
    'useRuntimeProviders',
    'useOpenCodeProviders',
    'useOpenCodeAgents',
    'useGatewayCatalogSync',
    'useCustomizeStore',
    'ProjectSessionList',
  ];

  for (const symbol of BANNED) {
    test(`does not reference ${symbol}`, () => {
      expect(SHELL_CODE).not.toContain(symbol);
    });
  }

  test('does not call the SDK or fetch directly', () => {
    expect(SHELL_CODE).not.toContain("from '@kortix/sdk'");
    expect(SHELL_CODE).not.toContain("from '@kortix/sdk/react'");
    expect(SHELL_CODE).not.toContain('useQuery');
  });
});

describe('the shared welcome body is safe to render with no project', () => {
  test('its project-detail query is disabled without a project id', () => {
    // ProjectHomeWelcomeBody is shared with the anonymous homepage, which has
    // no project. An unguarded query there 401s on every visit.
    expect(PROJECT_HOME).toContain('enabled: !!projectId');
  });

  test('the setup pills are suppressed when there is no project to set up', () => {
    expect(PROJECT_HOME).toContain('setupTiles && projectId');
  });
});

describe('the logged-out shell gates every action', () => {
  test('routes actions through the sign-in gate', () => {
    expect(SHELL_CODE).toContain('useSignInGate');
    expect(SHELL_CODE).toContain('gateWithPrompt');
  });

  test('shows an honest empty session list rather than ghost rows', () => {
    expect(SHELL).toContain('No sessions yet');
  });

  test('keeps the marketing pages reachable from the product shell', () => {
    for (const href of ['/pricing', '/enterprise', '/docs', '/why']) {
      expect(SHELL).toContain(href);
    }
  });
});

describe('the / route never traps the user on a login wall', () => {
  const PAGE = readFileSync(join(HERE, '..', '..', 'app', '(app)', 'page.tsx'), 'utf8');

  test('does not redirect to /auth', () => {
    expect(PAGE).not.toContain("redirect('/auth')");
    expect(PAGE).not.toContain('redirect("/auth")');
  });

  test('falls back to the project list on any failure', () => {
    expect(PAGE).toContain('/projects');
  });
});
