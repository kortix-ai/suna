import { describe, expect, test } from 'bun:test';
import { agentConfigCreateConflict } from './agent-config-create-only';
import type { ParsedManifest } from '../triggers';

const manifest: ParsedManifest = {
  schemaVersion: 3,
  format: 'yaml',
  path: 'kortix.yaml',
  raw: { kortix_version: 3, agents: { support: { description: 'Existing agent' } } },
};

describe('agent config create-only precondition', () => {
  test('refuses an existing agent without changing its manifest', () => {
    const before = structuredClone(manifest);
    expect(agentConfigCreateConflict(manifest, 'support', '*')).toBe(true);
    expect(manifest).toEqual(before);
  });

  test('allows an absent name and preserves ordinary upserts', () => {
    expect(agentConfigCreateConflict(manifest, 'new-agent', '*')).toBe(false);
    expect(agentConfigCreateConflict(manifest, 'support', undefined)).toBe(false);
    expect(agentConfigCreateConflict(manifest, 'support', '"revision"')).toBe(false);
  });
});

test('invalid existing declarations remain protected from create-only writes', () => {
  for (const declaration of [null, { file: '../../secret.md' }]) {
    expect(agentConfigCreateConflict({ ...manifest, raw: { kortix_version: 3, agents: { support: declaration } } }, 'support', '*')).toBe(true);
  }
});
