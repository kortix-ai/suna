import { describe, expect, test } from 'bun:test';
import { buildManifestV2Schema, SANDBOX_TYPES, validateManifest } from '../index.ts';

// `sandbox.type` chooses what a session's agent runs in: `worker` (a pi cell —
// a Durable Object on Platinum, no machine) or `vm` (a microVM from a sandbox
// template). It is the project's choice in kortix.yaml; the platform decides
// whether cells exist at all.
function v2(sandbox: string) {
  const result = validateManifest(`kortix_version: 2
default_agent: dev
agents:
  dev: {}
${sandbox}`, 'yaml');
  return {
    errors: result.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`),
    warnings: result.issues.filter((i) => i.severity === 'warning').map((i) => `${i.path}: ${i.message}`),
  };
}

describe('sandbox.type', () => {
  test('the two types are worker and vm', () => {
    expect([...SANDBOX_TYPES]).toEqual(['worker', 'vm']);
  });

  test('worker and vm are accepted', () => {
    expect(v2('sandbox:\n  type: worker\n').errors).toEqual([]);
    expect(v2('sandbox:\n  type: vm\n').errors).toEqual([]);
  });

  test('anything else is an error that names the field and the allowed values', () => {
    const { errors } = v2('sandbox:\n  type: cell\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('sandbox.type');
    expect(errors[0]).toContain('worker');
    expect(errors[0]).toContain('vm');
  });

  test('a worker project whose default is a custom image template is warned: a cell cannot boot an image', () => {
    const { errors, warnings } = v2(`sandbox:
  type: worker
  default: py
  templates:
    - slug: py
      image: python:3.12-slim
`);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.startsWith('sandbox.type') && w.includes('py'))).toBe(true);
  });

  test('the editor schema offers exactly the two types', () => {
    const schema = buildManifestV2Schema() as { properties: { sandbox: { properties: { type: { enum: string[] } } } } };
    expect(schema.properties.sandbox.properties.type.enum).toEqual(['worker', 'vm']);
  });
});
