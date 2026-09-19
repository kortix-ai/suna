import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The dev server must accept the request headers a developer's browser sends.
 *
 * Cookies on `localhost` are shared by every port, and the auth cookie is named
 * per port (`sb-kortix-auth-token-<port>`), so each worktree a developer signs
 * in to adds ~3.3 KB to EVERY localhost request. Measured 2026-09-19: 9 ports,
 * 33 cookies, 32,016 bytes — against a 32,768-byte limit. A document request
 * still fit; a client-side navigation adds the `Next-Router-State-Tree` header,
 * went over, got `431`, and Next answered the failed fetch with a full page
 * reload on every sidebar click. The limit matches the self-host image's.
 */
const MIN_HEADER_BYTES = 131_072;

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { scripts: Record<string, string> };

describe('dev server request-header limit', () => {
  for (const script of ['dev', 'dev:staging-env']) {
    test(`\`${script}\` accepts at least ${MIN_HEADER_BYTES} bytes of headers`, () => {
      const match = pkg.scripts[script]?.match(/--max-http-header-size=(\d+)/);
      expect(match, `${script} sets no --max-http-header-size`).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThanOrEqual(MIN_HEADER_BYTES);
    });
  }
});
