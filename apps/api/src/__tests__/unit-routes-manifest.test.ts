/**
 * `tests/spec/routes.generated.json` is the manifest the REST-flow coverage gate
 * (tests/src/coverage/check-coverage.ts) trusts. Nothing regenerated it, so a new
 * route could be missing from it and the gate still passed. This test runs the
 * real generator (scripts/dump-routes.ts, with the cloud profile its header
 * documents) and fails when the committed file differs from the live route table.
 * Fix a failure with the command in the header of scripts/dump-routes.ts.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Manifest = { count: number; routes: Array<{ method: string; path: string }> };

test('the committed route manifest equals the live route table', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'routes-manifest-')), 'routes.json');
  const apiDir = new URL('../../', import.meta.url).pathname;
  const run = Bun.spawnSync(['bun', 'scripts/dump-routes.ts', out], {
    cwd: apiDir,
    env: {
      ...process.env,
      SUPABASE_URL: 'https://placeholder.supabase.co',
      INTERNAL_KORTIX_ENV: 'dev',
      KORTIX_BILLING_INTERNAL_ENABLED: 'true',
      // Billing enabled makes KORTIX_URL a hard requirement (src/config.ts:
      // "Required when KORTIX_BILLING_INTERNAL_ENABLED=true"). The hermetic
      // suite strips every ambient KORTIX_* var, so without this placeholder
      // the generator exits 1 before it ever reads a route table. It is
      // validation-only and does not change the dumped route table.
      KORTIX_URL: 'https://placeholder.kortix.com',
      LLM_GATEWAY_ENABLED: 'true',
      FRONTEND_URL: 'https://placeholder.kortix.com',
      KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT: 'https://placeholder.storage.example',
    },
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);

  const live = JSON.parse(readFileSync(out, 'utf8')) as Manifest;
  const committed = JSON.parse(
    readFileSync(new URL('../../../../tests/spec/routes.generated.json', import.meta.url), 'utf8'),
  ) as Manifest;
  const keys = (m: Manifest) => m.routes.map((r) => `${r.method} ${r.path}`);

  expect(committed.count).toBe(committed.routes.length);
  expect(keys(committed)).toEqual(keys(live));
}, 120_000);
