import { readFileSync, readdirSync } from 'node:fs';
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
const DOCKERFILE: Record<(typeof IMAGES)[number], string> = {
  api: 'apps/api/Dockerfile',
  gateway: 'apps/llm-gateway/Dockerfile',
  frontend: 'apps/web/Dockerfile',
};

// Every Linux job runs on a free GitHub-hosted runner (this repo is public)
// through a repo-variable switch: `${{ vars.CI_RUNNER_<tier> || '<label>' }}`.
// Setting the variable (e.g. to `blacksmith-8vcpu-ubuntu-2404`) moves that tier
// to another runner pool with no code change — the only lever that still works
// when the default pool is what is broken, since a PR needs runners to merge.
// Blacksmith was the default from 2026-08-26 to 2026-10-08 and billed ~$2.7k in
// September for minutes GitHub gives this repo for free.
const RUNNER_L = "${{ vars.CI_RUNNER_L || 'ubuntu-24.04' }}";
const RUNNER_L_ARM = "${{ vars.CI_RUNNER_L_ARM || 'ubuntu-24.04-arm' }}";
const BUILDX = 'uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1';
const BUILD_PUSH = 'uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0';

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
    // Each leg's runner architecture must match the platform it produces, and
    // both legs keep the kill-switch fallback (see RUNNER_* above).
    expect(job).toContain(`platform: linux/amd64\n            runner: ${RUNNER_L}`);
    expect(job).toContain(`platform: linux/arm64\n            runner: ${RUNNER_L_ARM}`);
    // Emulating both arches in one job is exactly what this replaced.
    expect(job).not.toContain('platforms: linux/amd64,linux/arm64');
  });

  it.each(IMAGES)('gives %s a registry layer cache keyed per image and arch', (image) => {
    const job = jobBlock(source, `build-${image}`);

    // The registry cache is what makes an unchanged-dependency build warm:
    // measured 2026-08-25, it reused 34-45 layers where Blacksmith's sticky
    // disk reused 0. Keyed per arch so an arm64 leg never reads amd64 layers.
    // mode=max caches intermediate stages too.
    expect(job).toContain(BUILDX);
    expect(job).toContain(BUILD_PUSH);
    expect(job).toContain(
      `cache-from: type=registry,ref=kortix/kortix-${image}:staging-buildcache-\${{ matrix.arch }}`,
    );
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

  it.each(IMAGES)('keeps the %s dev build on the registry layer cache', (image) => {
    const job = jobBlock(source, `build-${image}`);

    expect(job).toContain(BUILDX);
    expect(job).toContain(`file: ${DOCKERFILE[image]}`);
    expect(job).toContain(BUILD_PUSH);
    expect(job).toContain(`cache-from: type=registry,ref=kortix/kortix-${image}:dev-buildcache`);
    expect(job).toContain(
      `cache-to: type=registry,ref=kortix/kortix-${image}:dev-buildcache,mode=max`,
    );
  });
});

describe('every Linux job defaults to a free runner behind the runner switch', () => {
  // A bare label has no rollback lever, and a paid default label bills every
  // run. The wizard PR (#6901) shipped bare `blacksmith-4vcpu-*` labels; this
  // pins the switch AND a GitHub-hosted default (free on a public repo).
  const workflows = readdirSync(resolve(import.meta.dirname, '../../.github/workflows')).filter(
    (name) => name.endsWith('.yml'),
  );
  const tiered =
    /^\$\{\{ vars\.CI_RUNNER_(S|M|L|L_ARM|M_2204) \|\| 'ubuntu-2(2|4)\.04(-arm)?' \}\}$/;
  const githubHostedRunnerJobs = new Set([
    'deploy-prod.yml:publish-llm-catalog',
    'deploy-prod.yml:publish-sdk',
    'deploy-prod.yml:publish-agent-tunnel',
  ]);

  it.each(workflows)('%s', (name) => {
    const source = read(name);
    // Blacksmith's Docker actions need a Blacksmith runner to do anything.
    expect(source).not.toContain('uses: useblacksmith/');
    const seenGithubHostedRunnerJobs = new Set<string>();
    for (const match of source.matchAll(/^ {4}runs-on: (.+)$/gm)) {
      const value = match[1];
      if (value === '${{ matrix.runner }}') continue;
      const job = Array.from(source.slice(0, match.index).matchAll(/^ {2}([a-z0-9-]+):$/gm)).at(
        -1,
      )?.[1];
      const key = `${name}:${job}`;
      if (githubHostedRunnerJobs.has(key)) {
        expect(value, `runs-on in ${key}`).toBe('ubuntu-latest');
        seenGithubHostedRunnerJobs.add(key);
        continue;
      }
      expect(value, `runs-on in ${name}`).toMatch(tiered);
    }
    if (name === 'deploy-prod.yml') {
      expect(seenGithubHostedRunnerJobs).toEqual(githubHostedRunnerJobs);
    }
    for (const [, value] of source.matchAll(/^ {12}runner: (.+)$/gm)) {
      // macOS and Windows are GitHub-hosted labels with no tier variable.
      if (/^(macos|windows)-/.test(value)) continue;
      expect(value, `matrix runner in ${name}`).toMatch(tiered);
    }
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
