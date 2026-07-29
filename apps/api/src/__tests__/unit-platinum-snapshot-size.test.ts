import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'kortix-platinum-size-test-'));
const agentPath = join(fixtureRoot, 'kortix-agent');
const cliPath = join(fixtureRoot, 'kortix');
const entrypointPath = join(fixtureRoot, 'entrypoint.sh');
const slackCliPath = join(fixtureRoot, 'slack-cli');
const executorSdkPath = join(fixtureRoot, 'executor-sdk');
const opencodeConfigPath = join(fixtureRoot, 'opencode-config');

writeFileSync(agentPath, '#!/bin/sh\n');
writeFileSync(cliPath, '#!/bin/sh\n');
writeFileSync(entrypointPath, '#!/bin/sh\n');
await chmod(agentPath, 0o755);
await chmod(cliPath, 0o755);
await chmod(entrypointPath, 0o755);
await mkdir(slackCliPath, { recursive: true });
await mkdir(executorSdkPath, { recursive: true });
await mkdir(opencodeConfigPath, { recursive: true });

type FromBuildPayload = {
  name: string;
  size_mb: number;
  default_disk_gb: number;
};

/** Registered under this name, the `/v1/templates/from-build` stub throws
 *  Platinum's real "size_mb too_big" 400 shape instead of registering — see
 *  the size-cap-failure tests below. */
const OVERSIZE_TEMPLATE_NAME = 'kortix-oversize-template';

let fromBuildPayloads: FromBuildPayload[] = [];
let registeredTemplateName = '';
let registeredTemplateId = '';
/** Counts from-build POSTs the oversize stub rejected — proves a size-cap
 *  failure never burns more than one BUILD_ATTEMPTS slot. */
let oversizeAttempts = 0;

mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumJson: async (path: string, init: RequestInit = {}) => {
    if (path === '/v1/templates/from-build/presign') {
      return { upload_url: 'https://upload.test/context.tar.gz', context_s3_key: 'ctx-key' };
    }
    if (path === '/v1/templates/from-build') {
      const payload = JSON.parse(String(init.body ?? '{}')) as FromBuildPayload;
      if (payload.name === OVERSIZE_TEMPLATE_NAME) {
        oversizeAttempts += 1;
        // Platinum's real from-build rejection shape for a ceiling above its
        // hard cap (see platinum.ts's PLATINUM_MAX_BUILD_SIZE_MB doc comment).
        throw new Error('platinum POST /v1/templates/from-build -> 400 {"error":"size_mb too_big"}');
      }
      fromBuildPayloads.push(payload);
      registeredTemplateName = payload.name;
      registeredTemplateId = `tpl-${fromBuildPayloads.length}`;
      return { id: registeredTemplateId, name: payload.name, state: 'building' };
    }
    if (path === '/v1/templates') {
      return registeredTemplateName
        ? [{ id: registeredTemplateId, name: registeredTemplateName, state: 'ready' }]
        : [];
    }
    // PHASE 2 EXACT ID: waitForActive polls the just-registered template by
    // its id (`GET /v1/templates/:id`), never the name list, once from-build
    // hands one back — see platinum.ts's requireExternalTemplateId/waitForActive.
    if (registeredTemplateId && path === `/v1/templates/${registeredTemplateId}`) {
      return { id: registeredTemplateId, name: registeredTemplateName, state: 'ready' };
    }
    throw new Error(`unexpected Platinum path: ${path}`);
  },
}));

// Capture the real fetch; install the 200-stub PER-TEST (beforeEach), NOT at
// module load — a module-level override here is process-global in bun and was
// clobbering sibling test files' fetch (it broke the daytona suite in combined runs).
const originalFetch = globalThis.fetch;
const stubFetch = Object.assign(
  async () => new Response('', { status: 200 }),
  { preconnect: originalFetch.preconnect },
) as typeof fetch;

const {
  platinumProvider,
  PLATINUM_MAX_BUILD_SIZE_MB,
  PLATINUM_MIN_BUILD_SIZE_MB,
  PLATINUM_SIZE_CAP_LOG_TOKEN,
  platinumBuildSizeMb,
} = await import('../snapshots/providers/platinum');

beforeEach(() => {
  fromBuildPayloads = [];
  registeredTemplateName = '';
  registeredTemplateId = '';
  oversizeAttempts = 0;
  globalThis.fetch = stubFetch;
  // Per-test (not module load): build-context reads these lazily, so setting here
  // keeps this suite's fixtures from leaking into sibling suites in combined runs.
  process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH = agentPath;
  process.env.KORTIX_SNAPSHOT_CLI_BIN_PATH = cliPath;
  process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH = entrypointPath;
  process.env.KORTIX_SNAPSHOT_SLACK_CLI_PATH = slackCliPath;
  process.env.KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH = executorSdkPath;
  process.env.KORTIX_SNAPSHOT_OPENCODE_CONFIG_PATH = opencodeConfigPath;
  // The build-size knob is read LAZILY per call (platinumBuildSizeMb) — reset
  // it before every test so no test's override leaks into the next.
  delete process.env.PLATINUM_BUILD_SIZE_MB;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.PLATINUM_BUILD_SIZE_MB;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('platinumBuildSizeMb (lazy PLATINUM_BUILD_SIZE_MB env knob)', () => {
  test('defaults to PLATINUM_MAX_BUILD_SIZE_MB (20480) when unset — deploy-neutral', () => {
    expect(process.env.PLATINUM_BUILD_SIZE_MB).toBeUndefined();
    expect(platinumBuildSizeMb()).toBe(20480);
    expect(platinumBuildSizeMb()).toBe(PLATINUM_MAX_BUILD_SIZE_MB);
  });

  test('reads the env var fresh on every call despite bun\'s module cache', () => {
    // First call with no env set — this only works if the read is lazy
    // (a module-load const would have latched 20480 forever for this process).
    expect(platinumBuildSizeMb()).toBe(20480);
    process.env.PLATINUM_BUILD_SIZE_MB = '12288';
    expect(platinumBuildSizeMb()).toBe(12288);
    // A SECOND change within the same process must also be observed — proves
    // this isn't just a first-call latch either.
    process.env.PLATINUM_BUILD_SIZE_MB = '16384';
    expect(platinumBuildSizeMb()).toBe(16384);
  });

  test('clamps a value below the floor up to PLATINUM_MIN_BUILD_SIZE_MB (1024)', () => {
    process.env.PLATINUM_BUILD_SIZE_MB = '512';
    expect(platinumBuildSizeMb()).toBe(1024);
    expect(platinumBuildSizeMb()).toBe(PLATINUM_MIN_BUILD_SIZE_MB);
  });

  test('clamps a value above the cap down to PLATINUM_MAX_BUILD_SIZE_MB (20480)', () => {
    process.env.PLATINUM_BUILD_SIZE_MB = '999999';
    expect(platinumBuildSizeMb()).toBe(20480);
  });

  test.each([
    ['non-numeric', 'not-a-number'],
    ['zero', '0'],
    ['negative', '-5'],
    ['empty string', ''],
  ])('treats a %s value as unset (falls back to the default)', (_label, raw) => {
    process.env.PLATINUM_BUILD_SIZE_MB = raw;
    expect(platinumBuildSizeMb()).toBe(20480);
  });
});

describe('Platinum snapshot build sizing', () => {
  test('a disk under the cap is sent verbatim as the build ceiling', async () => {
    await platinumProvider.buildSnapshot({
      snapshotName: 'kortix-small-template',
      image: 'ubuntu:24.04',
      spec: { diskGb: 10 },
      slug: 'small',
    });

    expect(fromBuildPayloads).toHaveLength(1);
    expect(fromBuildPayloads[0].size_mb).toBe(10 * 1024); // < cap → unclamped
    expect(fromBuildPayloads[0].default_disk_gb).toBe(10);
  });

  test('clamps the build ext4 ceiling to Platinum\'s from-build cap, keeping the full runtime disk', async () => {
    await platinumProvider.buildSnapshot({
      snapshotName: 'kortix-large-template',
      image: 'ubuntu:24.04',
      spec: { diskGb: 40 },
      slug: 'large',
    });

    expect(fromBuildPayloads).toHaveLength(1);
    // 40 GiB * 1024 = 40960 > cap → clamped so Platinum doesn't 400 "size_mb too_big".
    expect(fromBuildPayloads[0].size_mb).toBe(PLATINUM_MAX_BUILD_SIZE_MB);
    // Runtime disk is NOT clamped — build ceiling != runtime disk (ext4 grows to fit).
    expect(fromBuildPayloads[0].default_disk_gb).toBe(40);
  });

  test('clamps even an extreme disk to the build cap', async () => {
    await platinumProvider.buildSnapshot({
      snapshotName: 'kortix-max-template',
      image: 'ubuntu:24.04',
      spec: { diskGb: 500 },
      slug: 'max',
    });

    expect(fromBuildPayloads).toHaveLength(1);
    expect(fromBuildPayloads[0].size_mb).toBe(PLATINUM_MAX_BUILD_SIZE_MB);
    expect(fromBuildPayloads[0].default_disk_gb).toBe(500);
  });

  test('runtime default_disk_gb defaults to 20 GiB when the spec omits diskGb (unchanged by this knob)', async () => {
    await platinumProvider.buildSnapshot({
      snapshotName: 'kortix-default-disk-template',
      image: 'ubuntu:24.04',
      spec: {},
      slug: 'default-disk',
    });

    expect(fromBuildPayloads).toHaveLength(1);
    expect(fromBuildPayloads[0].default_disk_gb).toBe(20);
    // No env knob set → default ceiling == cap == disk*1024, all equal at 20 GiB.
    expect(fromBuildPayloads[0].size_mb).toBe(20480);
  });

  test('PLATINUM_BUILD_SIZE_MB lowers the build ceiling on a 40 GiB disk without touching the runtime disk', async () => {
    process.env.PLATINUM_BUILD_SIZE_MB = '12288';
    await platinumProvider.buildSnapshot({
      snapshotName: 'kortix-knob-large-disk-template',
      image: 'ubuntu:24.04',
      spec: { diskGb: 40 },
      slug: 'knob-large-disk',
    });

    expect(fromBuildPayloads).toHaveLength(1);
    // min(knob=12288, 40*1024=40960, cap=20480) = 12288.
    expect(fromBuildPayloads[0].size_mb).toBe(12288);
    // Runtime disk stays the FULL requested spec — decoupled from the knob.
    expect(fromBuildPayloads[0].default_disk_gb).toBe(40);
  });

  test('a knob clamped below the floor still keeps the full runtime disk on a small-disk template', async () => {
    process.env.PLATINUM_BUILD_SIZE_MB = '512'; // clamps to 1024
    await platinumProvider.buildSnapshot({
      snapshotName: 'kortix-knob-floor-template',
      image: 'ubuntu:24.04',
      spec: { diskGb: 10 },
      slug: 'knob-floor',
    });

    expect(fromBuildPayloads).toHaveLength(1);
    // min(1024, 10*1024=10240, 20480) = 1024.
    expect(fromBuildPayloads[0].size_mb).toBe(1024);
    expect(fromBuildPayloads[0].default_disk_gb).toBe(10);
  });

  test(
    'invariant: every captured payload satisfies 1024 <= size_mb <= min(default_disk_gb*1024, 20480)',
    async () => {
      // Kept short (5 cases): each iteration is a REAL build (stage + tar +
      // gzip), and this suite otherwise runs one build per test — a longer
      // sweep here risks the bun default 5s per-test budget on a slow CI box.
      // Still spans every clamp boundary: unset, small, cap-clamped-by-disk,
      // knob-lowered, knob-floored.
      const cases: Array<{ diskGb?: number; env?: string }> = [
        {},
        { diskGb: 10 },
        { diskGb: 500 },
        { diskGb: 40, env: '12288' },
        { diskGb: 10, env: '512' },
      ];

      for (const [i, c] of cases.entries()) {
        if (c.env !== undefined) process.env.PLATINUM_BUILD_SIZE_MB = c.env;
        else delete process.env.PLATINUM_BUILD_SIZE_MB;
        await platinumProvider.buildSnapshot({
          snapshotName: `kortix-invariant-${i}`,
          image: 'ubuntu:24.04',
          spec: c.diskGb !== undefined ? { diskGb: c.diskGb } : {},
          slug: 'invariant',
        });
      }

      expect(fromBuildPayloads).toHaveLength(cases.length);
      for (const payload of fromBuildPayloads) {
        expect(payload.size_mb).toBeGreaterThanOrEqual(PLATINUM_MIN_BUILD_SIZE_MB);
        expect(payload.size_mb).toBeLessThanOrEqual(
          Math.min(payload.default_disk_gb * 1024, PLATINUM_MAX_BUILD_SIZE_MB),
        );
      }
    },
    15_000,
  );
});

describe('Platinum size-cap build-failure classification', () => {
  test('a "size_mb too_big" from-build rejection is wrapped with remediation naming the env knob, and is never retried', async () => {
    let caught: unknown;
    try {
      await platinumProvider.buildSnapshot({
        snapshotName: OVERSIZE_TEMPLATE_NAME,
        image: 'ubuntu:24.04',
        spec: { diskGb: 10 },
        slug: 'oversize',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(PLATINUM_SIZE_CAP_LOG_TOKEN);
    expect(message).toContain('PLATINUM_BUILD_SIZE_MB');
    // BUILD_ATTEMPTS is 3 — a size-cap failure must burn exactly ONE, never
    // all three, because the same content at the same ceiling can never fit.
    expect(oversizeAttempts).toBe(1);
    // And nothing ever got registered as a real (non-throwing) build.
    expect(fromBuildPayloads).toHaveLength(0);
  });
});

describe('Daytona / E2B build payloads are unaffected by the Platinum build-size knob', () => {
  test('daytona.ts and e2b.ts have zero source coupling to PLATINUM_BUILD_SIZE_MB', async () => {
    const { readFile } = await import('node:fs/promises');
    const daytonaSrc = await readFile(join(import.meta.dir, '../snapshots/providers/daytona.ts'), 'utf8');
    const e2bSrc = await readFile(join(import.meta.dir, '../snapshots/providers/e2b.ts'), 'utf8');
    for (const src of [daytonaSrc, e2bSrc]) {
      expect(src).not.toContain('PLATINUM_BUILD_SIZE_MB');
      expect(src).not.toContain('platinumBuildSizeMb');
      expect(src).not.toContain('PLATINUM_MAX_BUILD_SIZE_MB');
    }
  });

  test('the shared DEFAULT_DISK_GB Daytona/E2B consume is untouched by this change', async () => {
    const { DEFAULT_DISK_GB, DEFAULT_MEMORY_GB, DEFAULT_CPU } = await import('../snapshots/build-context');
    expect(DEFAULT_DISK_GB).toBe(20);
    expect(DEFAULT_MEMORY_GB).toBe(6);
    expect(DEFAULT_CPU).toBe(2);
  });
});
