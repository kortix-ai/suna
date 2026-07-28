import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The logged-out homepage renders the REAL product surface — the same sidebar
 * chrome, session list, welcome body and composer as the signed-in shell. It is
 * a preview of the product, so a hand-rolled look-alike would drift and stop
 * being one.
 *
 * Mounting the real composer is safe because every hook it reaches for is
 * already gated: useOpenCodeProviders / useOpenCodeAgents / useOpenCodeCommands
 * / useOpenCodeConfig / useRuntimeSessions all key off `runtimeReady`, which is
 * false with no sandbox, and useProjectConfig keys off `!!projectId`. The two
 * that were NOT gated — ProjectSessionList and ProjectHomeWelcomeBody — now are,
 * and the tests below hold that line.
 *
 * What stays out is the project data ROOT: ProjectShell and AppProviders mount
 * session-assuming providers with no query guard of their own.
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
    'ProjectSessionList',
    'ComposerChatInput',
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
  // The data ROOTS, which fetch with no guard of their own. The leaf hooks are
  // all self-gating, which is why the real composer and session list are fine.
  const BANNED = [
    'ProjectShell',
    'AppProviders',
    'BillingAccountProvider',
    'useGatewayCatalogSync',
    'useCustomizeStore',
  ];

  for (const symbol of BANNED) {
    test(`does not reference ${symbol}`, () => {
      expect(SHELL_CODE).not.toContain(symbol);
    });
  }

  test('does not fetch on its own — every query belongs to a shared component', () => {
    expect(SHELL_CODE).not.toContain("from '@kortix/sdk'");
    expect(SHELL_CODE).not.toContain('useQuery');
  });
});

describe('shared components are safe to render with no project', () => {
  const SESSION_LIST = readFileSync(
    join(HERE, '..', 'workspace', 'project-sidebar', 'project-session-list.tsx'),
    'utf8',
  );

  test('the welcome body does not fetch project detail without a project id', () => {
    expect(PROJECT_HOME).toContain('enabled: !!projectId');
  });

  test('the setup pills render with no project, pointing at sign-in', () => {
    // They used to be suppressed without a project, which left the logged-out
    // home visibly missing a whole row the signed-in home has — one of the
    // tells that the two were different apps. They render now; the caller
    // supplies where each pill points.
    expect(SHELL_CODE).toContain('tileHrefFor');
    expect(PROJECT_HOME).not.toContain('setupTiles && projectId');
  });

  test('a pill cannot link into a project that does not exist', () => {
    // With no projectId and no override, resolveLegacyCustomizeHref would
    // build "/projects//…". The null guard is what stops that.
    expect(PROJECT_HOME).toContain(': projectId');
  });

  test('the session list does not fetch sessions without a project id', () => {
    // Unguarded, this called listProjectSessions('') on every anonymous visit.
    expect(SESSION_LIST).toContain('enabled: !!projectId');
  });
});

describe('the showcase belongs to the new-session state, not the index', () => {
  const INSTANT_SHELL = readFileSync(
    join(HERE, '..', 'session', 'instant-session-shell.tsx'),
    'utf8',
  );

  test('the index does not render the showcase', () => {
    // Signed in or out, the index keeps its heading. The animated capability
    // showcase is the EMPTY state of a brand-new session.
    expect(SHELL_CODE).not.toContain('DelegateShowcase');
    expect(SHELL_CODE).toContain('heading=');
  });

  test('a brand-new session does render it', () => {
    expect(INSTANT_SHELL).toContain('<DelegateShowcase');
  });

  test('the project index passes no showcase', () => {
    expect(PROJECT_HOME).toContain('showcase ??');
  });
});

describe('the logged-out shell gates every action', () => {
  test('routes actions through the sign-in gate', () => {
    expect(SHELL_CODE).toContain('useSignInGate');
    expect(SHELL_CODE).toContain('gateWithPrompt');
  });

  test('delegates the session list rather than inventing ghost rows', () => {
    // The empty state is the real component's own, not a copy living here.
    expect(SHELL_CODE).toContain('<ProjectSessionList projectId=""');
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
