import { describe, expect, test } from 'bun:test';
import { validateManifest } from '../index.ts';
import { buildManifestV2Schema } from '../json-schema.ts';

// `subprojects:` — a Claude/ChatGPT-style project inside a Kortix project: a
// slug-keyed map of { name, description, instructions, context, agent, enabled }.
// A trigger may carry `subproject: <slug>` so its fired sessions land inside it.

const BASE = `
kortix_version: 2
default_agent: kortix
agents:
  kortix:
    connectors: all
  writer:
    connectors: none
`;

function errorsOf(yaml: string) {
  return validateManifest(yaml, 'yaml').issues.filter((i) => i.severity === 'error');
}

describe('subprojects: (v2)', () => {
  test('a valid map with every field passes', () => {
    const errors = errorsOf(`${BASE}
subprojects:
  marketing:
    name: Marketing
    description: Campaign work.
    instructions: |
      Always write in British English.
    context:
      - docs/brand.md
      - .kortix/subprojects/marketing/
    agent: writer
    sessions: shared
triggers:
  - slug: weekly
    type: cron
    cron: "0 0 9 * * 1"
    prompt: Draft the weekly update.
    subproject: marketing
`);
    expect(errors).toEqual([]);
  });

  test('rejects an invalid slug, a non-table block, and an unknown key', () => {
    const errors = errorsOf(`${BASE}
subprojects:
  Bad Slug: {}
  ok: "not a table"
  other:
    prompt: nope
`);
    expect(errors.map((e) => e.path).sort()).toEqual([
      'subprojects.Bad Slug',
      'subprojects.ok',
      'subprojects.other.prompt',
    ]);
  });

  test('rejects an unknown agent, a bad context path, and a non-string instructions', () => {
    const errors = errorsOf(`${BASE}
subprojects:
  a:
    agent: ghost
  b:
    context: ["../secrets.md", "/abs.md", ""]
  c:
    instructions: 42
  d:
    sessions: everyone
`);
    expect(errors.map((e) => e.path).sort()).toEqual([
      'subprojects.a.agent',
      'subprojects.b.context[0]',
      'subprojects.b.context[1]',
      'subprojects.b.context[2]',
      'subprojects.c.instructions',
      'subprojects.d.sessions',
    ]);
  });

  test('a trigger naming an undeclared subproject is an error', () => {
    const errors = errorsOf(`${BASE}
subprojects:
  a: {}
triggers:
  - slug: t
    type: cron
    cron: "0 0 9 * * 1"
    prompt: x
    subproject: nope
`);
    expect(errors.map((e) => e.path)).toEqual(['triggers[0].subproject']);
  });

  test('a list instead of a map is an error', () => {
    const errors = errorsOf(`${BASE}
subprojects:
  - a
`);
    expect(errors.map((e) => e.path)).toEqual(['subprojects']);
  });

  test('the JSON schema declares subprojects and the trigger ref', () => {
    const schema = buildManifestV2Schema() as any;
    expect(schema.properties.subprojects.additionalProperties.properties.instructions).toEqual({
      type: 'string',
    });
    expect(schema.properties.subprojects.additionalProperties.additionalProperties).toBe(false);
    expect(schema.properties.subprojects.additionalProperties.properties.sessions).toEqual({
      type: 'string',
      enum: ['private', 'shared'],
    });
    expect(schema.properties.subprojects.additionalProperties.properties.enabled).toBeUndefined();
    expect(schema.properties.triggers.items.properties.subproject).toEqual({
      type: 'string',
      minLength: 1,
    });
  });
});
