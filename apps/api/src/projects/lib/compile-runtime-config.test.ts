import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import {
  CompileRuntimeConfigError,
  compileRuntimeConfig,
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

  test('uses native harness config defaults without inventing behavior files', () => {
    const plan = compileRuntimeConfig(parseYaml(`
kortix_version: 3
default_agent: open
runtimes:
  open: { harness: opencode }
  pi: { harness: pi }
agents:
  open: { runtime: open }
`) as Record<string, unknown>);
    expect(plan).toMatchObject({
      kind: 'acp',
      runtimes: {
        open: { configDir: '.kortix/opencode' },
        pi: { configDir: '.pi' },
      },
    });
  });

  test('maps v2 to an OpenCode ACP launch plan', () => {
    const plan = compileRuntimeConfig(parseYaml(`
kortix_version: 2
default_agent: kortix
agents:
  kortix: {}
`) as Record<string, unknown>);
    expect(plan).toMatchObject({
      kind: 'acp', version: 2, defaultAgent: 'kortix',
      runtimes: { opencode: { harness: 'opencode', configDir: '.kortix/opencode' } },
      agents: { kortix: { runtime: 'opencode', harness: 'opencode', nativeAgent: 'kortix' } },
    });
  });

  test('rejects broken v3 cross references even if a caller skipped validation', () => {
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

  test('returns null for v1 and unknown inputs', () => {
    expect(compileRuntimeConfig({ kortix_version: 1 })).toBeNull();
    expect(compileRuntimeConfig({})).toBeNull();
  });
});
