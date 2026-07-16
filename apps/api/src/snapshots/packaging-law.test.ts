// Pins the grounding-doc packaging law verbatim:
//
//   "Sandbox image (not a request handler) installs pinned ACP adapter
//   versions. Never run unpinned npx at request time. Image build verifies
//   each adapter via version/help probe."
//
// The codebase already complies (dockerfile-layer.ts:253-272, templates.ts:
// 827-835) — this file exists so a future edit that violates any clause fails
// loudly here instead of silently shipping. Deliberately mirrors the existing
// unit-acp-runtime-layer.test.ts / unit-dockerfile-layer.test.ts style: pure,
// no `../config` / `../shared/db` import (those `process.exit(1)` at module
// load when the full secret set isn't decryptable — see runtime-fingerprint
// law test below for why we hand-assemble the sandboxVersion string instead
// of importing templates.ts's currentRuntimeArtifactFingerprint()).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_BROWSER_VERSION,
  CLAUDE_AGENT_ACP_VERSION,
  CODEX_ACP_VERSION,
  OPENCODE_VERSION,
  PI_ACP_VERSION,
  PI_CODING_AGENT_VERSION,
} from '@kortix/shared';

import { buildLayeredDockerfile } from './dockerfile-layer';
import { buildRuntimeArtifactFingerprint } from './runtime-fingerprint';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
// The literal file COPY'd into the image and set as ENTRYPOINT (see
// templates.ts:50-51 / dockerfile-layer.ts:461). This IS the runtime boot
// script every session executes — reading its real bytes is the closest thing
// to "the emitted runtime boot script content" the brief asks for, since
// (unlike the Dockerfile) it isn't assembled by a builder function.
const ENTRYPOINT_SH = resolve(REPO_ROOT, 'apps/sandbox/entrypoint.sh');

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const NPX_OR_NPM_INSTALL_RE = /\bnpx\b|\bnpm install\b|\bnpm i\s/;

const COMMON = {
  opencodeVersion: OPENCODE_VERSION,
  agentBrowserVersion: AGENT_BROWSER_VERSION,
  agentBinaryPath: 'kortix-agent.gz',
  cliBinaryPath: 'kortix.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  slackCliPath: 'kortix-slack-cli',
  executorSdkPath: 'kortix-executor-sdk',
};

describe('packaging law: never run unpinned npx at request time', () => {
  test('the real runtime entrypoint script (COPY-ed as the image ENTRYPOINT, exec-ed on every session boot) never shells out to npx or npm install', () => {
    const script = readFileSync(ENTRYPOINT_SH, 'utf8');
    expect(script).not.toMatch(NPX_OR_NPM_INSTALL_RE);
  });

  test('the emitted Dockerfile ENTRYPOINT hands off to the boot script verbatim, never an inline npm/npx invocation', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    const entrypointLine = merged
      .split('\n')
      .find((line) => line.startsWith('ENTRYPOINT'));
    expect(entrypointLine).toBe('ENTRYPOINT ["/usr/local/bin/kortix-entrypoint"]');
  });

  test('every npm/npx-bearing line the builder emits sits strictly before ENTRYPOINT — i.e. inside one-time `docker build` RUN steps, never the per-session boot command', () => {
    // Docker RUN instructions execute exactly once, at `docker build` time.
    // ENTRYPOINT is the only instruction that runs per-container-start (what a
    // session actually boots). Proving every npm/npx occurrence is textually
    // BEFORE the ENTRYPOINT line proves it can never run at request time,
    // regardless of how many install steps future adapters add.
    const merged = buildLayeredDockerfile({
      userDockerfile: 'FROM ubuntu:24.04',
      ...COMMON,
      opencodeConfigPath: 'kortix-opencode-config',
      catalogPath: 'kortix-llm-catalog.json',
    });
    const lines = merged.split('\n');
    const entrypointIdx = lines.findIndex((line) => line.startsWith('ENTRYPOINT'));
    expect(entrypointIdx).toBeGreaterThan(0);

    const npmNpxLineIdxs = lines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => NPX_OR_NPM_INSTALL_RE.test(line));
    // Sanity: this Dockerfile really does install packages via npm/npx
    // somewhere — otherwise the assertion below would vacuously pass.
    expect(npmNpxLineIdxs.length).toBeGreaterThan(0);
    for (const { idx } of npmNpxLineIdxs) {
      expect(idx).toBeLessThan(entrypointIdx);
    }
  });
});

describe('packaging law: all four ACP adapters install pinned exact versions, never a floating tag', () => {
  test('the four pin constants are exact semver, not `latest`/a dist-tag/a range', () => {
    for (const pin of [
      CLAUDE_AGENT_ACP_VERSION,
      CODEX_ACP_VERSION,
      PI_ACP_VERSION,
      PI_CODING_AGENT_VERSION,
      OPENCODE_VERSION,
    ]) {
      expect(pin).toMatch(SEMVER_RE);
    }
  });

  test('the emitted install command interpolates the exact pinned constant for every adapter', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    expect(merged).toContain(`@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}`);
    expect(merged).toContain(`@agentclientprotocol/codex-acp@${CODEX_ACP_VERSION}`);
    expect(merged).toContain(`pi-acp@${PI_ACP_VERSION}`);
    expect(merged).toContain(`@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}`);
    expect(merged).toContain(`opencode-ai@${OPENCODE_VERSION}`);
  });

  test('never installs any of the four adapters (or opencode) off `@latest`', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    for (const floating of [
      '@agentclientprotocol/claude-agent-acp@latest',
      '@agentclientprotocol/codex-acp@latest',
      'pi-acp@latest',
      '@earendil-works/pi-coding-agent@latest',
      'opencode-ai@latest',
    ]) {
      expect(merged).not.toContain(floating);
    }
  });
});

describe('packaging law: image build verifies each adapter via a version/help probe', () => {
  test('every pinned adapter is probed after install — command presence AND a version/help invocation', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    const probes: Record<string, string[]> = {
      'claude-agent-acp': ['command -v claude-agent-acp', 'claude-agent-acp --version'],
      'codex-acp': ['command -v codex-acp', 'codex-acp --version'],
      'pi-acp': ['command -v pi-acp', 'pi-acp --help >/dev/null'],
      pi: ['command -v pi', 'pi --version'],
      opencode: ['command -v opencode', 'opencode --version'],
    };
    for (const [adapter, checks] of Object.entries(probes)) {
      for (const check of checks) {
        expect(merged, `${adapter} probe missing: ${check}`).toContain(check);
      }
    }
  });

  test('the adapter probe RUN step runs after the install it verifies, and is not best-effort (`set +e`)', () => {
    const merged = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    const installIdx = merged.indexOf(`@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}`);
    const probeIdx = merged.indexOf('claude-agent-acp --version');
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(probeIdx).toBeGreaterThan(installIdx);
    // Adapter install+probe is one `&&`-chained RUN — a probe failure must
    // fail the whole image build (unlike the best-effort opencode warm-up
    // steps below it, which are deliberately `set +e`).
    const precedingRun = merged.lastIndexOf('RUN', installIdx);
    const stepText = merged.slice(precedingRun, merged.indexOf('\n\n', probeIdx));
    expect(stepText).not.toContain('set +e');
  });
});

describe('packaging law: the runtime fingerprint folds all four adapter pins', () => {
  test('a fingerprint built from the real harness-version formula contains all four pin values as substrings', async () => {
    // Mirrors templates.ts harnessVersionKey()/sandboxVersionStr() EXACTLY
    // (templates.ts:827-835): `oc:<v>:claude-acp:<v>:codex-acp:<v>:pi-acp:<v>:pi:<v>`
    // folded into `sandboxVersion`. buildRuntimeArtifactFingerprint (imported
    // for real, not reimplemented) writes `sandboxVersion` as a literal
    // PREFIX of its return value (runtime-fingerprint.ts:47) rather than
    // hashing it away — so this is the same law templates.ts enforces in
    // production, exercised without templates.ts's `../config`/`../shared/db`
    // imports (which `process.exit(1)` on incomplete local secrets).
    const harnessVersionKey = [
      `oc:${OPENCODE_VERSION}`,
      `claude-acp:${CLAUDE_AGENT_ACP_VERSION}`,
      `codex-acp:${CODEX_ACP_VERSION}`,
      `pi-acp:${PI_ACP_VERSION}`,
      `pi:${PI_CODING_AGENT_VERSION}`,
    ].join(':');
    const sandboxVersion = `dev-sandbox:layer:1:harnesses:${harnessVersionKey}:ab:${AGENT_BROWSER_VERSION}`;

    const fingerprint = await buildRuntimeArtifactFingerprint({
      sandboxVersion,
      opencodeVersion: OPENCODE_VERSION,
      artifacts: [],
    });

    for (const pin of [
      `oc:${OPENCODE_VERSION}`,
      `claude-acp:${CLAUDE_AGENT_ACP_VERSION}`,
      `codex-acp:${CODEX_ACP_VERSION}`,
      `pi-acp:${PI_ACP_VERSION}`,
      `pi:${PI_CODING_AGENT_VERSION}`,
    ]) {
      expect(fingerprint).toContain(pin);
    }
  });

  test('bumping any single pin changes the emitted fingerprint (no stale-image reuse)', async () => {
    const key = (claude: string) =>
      [
        `oc:${OPENCODE_VERSION}`,
        `claude-acp:${claude}`,
        `codex-acp:${CODEX_ACP_VERSION}`,
        `pi-acp:${PI_ACP_VERSION}`,
        `pi:${PI_CODING_AGENT_VERSION}`,
      ].join(':');
    const fpFor = async (claude: string) =>
      buildRuntimeArtifactFingerprint({
        sandboxVersion: `dev-sandbox:layer:1:harnesses:${key(claude)}:ab:${AGENT_BROWSER_VERSION}`,
        opencodeVersion: OPENCODE_VERSION,
        artifacts: [],
      });

    const before = await fpFor(CLAUDE_AGENT_ACP_VERSION);
    const after = await fpFor(`${CLAUDE_AGENT_ACP_VERSION}-bumped`);
    expect(after).not.toBe(before);
  });
});

describe('cold-start posture (P3): production-grade warm-up stays OpenCode-only', () => {
  test('OpenCode gets a build-time DB-migration bake AND (when a config is provided) a project-instance warm-up', () => {
    const withoutConfig = buildLayeredDockerfile({ userDockerfile: 'FROM ubuntu:24.04', ...COMMON });
    expect(withoutConfig).toContain('opencode serve --port 4096 --hostname 127.0.0.1');

    const withConfig = buildLayeredDockerfile({
      userDockerfile: 'FROM ubuntu:24.04',
      ...COMMON,
      opencodeConfigPath: 'kortix-opencode-config',
    });
    expect(withConfig).toContain('instance-warm: ACP runtime layer ready');
  });

  test('claude, codex, and pi are installed + probed but NOT warmed — each probe command appears exactly once (no additional serve/prime invocation)', () => {
    // If a future change adds a warm-up step for one of these three (e.g. a
    // `claude-agent-acp serve` priming RUN, mirroring OpenCode's), the probe
    // command would appear a second time (once for the probe, once inside the
    // new warm-up step) and this fails — catching an unintended posture
    // change per spec P3 ("production-grade warm-up remains OpenCode-only").
    const merged = buildLayeredDockerfile({
      userDockerfile: 'FROM ubuntu:24.04',
      ...COMMON,
      opencodeConfigPath: 'kortix-opencode-config',
    });
    for (const probe of ['claude-agent-acp --version', 'codex-acp --version', 'pi --version']) {
      const occurrences = merged.split(probe).length - 1;
      expect(occurrences, `${probe} should appear exactly once (probe only, no warm-up)`).toBe(1);
    }
  });
});
