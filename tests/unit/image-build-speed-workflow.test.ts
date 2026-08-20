import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the container-image build topology. Before 2026-08-19 every image in
// build-staging.yml built both arches on ONE x86 runner under QEMU, with no
// BuildKit cache: measured on run 32293230397 the arm64 leg was 2791.6s of
// 3469.0s total buildx node time (80.5%) and the API job alone ran 22-26 min,
// 97-98% of the workflow's wallclock. These assertions exist so that cost
// cannot come back by accident.

const read = (name: string) =>
  readFileSync(resolve(import.meta.dirname, `../../.github/workflows/${name}`), 'utf8');

const IMAGES = ['api', 'gateway', 'frontend'] as const;

// The block of a workflow belonging to one top-level job id.
const jobBlock = (workflow: string, jobId: string): string => {
  const start = workflow.indexOf(`\n  ${jobId}:\n`);
  expect(start, `job ${jobId} is missing`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('staging image builds are native per-arch, cached, and merged', () => {
  const source = read('build-staging.yml');

  it('never reintroduces QEMU emulation', () => {
    // A single runner emulating the other arch is the 4.4-9.4x-per-step cost
    // this topology exists to remove.
    // Match the step, not the prose: the header comment names it as history.
    expect(source).not.toContain('uses: docker/setup-qemu-action');
  });

  it.each(IMAGES)('builds %s natively on one runner per arch', (image) => {
    const job = jobBlock(source, `build-${image}`);

    expect(job).toContain('runs-on: ${{ matrix.runner }}');
    // Each leg's runner architecture must match the platform it produces.
    // ubuntu-24.04-arm is verified available to this repo (aarch64, 4 vCPU).
    expect(job).toContain('platform: linux/amd64\n            runner: ubuntu-latest');
    expect(job).toContain('platform: linux/arm64\n            runner: ubuntu-24.04-arm');
    // Emulating both arches in one job is exactly what this replaced.
    expect(job).not.toContain('platforms: linux/amd64,linux/arm64');
  });

  it.each(IMAGES)('gives %s a registry layer cache scoped per arch', (image) => {
    const job = jobBlock(source, `build-${image}`);

    expect(job).toContain(
      `cache-from: type=registry,ref=kortix/kortix-${image}:staging-buildcache-\${{ matrix.arch }}`,
    );
    // mode=max caches intermediate stages too, not just the final layers.
    expect(job).toContain(
      `cache-to: type=registry,ref=kortix/kortix-${image}:staging-buildcache-\${{ matrix.arch }},mode=max`,
    );
  });

  it.each(IMAGES)('publishes %s by digest, never by tag, from the arch legs', (image) => {
    const job = jobBlock(source, `build-${image}`);

    // Tagging from a single-arch leg would clobber the multi-arch manifest.
    expect(job).toContain('push-by-digest=true');
    expect(job).not.toContain('tags:');
  });

  it.each(IMAGES)('keeps the exact three %s staging tags on the merge job', (image) => {
    const merge = jobBlock(source, `merge-${image}`);

    // Tag semantics are load-bearing: deploy-prod retags staging-<sha8>.
    expect(merge).toContain(
      `--tag "kortix/kortix-${image}:staging-\${{ needs.version.outputs.sha }}"`,
    );
    expect(merge).toContain(`--tag "kortix/kortix-${image}:staging-latest"`);
    expect(merge).toContain(
      `--tag "kortix/kortix-${image}:staging-\${{ needs.version.outputs.sha8 }}"`,
    );
    // A partial merge must fail rather than ship a single-arch manifest.
    expect(merge).toContain('-ne 2');
  });

  it('gates the staging deploy dispatch on the merged manifests', () => {
    const dispatch = jobBlock(source, 'dispatch-deploy');

    // Dispatching on the per-arch legs would race the manifest publish.
    expect(dispatch).toContain(
      'needs: [version, merge-api, merge-gateway, merge-frontend]',
    );
  });
});

describe('dev image builds stay single-arch and cached', () => {
  const source = read('deploy-dev.yml');

  it('carries no QEMU setup, since every dev build is linux/amd64', () => {
    // Dev images are consumed only by ECS Fargate, which runs x86_64.
    expect(source).not.toContain('uses: docker/setup-qemu-action');
    expect(source).not.toContain('platforms: linux/amd64,linux/arm64');
  });

  it.each(IMAGES)('keeps the %s dev build cache wired', (image) => {
    expect(source).toContain(`cache-from: type=registry,ref=kortix/kortix-${image}:dev-buildcache`);
    expect(source).toContain(
      `cache-to: type=registry,ref=kortix/kortix-${image}:dev-buildcache,mode=max`,
    );
  });
});

describe('the API Dockerfile keeps its install layer off the source path', () => {
  const dockerfile = readFileSync(resolve(import.meta.dirname, '../../apps/api/Dockerfile'), 'utf8');

  it('copies manifests before pnpm install and sources after it', () => {
    const manifest = dockerfile.indexOf('COPY ${SERVICE}/package.json');
    const install = dockerfile.indexOf('pnpm install --filter ./${SERVICE}...');
    const sources = dockerfile.indexOf('COPY ${SERVICE} ./${SERVICE}');

    expect(manifest).toBeGreaterThan(-1);
    expect(sources).toBeGreaterThan(-1);
    // Source before install is what made every code edit reinstall every dep.
    expect(manifest).toBeLessThan(install);
    expect(install).toBeLessThan(sources);
  });

  it('keeps the manifest and source copy lists identical', () => {
    // A package whose manifest is copied but whose source is not installs
    // fine and then fails at runtime.
    // Scope to the deps stage: the sandbox-cli stage copies packages too.
    const deps = dockerfile.slice(
      dockerfile.indexOf('FROM node:22-slim AS deps'),
      dockerfile.indexOf('# ---- Runner Stage ----'),
    );
    const pkgs = (re: RegExp) => [...deps.matchAll(re)].map((m) => m[1]).sort();
    const manifests = pkgs(/^COPY (packages\/[a-z-]+)\/package\.json /gm);
    const sources = pkgs(/^COPY (packages\/[a-z-]+) \.\/packages\//gm);

    expect(manifests.length).toBeGreaterThan(0);
    expect(manifests).toEqual(sources);
  });

  it('builds the cross-compiled stages on the build platform, never emulated', () => {
    // These stages hardcode amd64 output (GOARCH=amd64 / bun-linux-x64), so
    // emulating them under a foreign target platform is pure waste.
    for (const stage of ['app-runtime', 'sandbox-agent', 'sandbox-cli']) {
      const line = dockerfile
        .split('\n')
        .find((l) => l.startsWith('FROM') && l.endsWith(`AS ${stage}`));
      expect(line, `stage ${stage}`).toContain('--platform=$BUILDPLATFORM');
    }
  });
});
