/**
 * `authProviderBaseViews` — the two-door projection the `GET /auth-providers`
 * route serves to the web picker and CLI (spec §8.3/§9.1). Asserts the shape
 * contract the web/CLI agents consume: both doors present, per-provider flows,
 * the Anthropic one-click gate OFF, and no server-only OAuth config leaked.
 *
 * Imports the real route module (which registers on the app singleton as a
 * side effect and transitively loads config/db) — runs under the sanctioned
 * `dotenvx run -- bun test` runner (`scripts/test.sh`), same as every other
 * route-adjacent unit test in this package.
 */
import { describe, expect, test } from 'bun:test';

import { authProviderBaseViews } from './auth-providers';

describe('authProviderBaseViews (GET /auth-providers projection)', () => {
  const views = authProviderBaseViews();
  const find = (id: string, door: 'account' | 'api-key') =>
    views.find((v) => v.id === id && v.door === door);

  test('exposes BOTH doors — an account door and an api-key door', () => {
    expect(views.some((v) => v.door === 'account')).toBe(true);
    expect(views.some((v) => v.door === 'api-key')).toBe(true);
  });

  test('Anthropic appears in both doors (Claude Code account + API key)', () => {
    expect(find('anthropic', 'account')?.label).toBe('Claude Code');
    expect(find('anthropic', 'api-key')?.label).toBe('Anthropic');
  });

  test('OpenAI appears in both doors (Codex account + API key)', () => {
    expect(find('openai', 'account')?.label).toBe('ChatGPT / Codex');
    expect(find('openai', 'api-key')?.label).toBe('OpenAI');
  });

  test('the Anthropic account door is gated (browser-oauth one-click stays OFF)', () => {
    expect(find('anthropic', 'account')?.gated).toBe(true);
    // Its sanctioned web flow is paste-token, not browser-oauth.
    expect(find('anthropic', 'account')?.flows.web).toEqual(['paste-token']);
  });

  test('the Codex account door is device-code on web and not gated', () => {
    const codex = find('openai', 'account');
    expect(codex?.gated).toBe(false);
    expect(codex?.flows.web).toEqual(['device-code']);
    expect(codex?.refresh).toBe('refresh-token');
  });

  test('every view carries a producesAuthKind and its compatible harnesses', () => {
    for (const view of views) {
      expect(typeof view.producesAuthKind).toBe('string');
      expect(Array.isArray(view.compatibleHarnesses)).toBe(true);
    }
    // Codex's kind lights up at least one harness.
    expect(find('openai', 'account')?.compatibleHarnesses.length).toBeGreaterThan(0);
  });

  test('the projection never leaks server-only OAuth client config', () => {
    for (const view of views) {
      expect(view).not.toHaveProperty('oauth');
      expect(view).not.toHaveProperty('clientId');
      expect(view).not.toHaveProperty('tokenUrl');
    }
  });
});
