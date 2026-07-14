import { describe, expect, test } from 'bun:test';

import { parseCustomerRepositories, verifyAndMirrorImages } from '../artifacts.ts';
import type { CommandRunner, RunOptions } from '../process.ts';
import { parseEnterpriseReleaseManifest } from '../release-contract.ts';

const HASH = 'a'.repeat(64);
const DIGEST = `sha256:${HASH}`;

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options?: RunOptions }> = [];

  run(command: string, args: string[], options?: RunOptions): string {
    this.calls.push({ command, args, options });
    if (command === 'aws') return 'secret-password\n';
    if (command === 'crane' && args[0] === 'digest') {
      if (args[1]?.includes(':0.9.84-e1')) return DIGEST;
      throw new Error('not found');
    }
    return '';
  }
}

function manifest() {
  return parseEnterpriseReleaseManifest({
    schema_version: 1,
    version: '0.9.84-e1',
    channel: 'stable',
    published_at: '2026-07-13T12:00:00Z',
    prod: { version: '0.9.84', source_sha: 'b'.repeat(40) },
    enterprise: { source_sha: 'c'.repeat(40) },
    compatibility: { architectures: ['amd64'], kubernetes_minor: ['1.32'], rollback_from: [] },
    images: Object.fromEntries((['api', 'frontend', 'gateway'] as const).map((role) => [role, {
      source: `index.docker.io/kortix/kortix-${role}@${DIGEST}`,
      digest: DIGEST,
      customer_repository: role,
    }])),
    artifacts: {
      platform_bundle: { target: 'p.tar.gz', sha256: HASH, length: 1 },
      supabase_bundle: { target: 's.tar.gz', sha256: HASH, length: 1 },
      cosign_public_key: { target: 'cosign.pub', sha256: HASH, length: 1 },
      updater_binary: { target: 'updater-linux-amd64', sha256: HASH, length: 1 },
    },
    migrations: [],
    health: { api_path: '/v1/health', frontend_path: '/api/health', expected_version: '0.9.84' },
  });
}

describe('artifact verification and mirroring', () => {
  test('verifies every immutable source before authenticating or mirroring', () => {
    const runner = new FakeRunner();
    const repositories = parseCustomerRepositories(JSON.stringify({
      api: '935064898258.dkr.ecr.us-west-2.amazonaws.com/demo/api',
      frontend: '935064898258.dkr.ecr.us-west-2.amazonaws.com/demo/frontend',
      gateway: '935064898258.dkr.ecr.us-west-2.amazonaws.com/demo/gateway',
    }));
    const mirrored = verifyAndMirrorImages(runner, manifest(), '/tmp/cosign.pub', repositories, 'us-west-2');
    const verifyIndexes = runner.calls.flatMap((call, index) => call.command === 'cosign' && call.args[0] === 'verify' ? [index] : []);
    const loginIndex = runner.calls.findIndex((call) => call.command === 'aws');
    expect(verifyIndexes).toHaveLength(3);
    expect(Math.max(...verifyIndexes)).toBeLessThan(loginIndex);
    expect(mirrored).toHaveLength(3);
    expect(runner.calls.find((call) => call.command === 'crane' && call.args[0] === 'auth')?.options?.input).toBe('secret-password\n');
  });

  test('rejects non-ECR or tagged destination configuration', () => {
    expect(() => parseCustomerRepositories(JSON.stringify({
      api: 'docker.io/kortix/api:latest', frontend: 'x', gateway: 'x',
    }))).toThrow('private ECR');
  });
});
