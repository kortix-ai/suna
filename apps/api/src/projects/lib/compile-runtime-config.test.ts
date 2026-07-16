import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import {
  CompileRuntimeConfigError,
  compileRuntimeConfig,
  syntheticLegacyRuntimeConfig,
  type CompiledRuntimeConfig,
} from './compile-runtime-config';

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__');

function readExpected(name: string): CompiledRuntimeConfig {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as CompiledRuntimeConfig;
}

function readManifestYaml(name: string): Record<string, unknown> {
  return parseYaml(readFileSync(join(FIXTURES_DIR, name), 'utf8')) as Record<string, unknown>;
}

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

  test('v2 with no agents map compiles to the fully-granted legacy OpenCode plan', () => {
    const plan = compileRuntimeConfig(parseYaml(`
kortix_version: 2
`) as Record<string, unknown>);
    expect(plan).toMatchObject({
      kind: 'acp', version: 2, defaultAgent: 'kortix',
      runtimes: { opencode: { harness: 'opencode', configDir: '.kortix/opencode' } },
      agents: {
        kortix: {
          runtime: 'opencode', harness: 'opencode', nativeAgent: null, enabled: true,
          connectors: 'all', secrets: 'all', skills: 'all', kortixCli: 'all',
        },
      },
    });
  });

  test('v2 with no agents map keeps a custom opencode config_dir', () => {
    const plan = compileRuntimeConfig(parseYaml(`
kortix_version: 2
opencode:
  config_dir: tools/opencode
`) as Record<string, unknown>);
    expect(plan?.runtimes.opencode.configDir).toBe('tools/opencode');
  });

  test('v2 default_agent naming a missing agent falls back to the first enabled agent', () => {
    const plan = compileRuntimeConfig(parseYaml(`
kortix_version: 2
default_agent: ghost
agents:
  disabled-one: { enabled: false }
  support: {}
`) as Record<string, unknown>);
    expect(plan?.defaultAgent).toBe('support');
  });

  test('v2 with agents but none enabled still refuses to compile', () => {
    const broken = parseYaml(`
kortix_version: 2
agents:
  off: { enabled: false }
`) as Record<string, unknown>;
    expect(() => compileRuntimeConfig(broken)).toThrow(CompileRuntimeConfigError);
  });

  test('syntheticLegacyRuntimeConfig is the no-manifest boot contract', () => {
    expect(syntheticLegacyRuntimeConfig()).toMatchObject({
      kind: 'acp', version: 2, defaultAgent: 'kortix',
      agents: { kortix: { harness: 'opencode', nativeAgent: null, secrets: 'all' } },
    });
  });
});

/**
 * Golden compile-output fixtures — v1/v2/v3 backwards-compat guard.
 *
 * A diff here means the compiler's output changed for existing projects;
 * that is a breaking change unless explicitly intended (see cycle plan
 * WS1-P3-a). These fixtures freeze TODAY's compileRuntimeConfig /
 * syntheticLegacyRuntimeConfig output so a later refactor (WS2-P0-a moving
 * this file onto the shared HARNESSES descriptor) can prove byte-identical
 * launch plans for existing projects instead of just "the tests still pass".
 */
describe('golden compile-output fixtures (v1/v2/v3 backwards-compat guard)', () => {
  test('v1 legacy: syntheticLegacyRuntimeConfig() matches the frozen golden plan', () => {
    const plan = syntheticLegacyRuntimeConfig();
    expect(plan).toEqual(readExpected('compile-v1-legacy.expected.json'));
  });

  test('v2 agents manifest compiles to the frozen golden plan', () => {
    const manifest = readManifestYaml('compile-v2-agents.manifest.yaml');
    const plan = compileRuntimeConfig(manifest);
    expect(plan).toEqual(readExpected('compile-v2-agents.expected.json'));
  });

  test('v3 multi-harness manifest compiles to the frozen golden plan', () => {
    const manifest = readManifestYaml('compile-v3-multi.manifest.yaml');
    const plan = compileRuntimeConfig(manifest);
    expect(plan).toEqual(readExpected('compile-v3-multi.expected.json'));
  });
});
