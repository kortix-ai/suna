/**
 * The release RECORD — tag, GitHub Release, CLI binaries, changelog, VERSION
 * syncs — must never be gated on an unrelated external registry.
 *
 * Incident: v0.13.25, deploy-prod run 35589361726, prod merge b902d67fc4.
 * Production served 0.13.25 on api/gateway/web and the images carried the
 * right tags, but the run ended `failure` because publish-llm-catalog and
 * publish-agent-tunnel died with
 *   npm error 404 Not Found - PUT https://registry.npmjs.org/@kortix%2f…
 * (npm answers 404 rather than 403 for an auth failure on an existing
 * package). publish-sdk `needs: publish-llm-catalog` so it skipped, and
 * github-release `needs: publish-sdk` so IT skipped — taking attach-desktop,
 * announce, sync-main-version and sync-staging-version with it. Shipped, and
 * unrecorded.
 *
 * These tests pin the fix in both directions: the release record does not
 * depend on npm, and the Release still refuses to publish without its assets.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = '.github/workflows/deploy-prod.yml';
const workflow = readFileSync(resolve(root, workflowPath), 'utf8');

/** Every npm publish job in deploy-prod.yml. */
const NPM_PUBLISH_JOBS = [
  'publish-llm-catalog',
  'publish-sdk',
  'publish-agent-tunnel',
] as const;

type Job = { needs: string[] };

/**
 * Minimal `needs:` graph reader. deploy-prod.yml writes every `needs:` inline
 * (`needs: version` or `needs: [a, b]`); a block sequence would be missed, so
 * `parses every job` below asserts the job count this reader sees.
 */
function parseJobs(source: string): Map<string, Job> {
  const jobs = new Map<string, Job>();
  let current: string | null = null;
  for (const line of source.split('\n')) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, { needs: [] });
      continue;
    }
    if (!current) continue;
    const needs = /^ {4}needs:\s*(.+?)\s*$/.exec(line);
    if (!needs) continue;
    const raw = needs[1];
    jobs.get(current)!.needs = raw.startsWith('[')
      ? raw
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [raw];
  }
  return jobs;
}

function transitiveNeeds(jobs: Map<string, Job>, name: string): Set<string> {
  const seen = new Set<string>();
  const walk = (job: string) => {
    for (const dep of jobs.get(job)?.needs ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      walk(dep);
    }
  };
  walk(name);
  return seen;
}

/** The body of a `run: |` block, dedented, for a step identified by its name. */
function stepScript(source: string, stepName: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (start === -1) throw new Error(`step not found: ${stepName}`);
  const runAt = lines.findIndex((l, i) => i > start && /^\s*run: \|\s*$/.test(l));
  if (runAt === -1 || runAt > start + 6) throw new Error(`no run block for: ${stepName}`);
  const indent = (lines[runAt].match(/^\s*/) as RegExpMatchArray)[0].length + 2;
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const lead = (line.match(/^\s*/) as RegExpMatchArray)[0].length;
    if (lead < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const GUARD_STEP = 'Assert the release carries every expected binary';

/**
 * Resolved lazily: a DELETED guard step must surface as a named failing test,
 * not as a collection error that hides every other assertion in this file.
 */
let guardScriptCache: string | null | undefined;
function guardScript(): string {
  if (guardScriptCache === undefined) {
    try {
      guardScriptCache = stepScript(workflow, GUARD_STEP);
    } catch {
      guardScriptCache = null;
    }
  }
  if (guardScriptCache === null) {
    throw new Error(
      `the release asset guard step "${GUARD_STEP}" is missing from ${workflowPath}: ` +
        'github-release would publish whatever build-cli happened to leave behind',
    );
  }
  return guardScriptCache;
}

/** The binaries build-cli hands to github-release, read from its upload step. */
function uploadedCliArtifacts(source: string): string[] {
  const marker = 'name: cli-binaries';
  const at = source.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const tail = source.slice(at);
  const pathAt = tail.indexOf('path: |');
  const lines = tail.slice(pathAt).split('\n').slice(1);
  const names: string[] = [];
  for (const line of lines) {
    const match = /^\s+artifacts\/(kortix-[A-Za-z0-9._-]+)\s*$/.exec(line);
    if (!match) break;
    names.push(match[1]);
  }
  return names;
}

describe('deploy-prod: the release record is not gated on npm', () => {
  const jobs = parseJobs(workflow);

  it('parses every job in the workflow', () => {
    // Guards the reader itself: a `needs:` written as a block sequence, or a
    // job this reader cannot see, would silently make every assertion below
    // vacuous.
    expect(jobs.size).toBe(32);
    expect(jobs.has('github-release')).toBe(true);
    for (const job of NPM_PUBLISH_JOBS) expect(jobs.has(job)).toBe(true);
    expect(workflow).not.toMatch(/^ {4}needs:\s*$/m);
  });

  it('github-release does not need any npm publish job', () => {
    const needs = jobs.get('github-release')!.needs;
    expect(needs).not.toContain('publish-sdk');
    expect(needs).not.toContain('publish-agent-tunnel');
    expect(needs).not.toContain('publish-llm-catalog');
    expect(needs.filter((n) => n.startsWith('publish-'))).toEqual([]);
  });

  it('github-release keeps the preconditions that are genuine', () => {
    // verify-live-version exists because v0.10.0/v0.10.1 announced a Release
    // while deploy-ecs had failed and api.kortix.com served the old build.
    // build-cli is where the Release's own assets come from.
    const needs = jobs.get('github-release')!.needs;
    expect(needs).toEqual(
      expect.arrayContaining([
        'version',
        'retag-images',
        'build-cli',
        'deploy-ecs',
        'verify-live-version',
        'frontend-auth-proof',
      ]),
    );
  });

  it('no job transitively depends on an npm publish', () => {
    const gated: string[] = [];
    for (const name of jobs.keys()) {
      if ((NPM_PUBLISH_JOBS as readonly string[]).includes(name)) continue;
      const deps = transitiveNeeds(jobs, name);
      if (NPM_PUBLISH_JOBS.some((p) => deps.has(p))) gated.push(name);
    }
    expect(gated).toEqual([]);
  });

  it.each([
    'verify-schema',
    'sync-main-version',
    'sync-staging-version',
    'announce',
    'attach-desktop',
  ])('%s does not transitively depend on an npm publish', (job) => {
    const deps = transitiveNeeds(jobs, job);
    expect(NPM_PUBLISH_JOBS.filter((p) => deps.has(p))).toEqual([]);
  });

  it('the jobs that own the release record still wait for the Release itself', () => {
    // Removing the npm edge must not also loosen these: attaching installers
    // to, announcing, or bumping VERSION for a Release that does not exist is
    // the failure this change is preventing, inverted.
    for (const job of ['attach-desktop', 'announce', 'sync-main-version', 'sync-staging-version']) {
      expect(jobs.get(job)!.needs).toContain('github-release');
    }
  });

  it('an npm publish failure still fails the run', () => {
    // No continue-on-error on any publish job: a failed publish keeps the whole
    // deploy-prod run red, it just no longer erases the release record.
    const ordered = [...jobs.keys()];
    for (const job of NPM_PUBLISH_JOBS) {
      const start = workflow.indexOf(`\n  ${job}:\n`);
      expect(start).toBeGreaterThan(-1);
      const nextJob = ordered[ordered.indexOf(job) + 1];
      const end = nextJob ? workflow.indexOf(`\n  ${nextJob}:\n`) : workflow.length;
      const block = workflow.slice(start, end);
      expect(block).not.toContain('continue-on-error');
    }
    // REQUIRE_NPM_AUTH=1 keeps a missing credential a failure rather than a
    // silently omitted package.
    expect(workflow).toContain("REQUIRE_NPM_AUTH: '1'");
  });
});

describe('deploy-prod: github-release refuses an incomplete Release', () => {
  it('asserts its assets before the Release is created', () => {
    expect(() => guardScript()).not.toThrow();
    const guardAt = workflow.indexOf(`- name: ${GUARD_STEP}`);
    const createAt = workflow.indexOf('- name: Create GitHub Release');
    expect(guardAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(guardAt);
  });

  it('expects exactly the binaries build-cli uploads', () => {
    const expected = [...guardScript().matchAll(/^\s+(kortix-[A-Za-z0-9._-]+)\s*$/gm)].map(
      (m) => m[1],
    );
    expect(expected.length).toBe(8);
    expect([...expected].sort()).toEqual([...uploadedCliArtifacts(workflow)].sort());
  });

  /**
   * Run the real guard script and return its exit status plus its output.
   * Never assert against a thrown Error's `message`: it embeds the whole
   * script, so every `echo "::error::…"` string in the source would match and
   * the assertion would pass whatever the guard did.
   */
  function run(dir: string): { status: number; out: string } {
    const result = spawnSync('bash', ['-c', guardScript()], { cwd: dir, encoding: 'utf8' });
    return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
  }

  /** A release/ directory exactly as the assemble step leaves it. */
  function stageRelease(overrides: { omit?: string[]; truncate?: string[] } = {}) {
    const dir = mkdtempSync(resolve(tmpdir(), 'kortix-release-guard-'));
    const releaseDir = resolve(dir, 'release');
    mkdirSync(releaseDir);
    const assets = uploadedCliArtifacts(workflow);
    const sums: string[] = [];
    for (const asset of assets) {
      if (overrides.omit?.includes(asset)) continue;
      const bytes = overrides.truncate?.includes(asset) ? 1024 : 2 * 1024 * 1024;
      writeFileSync(resolve(releaseDir, asset), Buffer.alloc(bytes, 7));
      sums.push(`${'0'.repeat(64)}  ./${asset}`);
      if (asset.startsWith('kortix-tui-')) {
        writeFileSync(resolve(releaseDir, `${asset}.sha256`), `${'0'.repeat(64)}  ${asset}\n`);
      }
    }
    writeFileSync(resolve(releaseDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
    return { dir, releaseDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('passes on a complete release', () => {
    const staged = stageRelease();
    try {
      const { status, out } = run(staged.dir);
      expect(out).toContain('all 8 expected binaries present');
      expect(status).toBe(0);
    } finally {
      staged.cleanup();
    }
  });

  it('fails when a CLI binary is missing', () => {
    const staged = stageRelease({ omit: ['kortix-darwin-arm64'] });
    try {
      const { status, out } = run(staged.dir);
      expect(out).toContain('::error::release asset missing: kortix-darwin-arm64');
      expect(out).toContain('Refusing to publish an incomplete Release');
      expect(status).toBe(1);
    } finally {
      staged.cleanup();
    }
  });

  it('fails when a TUI binary is missing', () => {
    const staged = stageRelease({ omit: ['kortix-tui-linux-x64'] });
    try {
      const { status, out } = run(staged.dir);
      expect(out).toContain('::error::release asset missing: kortix-tui-linux-x64');
      expect(status).toBe(1);
    } finally {
      staged.cleanup();
    }
  });

  it('fails on a truncated binary', () => {
    const staged = stageRelease({ truncate: ['kortix-linux-x64'] });
    try {
      const { status, out } = run(staged.dir);
      expect(out).toContain('::error::release asset truncated: kortix-linux-x64');
      expect(status).toBe(1);
    } finally {
      staged.cleanup();
    }
  });

  it('fails when an asset is absent from SHA256SUMS', () => {
    const staged = stageRelease();
    try {
      const sums = readFileSync(resolve(staged.releaseDir, 'SHA256SUMS'), 'utf8');
      writeFileSync(
        resolve(staged.releaseDir, 'SHA256SUMS'),
        sums
          .split('\n')
          .filter((l) => !l.endsWith('./kortix-linux-arm64'))
          .join('\n'),
      );
      const { status, out } = run(staged.dir);
      expect(out).toContain('::error::release asset not listed in SHA256SUMS: kortix-linux-arm64');
      expect(status).toBe(1);
    } finally {
      staged.cleanup();
    }
  });

  it('fails when a TUI sidecar checksum is missing', () => {
    // `kortix tui` verifies kortix-tui-<target>.sha256 before the download
    // becomes executable (apps/cli/src/tui-bin.ts).
    const staged = stageRelease();
    try {
      rmSync(resolve(staged.releaseDir, 'kortix-tui-darwin-arm64.sha256'));
      const { status, out } = run(staged.dir);
      expect(out).toContain('::error::missing sidecar checksum: kortix-tui-darwin-arm64.sha256');
      expect(status).toBe(1);
    } finally {
      staged.cleanup();
    }
  });

  it('fails on an empty release directory', () => {
    // The worst case the guard exists for: a Release with no assets becomes
    // `latest` and 404s every scripts/install.sh run.
    const dir = mkdtempSync(resolve(tmpdir(), 'kortix-release-guard-'));
    try {
      mkdirSync(resolve(dir, 'release'));
      writeFileSync(resolve(dir, 'release', 'SHA256SUMS'), '');
      const { status, out } = run(dir);
      expect(out).toContain('::error::release asset missing: kortix-darwin-arm64');
      expect(out).toContain('::error::SHA256SUMS is missing or empty');
      expect(out).toContain('Refusing to publish an incomplete Release');
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // npm's registry refuses a sigstore provenance bundle built anywhere but a
  // GitHub-hosted runner: v0.13.25 (run 35589361726) failed every publish with
  // `E422 ... Unsupported GitHub Actions runner environment` on
  // blacksmith-4vcpu-ubuntu-2404, AFTER Trusted Publishing had authenticated
  // and signed. Speed buys nothing on these jobs; provenance does.
  it('publishes npm packages from a GitHub-hosted runner, never Blacksmith', () => {
    const publishJobs = [
      'Publish @kortix/llm-catalog to npm',
      'Publish @kortix/sdk to npm',
      'Publish @kortix/agent-tunnel to npm',
    ];
    const lines = workflow.split('\n');
    for (const name of publishJobs) {
      const at = lines.findIndex((l) => l.includes(`name: ${name}`));
      expect(at, `job not found: ${name}`).toBeGreaterThan(-1);
      const runsOn = lines.slice(at, at + 8).find((l) => l.trim().startsWith('runs-on:'));
      expect(runsOn, `no runs-on for ${name}`).toBeDefined();
      expect(runsOn, `${name} must not run on Blacksmith`).not.toMatch(/blacksmith/i);
      expect(runsOn, `${name} must be GitHub-hosted`).toContain('ubuntu-latest');
    }
  });
});
