import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// KRTX-2775: the prod release must wire the internal edge gate end to end from
// the env blob — the Worker secret synced from KORTIX_INTERNAL_EDGE_KEY and the
// public origin verified keyless — and roll the gateway before the API, because
// the API's edge check 404s calls that lack the header the moment its env
// carries the key.
const workflowPath = '../../.github/workflows/deploy-prod.yml';

describe('Deploy Prod internal edge gate', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, workflowPath), 'utf8');

  it('reads the edge key from the prod env blob, optionally', () => {
    expect(workflow).toContain('INTERNAL_EDGE_KEY=kortix-prod-env:KORTIX_INTERNAL_EDGE_KEY?');
  });

  it('syncs the Worker secret and verifies the public origin after the Worker deploy', () => {
    const deploy = workflow.indexOf('wrangler@4 deploy --env prod');
    const sync = workflow.indexOf('node infra/scripts/sync-worker-edge-key.mjs');
    expect(deploy).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(deploy);
  });

  it('reads the prod blob through the prod role — the default role cannot read kortix-prod*', () => {
    const job = workflow.slice(
      workflow.indexOf('  deploy-api-router:'),
      workflow.indexOf('node infra/scripts/sync-worker-edge-key.mjs'),
    );
    expect(job).toContain(
      'role-to-assume: arn:aws:iam::935064898258:role/kortix-gha-ecs-deploy-prod',
    );
  });

  it('rolls the gateway before the API so the edge key engages without a breakage window', () => {
    const gateway = workflow.indexOf(
      'ecs-deploy.sh prod "kortix/kortix-gateway:${VERSION}" --service gateway',
    );
    const api = workflow.indexOf('ecs-deploy.sh prod "kortix/kortix-api:${VERSION}" --version');
    expect(gateway).toBeGreaterThan(-1);
    expect(api).toBeGreaterThan(gateway);
  });
});
