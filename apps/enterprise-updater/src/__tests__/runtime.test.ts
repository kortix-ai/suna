import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  EcrImagePreparer,
  PublicImagePreparer,
  materializeRuntimeEnvFile,
  runUnderUpdaterLock,
} from '../runtime.ts';
import { parseEnterpriseReleaseManifest, type EnterpriseReleaseManifest } from '../release-contract.ts';
import type { CommandRunner, RunOptions } from '../process.ts';

const DIGESTS = {
  api: `sha256:${'a'.repeat(64)}`,
  gateway: `sha256:${'b'.repeat(64)}`,
  frontend: `sha256:${'c'.repeat(64)}`,
};
const CADDY = `docker.io/library/caddy@sha256:${'e'.repeat(64)}`;
const SECRET = 'sk-openrouter-super-secret-value';

function manifest(): EnterpriseReleaseManifest {
  return parseEnterpriseReleaseManifest({
    schema_version: 1,
    version: '0.9.84-e1',
    channel: 'stable',
    published_at: '2026-07-14T12:00:00Z',
    prod: { version: '0.9.84', source_sha: 'b'.repeat(40) },
    enterprise: { source_sha: 'c'.repeat(40) },
    compatibility: { architectures: ['amd64'], kubernetes_minor: ['1.32'], rollback_from: [] },
    images: Object.fromEntries((['api', 'gateway', 'frontend'] as const).map((role) => [role, {
      source: `docker.io/kortix/kortix-${role}@${DIGESTS[role]}`,
      digest: DIGESTS[role],
      customer_repository: role,
    }])),
    artifacts: {
      platform_bundle: { target: 'platform.tar.gz', sha256: '1'.repeat(64), length: 10 },
      supabase_bundle: { target: 'supabase.tar.gz', sha256: 'd'.repeat(64), length: 10 },
      cosign_public_key: { target: 'cosign.pub', sha256: '2'.repeat(64), length: 10 },
      updater_binary: { target: 'updater', sha256: '3'.repeat(64), length: 10 },
    },
    migrations: [],
    health: { api_path: '/v1/health', frontend_path: '/', expected_version: '0.9.84' },
  });
}

class RecordingRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly responses: Record<string, string> = {}) {}
  run(command: string, args: string[], _options?: RunOptions): string {
    this.calls.push({ command, args });
    return this.responses[command] ?? '';
  }
}

describe('runUnderUpdaterLock', () => {
  test('re-execs the updater under flock and returns the child status', () => {
    const result = runUnderUpdaterLock('/var/lib/kortix/updater.lock', '/bin/updater', ['run'], (cmd, argv) => {
      expect(cmd).toBe('flock');
      expect(argv).toEqual(['-n', '-E', '75', '/var/lib/kortix/updater.lock', '/bin/updater', 'run']);
      return { status: 0 };
    });
    expect(result).toEqual({ status: 0 });
  });

  test('a busy lock (flock exit 75) is a clean no-op skip', () => {
    const result = runUnderUpdaterLock('/var/lib/kortix/updater.lock', '/bin/updater', ['run'], () => ({ status: 75 }));
    expect(result).toEqual({ skipped: true });
  });
});

describe('materializeRuntimeEnvFile secret non-disclosure', () => {
  test('reads Secrets Manager via --query and writes the secret to a 0600 file, never argv', () => {
    const runner = new RecordingRunner({ aws: JSON.stringify({ OPENROUTER_API_KEY: SECRET, SUPABASE_URL: 'http://10.0.0.5:8000' }) });
    const path = materializeRuntimeEnvFile(runner, { runtimeSecretArn: 'arn:x', region: 'us-west-2' });
    // The secret value never appears on any command line.
    for (const call of runner.calls) expect(call.args.join(' ')).not.toContain(SECRET);
    // get-secret-value uses --query SecretString (no inline value).
    expect(runner.calls[0]!.args).toContain('SecretString');
    // The rendered file holds the object and is not world-readable.
    const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    expect(written.OPENROUTER_API_KEY).toBe(SECRET);
  });
});

describe('image preparers (ECR pull-only vs public)', () => {
  test('EcrImagePreparer pulls the customer ECR refs by digest and never mirrors/pushes', () => {
    const runner = new RecordingRunner();
    const repositories = JSON.stringify({
      api: '935064898258.dkr.ecr.us-west-2.amazonaws.com/vpc-demo-api',
      gateway: '935064898258.dkr.ecr.us-west-2.amazonaws.com/vpc-demo-gateway',
      frontend: '935064898258.dkr.ecr.us-west-2.amazonaws.com/vpc-demo-frontend',
    });
    const images = new EcrImagePreparer(runner, repositories, CADDY).prepare(manifest(), '/tmp/cosign.pub');
    expect(images.api).toBe(`935064898258.dkr.ecr.us-west-2.amazonaws.com/vpc-demo-api@${DIGESTS.api}`);
    expect(images.caddy).toBe(CADDY);
    // pull-only: no crane, no ECR push, no put-image.
    expect(runner.calls.some((c) => c.command === 'crane')).toBe(false);
    expect(runner.calls.every((c) => c.command === 'docker' && c.args[0] === 'pull')).toBe(true);
    expect(runner.calls.map((c) => c.args[1])).toContain(images.api);
  });

  test('PublicImagePreparer cosign-verifies then pulls the Docker Hub source by digest', () => {
    const runner = new RecordingRunner();
    const images = new PublicImagePreparer(runner, true, CADDY).prepare(manifest(), '/tmp/cosign.pub');
    expect(images.api).toBe(`docker.io/kortix/kortix-api@${DIGESTS.api}`);
    expect(runner.calls.some((c) => c.command === 'cosign' && c.args[0] === 'verify')).toBe(true);
    expect(runner.calls.some((c) => c.command === 'docker' && c.args[0] === 'pull')).toBe(true);
  });

  test('rejects a Caddy image that is not digest-pinned', () => {
    expect(() => new PublicImagePreparer(new RecordingRunner(), true, 'caddy:2')).toThrow('digest-pinned');
  });
});
