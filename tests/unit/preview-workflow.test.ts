import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/deploy-preview.yml'),
  'utf8',
);

describe('preview workflow after EKS decommission', () => {
  it('does not claim that the removed Argo and Kubernetes runtime will deploy images', () => {
    expect(workflow).not.toContain('docker/build-push-action');
    expect(workflow).not.toContain('Argo CD deploys it');
    expect(workflow).not.toContain('still rolling out');
    expect(workflow).not.toContain('BACKEND="https://pr-${NUM}.preview-api.kortix.com/v1"');
  });

  it('fails labeled preview requests with the decommissioned dependency named', () => {
    expect(workflow).toContain('name: Preview backend unavailable');
    expect(workflow).toContain('EKS was decommissioned');
    expect(workflow).toContain('exit 1');
  });

  it('removes stale Vercel branch overrides on rollout attempts and teardown', () => {
    expect(workflow.match(/Delete branch-scoped backend URL env vars/g)).toHaveLength(1);
    expect(workflow).toContain('name: Remove stale Vercel backend overrides');
    expect(workflow.match(/-X DELETE/g)).toHaveLength(2);
    expect(workflow).toContain('gitBranch==$b');
  });
});
