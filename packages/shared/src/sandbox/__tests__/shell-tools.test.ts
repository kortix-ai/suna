import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { OPENCODE_VERSION } from '../../runtime-versions';
import { kortixToolchainLayer } from '../dockerfile-layer';
import { buildMetaSandboxDockerfile } from '../meta-dockerfile';
import {
  SANDBOX_SHELL_TOOL_APT_LIST,
  SANDBOX_SHELL_TOOL_LINK_COMMAND,
  SANDBOX_SHELL_TOOL_PACKAGES,
} from '../shell-tools';

const repoFile = (path: string) =>
  readFileSync(resolve(import.meta.dir, '../../../../..', path), 'utf8');

// One entry per image definition that must carry the shell tool floor.
const IMAGES: Array<{ label: string; dockerfile: string }> = [
  {
    label: 'standard layer (platform default + custom templates)',
    dockerfile: kortixToolchainLayer({ opencodeVersion: OPENCODE_VERSION }),
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
    // Hand-maintained copy of the standard floor for the local self-host image.
    label: 'apps/sandbox/Dockerfile',
    dockerfile: repoFile('apps/sandbox/Dockerfile'),
  },
];

describe('shell tool floor', () => {
  test('the package list has no duplicates and stays sorted', () => {
    expect(new Set(SANDBOX_SHELL_TOOL_PACKAGES).size).toBe(SANDBOX_SHELL_TOOL_PACKAGES.length);
    expect([...SANDBOX_SHELL_TOOL_PACKAGES]).toEqual([...SANDBOX_SHELL_TOOL_PACKAGES].sort());
  });

  test('keeps the tools agents call by name', () => {
    for (const pkg of ['ripgrep', 'fd-find', 'bat', 'jq', 'fzf', 'tree', 'unzip', 'wget']) {
      expect(SANDBOX_SHELL_TOOL_PACKAGES).toContain(pkg as never);
    }
  });

  test('links Debian binary names to upstream names and proves the tools run', () => {
    expect(SANDBOX_SHELL_TOOL_LINK_COMMAND).toContain('ln -s "$(command -v fdfind)" /usr/local/bin/fd');
    expect(SANDBOX_SHELL_TOOL_LINK_COMMAND).toContain('ln -s "$(command -v batcat)" /usr/local/bin/bat');
    expect(SANDBOX_SHELL_TOOL_LINK_COMMAND).toContain('rg --version');
    // E2B's Dockerfile parser cannot read heredocs or escaped newlines in quotes.
    expect(SANDBOX_SHELL_TOOL_LINK_COMMAND).not.toContain('<<');
    expect(SANDBOX_SHELL_TOOL_LINK_COMMAND).not.toContain('\n');
  });

  for (const { label, dockerfile } of IMAGES) {
    test(`${label} installs the floor in its apt step and links fd/bat`, () => {
      const aptStep = dockerfile.slice(
        dockerfile.indexOf('apt-get install'),
        dockerfile.indexOf('rm -rf /var/lib/apt/lists/*'),
      );
      expect(aptStep).toContain(SANDBOX_SHELL_TOOL_APT_LIST);
      // The link command chains onto the same RUN, directly after the apt cleanup.
      expect(dockerfile).toMatch(
        /rm -rf \/var\/lib\/apt\/lists\/\*\s*(\\\n)?\s*&& \(command -v fd/,
      );
      expect(dockerfile).toContain(SANDBOX_SHELL_TOOL_LINK_COMMAND);
    });
  }
});
