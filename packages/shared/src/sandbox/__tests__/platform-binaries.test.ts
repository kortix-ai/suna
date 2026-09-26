/**
 * Two image invariants that make "the platform owns the binaries in a sandbox"
 * true rather than aspirational. Both are asserted on EVERY image definition,
 * because a fix that lands on one of the three is a fix that a customer
 * template or the meta-agent box silently does not get.
 *
 *  1. The daemon must be able to REPLACE the CLI. runtime-assets.ts converges
 *     /usr/local/bin/kortix by writing a temp file next to it and renaming it
 *     into place — an operation whose permission comes from the DIRECTORY, not
 *     the file. /usr/local/bin is root-owned by default while the daemon runs
 *     as `kortix`, so every digest mismatch failed with EACCES and the box
 *     reported `components.cli: failed`. `COPY --chown=kortix:kortix` on the
 *     file alone never fixed that, because the write is a directory write.
 *     The directory is safe to hand over: this image already grants `kortix`
 *     NOPASSWD:ALL sudo, so it buys no privilege that was not already there.
 *
 *  2. OpenCode's own autoupdate must be off for EVERY caller, not just the
 *     daemon's child. `autoupdate: false` reached opencode only through
 *     OPENCODE_CONFIG, which the daemon sets on the process it spawns. A human
 *     typing `opencode` in the Session terminal inherited no such var and ran
 *     with autoupdate ON — a plain `pnpm add -g` that skips the postinstall,
 *     leaves a 479-byte launcher stub and dangles /opt/kortix/opencode.current.
 *     That is the 2026-08-22 / 2026-08-25 incident shape. The global
 *     config file is read by every invocation, and (verified against opencode
 *     1.18.23) it is still loaded even when OPENCODE_CONFIG names another file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { OPENCODE_VERSION } from '../../runtime-versions';
import { kortixArtifactLayer, kortixToolchainLayer } from '../dockerfile-layer';
import { buildMetaSandboxDockerfile } from '../meta-dockerfile';
import {
  SANDBOX_CLI_OWNERSHIP_COMMAND,
  SANDBOX_OPENCODE_GLOBAL_CONFIG_COMMAND,
  SANDBOX_OPENCODE_GLOBAL_CONFIG_PATH,
} from '../platform-binaries';

const repoFile = (path: string) =>
  readFileSync(resolve(import.meta.dir, '../../../../..', path), 'utf8');

const ARTIFACTS = kortixArtifactLayer({
  agentBinaryPath: 'kortix-agent.gz',
  cliBinaryPath: 'kortix.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  machineDocPath: 'MACHINE.md',
  slackCliPath: 'kortix-slack-cli',
  catalogPath: 'llm-catalog.json',
});

/** One entry per image definition that must own its binaries. */
const IMAGES: Array<{ label: string; dockerfile: string }> = [
  {
    label: 'standard layer (platform default + custom templates)',
    dockerfile: kortixToolchainLayer({ opencodeVersion: OPENCODE_VERSION }) + ARTIFACTS,
  },
  {
    label: 'meta-agent image',
    dockerfile: buildMetaSandboxDockerfile({
      agentBinaryPath: 'a',
      cliBinaryPath: 'a',
      entrypointScriptPath: 'a',
      catalogPath: 'a',
      managedSkillsPath: 'a',
    }),
  },
  {
    label: 'apps/sandbox/Dockerfile',
    dockerfile: repoFile('apps/sandbox/Dockerfile'),
  },
];

describe('platform-owned binaries', () => {
  test('the ownership command hands the daemon the DIRECTORY, not just the file', () => {
    // rename(2) into /usr/local/bin needs write+execute on the directory.
    expect(SANDBOX_CLI_OWNERSHIP_COMMAND).toContain('chown kortix:kortix /usr/local/bin');
    // E2B's Dockerfile parser cannot read heredocs or embedded newlines.
    expect(SANDBOX_CLI_OWNERSHIP_COMMAND).not.toContain('<<');
    expect(SANDBOX_CLI_OWNERSHIP_COMMAND).not.toContain('\n');
  });

  test('the global OpenCode config pins autoupdate off at the path opencode reads', () => {
    expect(SANDBOX_OPENCODE_GLOBAL_CONFIG_PATH).toBe(
      '/home/kortix/.config/opencode/opencode.json',
    );
    expect(SANDBOX_OPENCODE_GLOBAL_CONFIG_COMMAND).toContain('"autoupdate":false');
    expect(SANDBOX_OPENCODE_GLOBAL_CONFIG_COMMAND).toContain(
      SANDBOX_OPENCODE_GLOBAL_CONFIG_PATH,
    );
    expect(SANDBOX_OPENCODE_GLOBAL_CONFIG_COMMAND).not.toContain('<<');
    expect(SANDBOX_OPENCODE_GLOBAL_CONFIG_COMMAND).not.toContain('\n');
  });

  for (const { label, dockerfile } of IMAGES) {
    test(`${label} lets the daemon replace /usr/local/bin/kortix`, () => {
      expect(dockerfile).toContain(SANDBOX_CLI_OWNERSHIP_COMMAND);
    });

    test(`${label} bakes the global opencode.json with autoupdate off`, () => {
      expect(dockerfile).toContain(SANDBOX_OPENCODE_GLOBAL_CONFIG_COMMAND);
    });
  }
});
