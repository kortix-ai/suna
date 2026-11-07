/**
 * Authentication runs before request validation on the git-proxy GET routes
 * that carry a query schema. Before: an anonymous request with a missing or
 * malformed query got `400 Validation failed` (leaking parameter names and
 * types) instead of `401`, so the 401/400 boundary could not tell
 * "needs auth" from "bad request".
 */
import { describe, expect, test } from 'bun:test';

const { gitProxyApp } = await import('./index');

const PROJECT_ID = 'b06a70f1-be0a-4fd0-b052-26fffb92713f';
const SHA = 'a'.repeat(40);

const ROUTES = [
  `/${PROJECT_ID}/fast-boot-bundle`,
  `/${PROJECT_ID}/fast-boot-bundle?ref=main&tip=${SHA}&parent=${SHA}`,
  `/${PROJECT_ID}/project-snapshot`,
  `/${PROJECT_ID}/project-snapshot?sha=${SHA}`,
  `/${PROJECT_ID}/info/refs?service=bogus`,
  `/${PROJECT_ID}/info/refs?service=git-upload-pack`,
];

describe('git-proxy: auth before validation', () => {
  for (const path of ROUTES) {
    test(`anonymous GET ${path.split('?')[0].slice(PROJECT_ID.length + 1)}${path.includes('?') ? ` (${path.split('?')[1].slice(0, 20)})` : ' (no query)'} -> 401`, async () => {
      const res = await gitProxyApp.request(path);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Basic');
      expect(await res.text()).not.toContain('Validation');
    });
  }
});
