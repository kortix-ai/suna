import { describe, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import { parse as parseYaml } from 'yaml';

import { KORTIX_JSON_SCHEMA, KORTIX_V3_JSON_SCHEMA } from '../json-schema';
import { validateManifest } from '../index';

const VALID = `
kortix_version: 3
default_agent: kortix

runtimes:
  claude:
    harness: claude
    config_dir: .claude
  codex:
    harness: codex
    config_dir: .codex
  opencode:
    harness: opencode
    config_dir: .kortix/opencode

agents:
  kortix:
    runtime: claude
    skills: all
    connectors: all
    secrets: all
  reviewer:
    runtime: codex
    agent: reviewer
    skills: [code-review]
    connectors: [github]
`;

function errors(input: string): string[] {
  return validateManifest(input, 'yaml').issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.path);
}

describe('validateManifest — kortix_version 3', () => {
  test('accepts named ACP runtimes and logical agents', () => {
    expect(validateManifest(VALID, 'yaml')).toMatchObject({ valid: true });
  });

  test('requires YAML, runtimes, agents, and default_agent', () => {
    expect(validateManifest('kortix_version = 3', 'toml').valid).toBe(false);
    const paths = errors('kortix_version: 3\n');
    expect(paths).toContain('runtimes');
    expect(paths).toContain('agents');
    expect(paths).toContain('default_agent');
  });

  test('rejects unsupported harnesses and unsafe config directories', () => {
    const paths = errors(`
kortix_version: 3
default_agent: x
runtimes:
  x:
    harness: custom
    config_dir: ../outside
agents:
  x:
    runtime: x
`);
    expect(paths).toContain('runtimes.x.harness');
    expect(paths).toContain('runtimes.x.config_dir');
  });

  test('requires every logical agent runtime to resolve', () => {
    const paths = errors(`
kortix_version: 3
default_agent: x
runtimes:
  codex:
    harness: codex
agents:
  x:
    runtime: missing
`);
    expect(paths).toContain('agents.x.runtime');
  });

  test('rejects OpenCode-specific behavior and the v2 singular runtime', () => {
    const paths = errors(`
kortix_version: 3
default_agent: x
runtime: opencode
opencode:
  config_dir: .kortix/opencode
runtimes:
  codex:
    harness: codex
agents:
  x:
    runtime: codex
    model: gpt-5
    permission: allow
`);
    expect(paths).toContain('runtime');
    expect(paths).toContain('opencode');
    expect(paths).toContain('agents.x.model');
    expect(paths).toContain('agents.x.permission');
  });

  test('rejects a disabled or unknown default agent', () => {
    const disabled = errors(`
kortix_version: 3
default_agent: x
runtimes:
  codex: { harness: codex }
agents:
  x: { runtime: codex, enabled: false }
`);
    expect(disabled).toContain('default_agent');
    expect(errors(VALID.replace('default_agent: kortix', 'default_agent: missing'))).toContain(
      'default_agent',
    );
  });

  test('publishes matching standalone and combined JSON schemas', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    expect(ajv.compile(KORTIX_V3_JSON_SCHEMA as Record<string, unknown>)(parseYaml(VALID))).toBe(true);
    expect(ajv.compile(KORTIX_JSON_SCHEMA as Record<string, unknown>)(parseYaml(VALID))).toBe(true);
  });
});
