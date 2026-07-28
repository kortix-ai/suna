import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The anonymous homepage must not pull in the authenticated tree.
 *
 * ProjectShell is a project data root (getProjectDetail, useGatewayCatalogSync,
 * BillingAccountProvider) and ComposerChatInput reaches for
 * useRuntimeSessions / useOpenCodeProviders, which fall back to the sandbox
 * runtime client when no project is present. Either one, mounted for an
 * anonymous visitor, is a 401 on every marketing visit.
 *
 * This is a source-level guard because the failure is an import, not a render.
 */

const HERE = import.meta.dir;
const SHELL = readFileSync(join(HERE, 'anonymous-home-shell.tsx'), 'utf8');

/**
 * Only the code. The doc comment names the very symbols being banned — in
 * order to explain why they are banned — so a whole-file grep would flag its
 * own rationale.
 */
const SHELL_CODE = SHELL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BANNED_IMPORTS = [
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
  'getProjectDetail',
  'useCustomizeStore',
];

describe('anonymous home shell stays out of the authenticated tree', () => {
  for (const symbol of BANNED_IMPORTS) {
    test(`does not reference ${symbol}`, () => {
      expect(SHELL_CODE).not.toContain(symbol);
    });
  }

  test('does not call the SDK at all', () => {
    expect(SHELL_CODE).not.toContain("from '@kortix/sdk'");
    expect(SHELL_CODE).not.toContain("from '@kortix/sdk/react'");
  });

  test('does not fetch', () => {
    expect(SHELL_CODE).not.toContain('useQuery');
    expect(SHELL_CODE).not.toContain('fetch(');
  });
});

describe('anonymous home shell gates every action', () => {
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
    // A backend blip must render the shell, not bounce to sign-in.
    expect(PAGE).not.toContain("redirect('/auth')");
    expect(PAGE).not.toContain('redirect("/auth")');
  });

  test('falls back to the project list on any failure', () => {
    expect(PAGE).toContain('/projects');
  });
});
