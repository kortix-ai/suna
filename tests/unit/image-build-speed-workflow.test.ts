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

// Every Linux job runs on Blacksmith through a repo-variable kill switch:
// `${{ vars.CI_RUNNER_<tier> || '<blacksmith label>' }}`. Setting the variable
// (e.g. to `ubuntu-latest`) moves that tier back to GitHub-hosted runners with
// no code change — the only rollback that still works when Blacksmith itself
// is what is broken, since a PR needs runners to merge. docs/runbooks/ci-runners.md
const RUNNER_L = "${{ vars.CI_RUNNER_L || 'blacksmith-8vcpu-ubuntu-2404' }}";
const RUNNER_L_ARM = "${{ vars.CI_RUNNER_L_ARM || 'blacksmith-8vcpu-ubuntu-2404-arm' }}";

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

  it.each(IMAGES)('gives %s a Blacksmith layer cache keyed per image and platform', (image) => {
    const job = jobBlock(source, `build-${image}`);

    // The sticky-disk builder is what makes an unchanged-dependency build warm.
    // Keyed by Dockerfile + platform so an arm64 leg never reads amd64 layers,
    // and so dev/preview builds of the same Dockerfile share the cache.
    expect(job).toContain('uses: useblacksmith/setup-docker-builder@v2');
    expect(job).toContain(`cache-key: ${DOCKERFILE[image]}:\${{ matrix.platform }}`);
    expect(job).toContain('uses: useblacksmith/build-push-action@v2');
    // The registry cache stays alongside the sticky disk: measured 2026-08-25,
    // five consecutive sticky-disk builds of one key reused 0 layers while the
    // registry cache reused 34-45. mode=max caches intermediate stages too.
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

  it.each(IMAGES)('keeps the %s dev build on the Blacksmith layer cache', (image) => {
    const job = jobBlock(source, `build-${image}`);

    expect(job).toContain('uses: useblacksmith/setup-docker-builder@v2');
    expect(job).toContain(`cache-key: ${DOCKERFILE[image]}:linux/amd64`);
    expect(job).toContain('uses: useblacksmith/build-push-action@v2');
    expect(job).toContain(`cache-from: type=registry,ref=kortix/kortix-${image}:dev-buildcache`);
    expect(job).toContain(
      `cache-to: type=registry,ref=kortix/kortix-${image}:dev-buildcache,mode=max`,
    );
  });
});

describe('every Linux job keeps the Blacksmith runner kill switch', () => {
  // A bare label — GitHub-hosted or Blacksmith — has no rollback lever. The
  // wizard PR (#6901) shipped bare `blacksmith-4vcpu-*` labels and left three
  // amd64 legs on `ubuntu-latest`; this pins the convention instead.
  const workflows = readdirSync(resolve(import.meta.dirname, '../../.github/workflows')).filter(
    (name) => name.endsWith('.yml'),
  );
  const tiered =
    /^\$\{\{ vars\.CI_RUNNER_(S|M|L|L_ARM|M_2204) \|\| 'blacksmith-(2|4|8)vcpu-ubuntu-2(2|4)04(-arm)?' \}\}$/;

  it.each(workflows)('%s', (name) => {
    const source = read(name);
    for (const [, value] of source.matchAll(/^ {4}runs-on: (.+)$/gm)) {
      if (value === '${{ matrix.runner }}') continue;
      expect(value, `runs-on in ${name}`).toMatch(tiered);
    }
    for (const [, value] of source.matchAll(/^ {12}runner: (.+)$/gm)) {
      // macOS and Windows stay GitHub-hosted: free on this public repo, and
      // Blacksmith's Windows pool is still in beta.
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
