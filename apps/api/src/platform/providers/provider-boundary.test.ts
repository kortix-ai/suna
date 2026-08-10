import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_SRC = resolve(import.meta.dir, '../..');
const GENERIC_DATA_PATHS = [
  'sandbox-proxy/backend.ts',
  'sandbox-proxy/routes/preview.ts',
  'sandbox-proxy/routes/public-share.ts',
  'platform/sandbox-env.ts',
  'workspaces/lib/sandbox-daemon-ready.ts',
  'workspaces/lib/sandbox-env-sync.ts',
  'workspaces/opencode-mapping.ts',
  'workspaces/routes/shared.ts',
];

describe('sandbox provider architecture boundary', () => {
  test('proxy and runtime data paths contain no provider-specific branching or traffic headers', () => {
    for (const relativePath of GENERIC_DATA_PATHS) {
      const source = readFileSync(resolve(API_SRC, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(
        /(?:provider|providerName)\s*(?:===|!==|==|!=)\s*['"](?:daytona|platinum|e2b)['"]/i,
      );
      expect(source, relativePath).not.toMatch(
        /x-daytona-|x-access-token|e2b-traffic-access-token/i,
      );
    }
  });
});
