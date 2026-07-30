import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import {
  CompileRuntimeConfigError,
  compileRuntimeConfig,
  syntheticLegacyRuntimeConfig,
} from './compile-runtime-config';

const manifest = parseYaml(`
kortix_version: 3
default_agent: kortix
runtimes:
  claude:
    harness: claude
    config_dir: custom/claude
  codex:
    harness: codex
agents:
  kortix:
    runtime: claude
    connectors: all
    secrets: [ANTHROPIC]
    skills: all
    kortix_cli: none
  reviewer:
    runtime: codex
    agent: reviewer
    skills: [code-review]
    workspace: read
`) as Record<string, unknown>;

describe('compileRuntimeConfig', () => {
  test('compiles v3 into a runtime-neutral ACP launch plan', () => {
    expect(compileRuntimeConfig(manifest)).toEqual({
      kind: 'acp',
      version: 3,
      defaultAgent: 'kortix',
      runtimes: {
        claude: { name: 'claude', harness: 'claude', configDir: 'custom/claude' },
        codex: { name: 'codex', harness: 'codex', configDir: '.codex' },
      },
      agents: {
        kortix: {
          name: 'kortix',
          runtime: 'claude',
          harness: 'claude',
          nativeAgent: null,
          enabled: true,
          connectors: 'all',
          secrets: ['ANTHROPIC'],
          skills: 'all',
          kortixCli: 'none',
          workspace: 'runtime',
        },
        reviewer: {
          name: 'reviewer',
          runtime: 'codex',
          harness: 'codex',
          nativeAgent: 'reviewer',
          enabled: true,
          connectors: 'none',
          secrets: 'none',
          skills: ['code-review'],
          kortixCli: 'none',
          workspace: 'read',
        },
      },
    });
  });

  test('maps v2 to one OpenCode ACP runtime', () => {
    const plan = compileRuntimeConfig(
      parseYaml(`
kortix_version: 2
default_agent: kortix
agents:
  kortix: {}
`) as Record<string, unknown>,
    );
    expect(plan).toMatchObject({
      kind: 'acp',
      version: 2,
      defaultAgent: 'kortix',
      runtimes: { opencode: { harness: 'opencode', configDir: '.kortix/opencode' } },
      agents: { kortix: { runtime: 'opencode', harness: 'opencode' } },
    });
  });

  test('rejects broken v3 cross references even without prior validation', () => {
    const broken = parseYaml(`
kortix_version: 3
default_agent: x
runtimes:
  codex: { harness: codex }
agents:
  x: { runtime: missing }
`) as Record<string, unknown>;
    expect(() => compileRuntimeConfig(broken)).toThrow(CompileRuntimeConfigError);
  });

  test('keeps a synthetic OpenCode compatibility plan', () => {
    expect(syntheticLegacyRuntimeConfig()).toMatchObject({
      kind: 'acp',
      version: 2,
      defaultAgent: 'kortix',
      agents: { kortix: { harness: 'opencode', secrets: 'all' } },
    });
  });
});
