/**
 * The API keys pane: the two things about it that can be wrong silently.
 *
 * 1. The meta line under each key — pure string assembly, so it is testable
 *    without a DOM (`apps/web` has no render harness for this pane).
 * 2. That the pane asks for the caller's OWN keys. `listAccountTokens(id)`
 *    without `{ mine: true }` returns every key the ACCOUNT owns — other
 *    members' keys, service-account bearers, and one row per sandbox session
 *    ever run. Dropping that argument would not fail a typecheck, would not
 *    fail a render, and would show a person a list of their colleagues'
 *    credentials. There is no assertion available for it other than reading
 *    the source, so this reads the source.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ApiKeyRow } from '@/components/iam/api-key-rows';
import { apiKeyMetaParts } from './tokens-tab';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const row = (overrides: Partial<ApiKeyRow> = {}): ApiKeyRow => ({
  id: 't1',
  kind: 'personal',
  name: 'my laptop',
  hint: 'pk_abcdef0123456789',
  status: 'active',
  createdAt: new Date(NOW - 30 * DAY).toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  scopeLabel: null,
  ...overrides,
});

describe('apiKeyMetaParts', () => {
  test('a plain key says what it looks like, that it is unused, and that it never expires', () => {
    expect(apiKeyMetaParts(row(), NOW)).toEqual([
      'pk_abcdef0123456789',
      'Never used',
      'Never expires',
    ]);
  });

  test('a project-scoped key names the project it is limited to, right after the hint', () => {
    const parts = apiKeyMetaParts(row({ scopeLabel: 'Acme web' }), NOW);
    expect(parts[1]).toBe('Acme web');
  });

  test('an expiry in the future reads "Expires", one in the past reads "Expired"', () => {
    const future = apiKeyMetaParts(
      row({ expiresAt: new Date(NOW + 7 * DAY).toISOString() }),
      NOW,
    );
    expect(future.at(-1)).toStartWith('Expires ');

    const past = apiKeyMetaParts(
      row({ status: 'expired', expiresAt: new Date(NOW - 7 * DAY).toISOString() }),
      NOW,
    );
    expect(past.at(-1)).toStartWith('Expired ');
  });

  test('an unparseable expiry is dropped rather than rendered as a lie', () => {
    // `Never expires` is NOT the fallback either — we do not know that.
    const parts = apiKeyMetaParts(row({ expiresAt: 'not-a-date' }), NOW);
    expect(parts).toEqual(['pk_abcdef0123456789', 'Never used']);
  });

  test('a used key reports when, relatively', () => {
    const parts = apiKeyMetaParts(
      row({ lastUsedAt: new Date(NOW - 2 * DAY).toISOString() }),
      NOW,
    );
    expect(parts[1]).toStartWith('Last used ');
  });
});

describe('the pane reads only the caller’s own keys', () => {
  const source = readFileSync(join(import.meta.dir, 'tokens-tab.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('listAccountTokens is called with { mine: true }', () => {
    expect(source).toContain('listAccountTokens(accountId, { mine: true })');
  });

  test('no unnarrowed listAccountTokens call survives anywhere in the pane', () => {
    const calls = [...source.matchAll(/listAccountTokens\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args).toContain('mine: true');
    }
  });

  test('the pane never reaches for the service-account API — that list is the account’s', () => {
    expect(source).not.toContain('listServiceAccountsApi');
    expect(source).not.toContain('createServiceAccountApi');
  });
});
