/**
 * Every space lives in the root manifest under `spaces:`, keyed by slug
 * (user, 2026-09-08: "keep everything in one file"). The per-space
 * `kortix-<slug>.yaml` sibling file is gone, and with it the whole
 * multi-file set model.
 *
 * Two validators cover the model:
 *   - `validateSpaceEntryV2` checks ONE `spaces.<slug>` block's shape (keys,
 *     types, its `agents:` map of blocks and `{ from }` references),
 *   - `validateSpacesV2` runs that over every block and then adds what only
 *     the whole map can know: duplicate agent names, `from` targets,
 *     `agent:`/`default_agent` defaults, and `triggers[].space`/`[].agent`.
 *     The root v2 validator calls it, so `validateManifest` sees all of it.
 */
import { describe, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import {
  isAgentReferenceV2,
  type ManifestIssue,
  spacePath,
  validateManifest,
  validateSpaceEntryV2,
  validateSpacesV2,
  validateTriggerSpaceRefsV2,
} from '../index.ts';
import { buildManifestV2Schema, buildSpaceV2Schema } from '../json-schema.ts';

const BASE = `
kortix_version: 2
default_agent: kortix
agents:
  kortix:
    connectors: all
`;

function errorsOf(yaml: string) {
  return validateManifest(yaml, 'yaml').issues.filter((i) => i.severity === 'error');
}

/** Run the single-space validator and return `[issues, result]`. Every issue
 *  path is rooted at `spaces.<slug>`, so no path argument is needed. */
function checkFile(raw: unknown, slug = 'marketing') {
  const issues: ManifestIssue[] = [];
  const result = validateSpaceEntryV2(raw, slug, issues);
  return { issues, errors: issues.filter((i) => i.severity === 'error'), result };
}

/** Fold the old set shape onto one root manifest and validate it. The `path`
 *  each entry used to carry is now derived (`spaces.<slug>`), so it is
 *  accepted and ignored — a slug is the whole identity now. */
function checkSet(set: {
  root: Record<string, unknown>;
  spaces: Array<{ slug: string; path?: string; raw: unknown }>;
}) {
  const issues: ManifestIssue[] = [];
  const spaces: Record<string, unknown> = {};
  for (const entry of set.spaces) spaces[entry.slug] = entry.raw;
  validateSpacesV2({ ...set.root, spaces }, issues);
  return issues.filter((i) => i.severity === 'error');
}

// ─── A. helpers ───────────────────────────────────────────────────────────

describe('space helpers', () => {
  test('spacePath points at the block inside the root manifest', () => {
    expect(spacePath('marketing')).toBe('spaces.marketing');
    expect(spacePath('go-to-market_2')).toBe('spaces.go-to-market_2');
  });

  test('isAgentReferenceV2 is true only for a lone non-empty `from`', () => {
    expect(isAgentReferenceV2({ from: 'research' })).toBe(true);
    expect(isAgentReferenceV2({ from: 'research', connectors: 'all' })).toBe(false);
    expect(isAgentReferenceV2({ from: '' })).toBe(false);
    expect(isAgentReferenceV2({ from: 2 })).toBe(false);
    expect(isAgentReferenceV2({})).toBe(false);
    expect(isAgentReferenceV2({ connectors: 'all' })).toBe(false);
    expect(isAgentReferenceV2(null)).toBe(false);
    expect(isAgentReferenceV2(['from'])).toBe(false);
    expect(isAgentReferenceV2('from')).toBe(false);
  });
});

// The pre-2026-09-07 spelling of `triggers[].space`. A manifest written before
// the rename keeps its scoping — the loader reads it — and validation says so.
describe('a trigger still written with `subproject:`', () => {
  const issues: ManifestIssue[] = [];
  validateTriggerSpaceRefsV2(
    [{ slug: 'weekly', subproject: 'marketing' }, { slug: 'other', subproject: 'gone' }],
    'triggers',
    ['marketing'],
    issues,
  );

  test('is a warning naming the old key, not an error', () => {
    const first = issues.filter((i) => i.path === 'triggers[0].subproject');
    expect(first).toHaveLength(1);
    expect(first[0]?.severity).toBe('warning');
    expect(first[0]?.message).toContain('renamed to `space`');
  });

  test('is still checked against the declared set', () => {
    const bad = issues.filter((i) => i.path === 'triggers[1].subproject' && i.severity === 'error');
    expect(bad).toHaveLength(1);
    expect(bad[0]?.message).toContain('does not match any declared space');
  });
});

// ─── B. one file ──────────────────────────────────────────────────────────

describe('validateSpaceEntryV2 — one spaces.<slug> block', () => {
  test('a file with every field passes and reports its agents', () => {
    const { errors, result } = checkFile(
      {
        name: 'Marketing',
        description: 'Campaign work.',
        agent: 'writer',
        sessions: 'shared',
        agents: {
          writer: { connectors: ['slack'], secrets: ['BRAND_API_KEY'] },
          researcher: { from: 'research' },
        },
      },
      'marketing',
    );
    expect(errors).toEqual([]);
    expect(result.owned).toEqual(['writer']);
    expect(result.referenced).toEqual([{ name: 'researcher', from: 'research' }]);
  });

  test('an empty file body is valid and owns nothing', () => {
    const { errors, result } = checkFile({});
    expect(errors).toEqual([]);
    expect(result).toEqual({ owned: [], referenced: [] });
  });

  test('a non-table body is an error at the space block', () => {
    expect(checkFile('nope', 'marketing').errors.map((e) => e.path)).toEqual(['spaces.marketing']);
    expect(checkFile(['a']).errors.map((e) => e.path)).toEqual(['spaces.marketing']);
  });

  // `marketing:` with no body — the natural YAML for a space with no settings,
  // and what the empty `kortix-marketing.yaml` file used to be.
  test('an empty block written as a bare key is valid', () => {
    const { errors, result } = checkFile(null);
    expect(errors).toEqual([]);
    expect(result).toEqual({ owned: [], referenced: [] });
    expect(errorsOf(`${BASE}\nspaces:\n  marketing:\n`)).toEqual([]);
  });

  test('a slug that is not a valid slug is an error', () => {
    const { errors } = checkFile({}, 'Bad Slug');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('not a valid space slug');
  });

  test('an unknown key is an error naming the allowed keys', () => {
    const { errors } = checkFile({ prompt: 'nope' }, 'marketing');
    expect(errors.map((e) => e.path)).toEqual(['spaces.marketing.prompt']);
    expect(errors[0]?.message).toContain('is not a space field');
  });

  test('kortix_version in a space block is an error', () => {
    const { errors } = checkFile({ kortix_version: 2 });
    expect(errors.map((e) => e.path)).toEqual(['spaces.marketing.kortix_version']);
    expect(errors[0]?.message).toContain("root manifest's version");
  });

  test('bad field types are errors', () => {
    const { errors } = checkFile({
      name: 5,
      description: [],
      sessions: 'everyone',
      agent: '',
    });
    expect(errors.map((e) => e.path).sort()).toEqual([
      'spaces.marketing.agent',
      'spaces.marketing.description',
      'spaces.marketing.name',
      'spaces.marketing.sessions',
    ]);
  });

  // The two fields the 2026-09-07 simplification dropped. A file written when
  // they were valid must keep parsing — rejecting it would take its sessions
  // and its owned agents down with it — so they warn and are ignored.
  test('instructions and context are warnings, not errors', () => {
    const { issues, errors, result } = checkFile(
      { instructions: 'British English.', context: ['docs/brand.md'], agents: { writer: {} } },
      'marketing',
    );
    expect(errors).toEqual([]);
    expect(issues.map((i) => [i.path, i.severity])).toEqual([
      ['spaces.marketing.instructions', 'warning'],
      ['spaces.marketing.context', 'warning'],
    ]);
    expect(issues[0]?.message).toContain('no longer a space field');
    // The rest of the file is still read.
    expect(result.owned).toEqual(['writer']);
  });

  test('issue paths are rooted at the space block', () => {
    const { errors } = checkFile(
      { agents: { writer: { model: 'x' } } },
      'marketing',
    );
    expect(errors.map((e) => e.path)).toEqual(['spaces.marketing.agents.writer.model']);
  });

  test('an agents entry is validated as a full agent block', () => {
    const { errors, result } = checkFile({
      agents: {
        writer: { connectors: 'all', workspace: 'nope' },
        ghost: 'not a table',
        'Bad Name': {},
        legacy: { env: ['A'] },
      },
    });
    expect(errors.map((e) => e.path).sort()).toEqual([
      'spaces.marketing.agents.Bad Name',
      'spaces.marketing.agents.ghost',
      'spaces.marketing.agents.legacy.env',
      'spaces.marketing.agents.writer.workspace',
    ]);
    // `ghost` is not a table and `Bad Name` is not a valid name — neither is owned.
    expect(result.owned).toEqual(['writer', 'legacy']);
  });

  test('a non-map agents is an error', () => {
    expect(checkFile({ agents: ['writer'] }).errors.map((e) => e.path)).toEqual(['spaces.marketing.agents']);
    expect(checkFile({ agents: 'writer' }).errors.map((e) => e.path)).toEqual(['spaces.marketing.agents']);
  });

  test('a reference may carry no other key', () => {
    const { errors, result } = checkFile({
      agents: { researcher: { from: 'research', connectors: ['slack'] } },
    });
    expect(errors.map((e) => e.path)).toEqual(['spaces.marketing.agents.researcher']);
    expect(errors[0]?.message).toContain('no other key');
    expect(result.referenced).toEqual([]);
  });

  test('an empty or non-string from is an error', () => {
    expect(checkFile({ agents: { a: { from: '' } } }).errors.map((e) => e.path)).toEqual([
      'spaces.marketing.agents.a.from',
    ]);
    expect(checkFile({ agents: { a: { from: 7 } } }).errors.map((e) => e.path)).toEqual([
      'spaces.marketing.agents.a.from',
    ]);
  });
});

// ─── C. the whole map ─────────────────────────────────────────────────────

const ROOT = {
  kortix_version: 2,
  default_agent: 'kortix',
  agents: { kortix: { connectors: 'all' } },
};

function file(slug: string, raw: Record<string, unknown>) {
  return { slug, path: spacePath(slug), raw };
}

describe('validateSpacesV2 — cross-space rules', () => {
  test('a valid set passes', () => {
    expect(
      checkSet({
        root: {
          ...ROOT,
          triggers: [
            { slug: 'weekly', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', space: 'marketing', agent: 'writer' },
            { slug: 'daily', type: 'cron', cron: '0 0 9 * * *', prompt: 'y', agent: 'kortix' },
          ],
        },
        spaces: [
          file('marketing', {
            agent: 'writer',
            agents: { writer: { connectors: ['slack'] }, researcher: { from: 'research' } },
          }),
          file('research', { agent: 'kortix', agents: { researcher: {} } }),
        ],
      }),
    ).toEqual([]);
  });

  test('an agent declared in the root and in a file is a duplicate naming both', () => {
    const errors = checkSet({
      root: ROOT,
      spaces: [file('marketing', { agents: { kortix: {} } })],
    });
    expect(errors.map((e) => e.path)).toEqual(['spaces.marketing.agents.kortix']);
    expect(errors[0]?.message).toContain('already declared in agents');
  });

  test('an agent declared in two files is a duplicate naming both', () => {
    const errors = checkSet({
      root: ROOT,
      spaces: [file('marketing', { agents: { writer: {} } }), file('sales', { agents: { writer: {} } })],
    });
    expect(errors.map((e) => e.path)).toEqual(['spaces.sales.agents.writer']);
    expect(errors[0]?.message).toContain('spaces.marketing.agents');
  });

  // Two files could both claim `marketing`; two keys of one YAML map cannot.
  // The parser collapses the repeat before a validator ever sees it, so the
  // whole duplicate-slug error class went away with the per-space file.
  test('a slug cannot be declared twice — YAML itself rejects the repeat', () => {
    const errors = errorsOf(
      `${BASE}\nspaces:\n  marketing:\n    name: First\n  marketing:\n    name: Second\n`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('Map keys must be unique');
  });

  test('from must name an existing space', () => {
    const errors = checkSet({
      root: ROOT,
      spaces: [file('marketing', { agents: { researcher: { from: 'ghost' } } })],
    });
    expect(errors.map((e) => e.path)).toEqual(['spaces.marketing.agents.researcher.from']);
    expect(errors[0]?.message).toContain('spaces.ghost');
  });

  test('from must name an agent OWNED there — not a reference, a global, or itself', () => {
    const errors = checkSet({
      root: ROOT,
      spaces: [
        // `writer` is only referenced in research, not owned there.
        file('marketing', { agents: { writer: { from: 'research' }, kortix: { from: 'research' } } }),
        file('research', { agents: { writer: { from: 'design' }, self: { from: 'research' } } }),
        file('design', { agents: { writer: {} } }),
      ],
    });
    expect(errors.map((e) => e.path).sort()).toEqual([
      'spaces.marketing.agents.kortix.from',
      'spaces.marketing.agents.writer.from',
      'spaces.research.agents.self.from',
    ]);
    expect(errors.find((e) => e.path.includes('self'))?.message).toContain('itself');
  });

  test("a space's agent: must be global, owned, or referenced there", () => {
    const errors = checkSet({
      root: ROOT,
      spaces: [
        file('marketing', { agent: 'designer' }),
        file('sales', { agent: 'kortix' }),
        file('design', { agent: 'designer', agents: { designer: {} } }),
        file('ads', { agent: 'designer', agents: { designer: { from: 'design' } } }),
      ],
    });
    expect(errors.map((e) => e.path)).toEqual(['spaces.marketing.agent']);
    expect(errors[0]?.message).toContain('not usable in space "marketing"');
  });

  test('default_agent must be a global agent', () => {
    const errors = checkSet({
      root: { ...ROOT, default_agent: 'writer' },
      spaces: [file('marketing', { agents: { writer: {} } })],
    });
    expect(errors.map((e) => e.path)).toEqual(['default_agent']);
    expect(errors[0]?.message).toContain('marketing');
  });

  test('a trigger naming an undeclared space is an error', () => {
    const errors = checkSet({
      root: {
        ...ROOT,
        triggers: [{ slug: 't', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', space: 'ghost' }],
      },
      spaces: [file('marketing', {})],
    });
    expect(errors.map((e) => e.path)).toEqual(['triggers[0].space']);
  });

  test("a trigger's agent must be usable in its space", () => {
    const errors = checkSet({
      root: {
        ...ROOT,
        triggers: [
          { slug: 'a', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', space: 'sales', agent: 'writer' },
          { slug: 'b', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', space: 'marketing', agent: 'writer' },
          { slug: 'c', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', space: 'sales', agent: 'kortix' },
        ],
      },
      spaces: [file('marketing', { agents: { writer: {} } }), file('sales', {})],
    });
    expect(errors.map((e) => e.path)).toEqual(['triggers[0].agent']);
    expect(errors[0]?.message).toContain('not usable in space "sales"');
  });

  test('a project-level trigger may not use a space-owned agent', () => {
    const errors = checkSet({
      root: {
        ...ROOT,
        triggers: [{ slug: 'a', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', agent: 'writer' }],
      },
      spaces: [file('marketing', { agents: { writer: {} } })],
    });
    expect(errors.map((e) => e.path)).toEqual(['triggers[0].agent']);
    expect(errors[0]?.message).toContain('marketing');
  });

  // The two passes used to be separate functions over separate files, so the
  // set validator deliberately stayed silent on shape. One map in one file
  // means one pass: shape AND cross-space rules come back together.
  test('shape issues come back from the same pass', () => {
    const errors = checkSet({
      root: ROOT,
      spaces: [file('marketing', { prompt: 'nope', agents: { writer: { model: 'x' } } })],
    });
    expect(errors.map((e) => e.path).sort()).toEqual([
      'spaces.marketing.agents.writer.model',
      'spaces.marketing.prompt',
    ]);
  });

  test('an empty map is valid', () => {
    expect(checkSet({ root: ROOT, spaces: [] })).toEqual([]);
  });
});

// ─── D. the root manifest ─────────────────────────────────────────────────

describe('the root v2 manifest', () => {
  test('accepts a spaces: map and validates each block through it', () => {
    expect(
      errorsOf(`${BASE}
spaces:
  marketing:
    name: Marketing
    agents:
      writer: {}
`),
    ).toEqual([]);
    // …and the same pass reports a bad block, rooted at its slug.
    const bad = errorsOf(`${BASE}\nspaces:\n  marketing:\n    prompt: nope\n`);
    expect(bad.map((e) => e.path)).toEqual(['spaces.marketing.prompt']);
  });

  test('an empty spaces: key is valid', () => {
    expect(errorsOf(`${BASE}\nspaces: {}\n`)).toEqual([]);
  });

  test('a non-map spaces: is an error', () => {
    expect(errorsOf(`${BASE}\nspaces: [marketing]\n`).map((e) => e.path)).toEqual(['spaces']);
  });

  test('a trigger scoped to a space may use that space’s own agent', () => {
    // `writer` is owned by `spaces.marketing`, so the ONE root pass now sees
    // both the trigger and the agent that makes it legal.
    const errors = errorsOf(`${BASE}
spaces:
  marketing:
    agents:
      writer: {}
triggers:
  - slug: weekly
    type: cron
    cron: "0 0 9 * * 1"
    prompt: x
    space: marketing
    agent: writer
`);
    expect(errors).toEqual([]);
  });

  test('a trigger naming an undeclared space is now caught by the root pass', () => {
    const errors = errorsOf(`${BASE}
triggers:
  - slug: weekly
    type: cron
    cron: "0 0 9 * * 1"
    prompt: x
    space: ghost
`);
    expect(errors.map((e) => e.path)).toEqual(['triggers[0].space']);
  });

  test('a project-level trigger still needs a declared agent', () => {
    const errors = errorsOf(`${BASE}
triggers:
  - slug: weekly
    type: cron
    cron: "0 0 9 * * 1"
    prompt: x
    agent: ghost
`);
    expect(errors.map((e) => e.path)).toEqual(['triggers[0].agent']);
  });
});

// ─── E. JSON schema ───────────────────────────────────────────────────────

describe('the space JSON schema', () => {
  test('the v2 manifest schema declares spaces as a slug-keyed map', () => {
    const schema = buildManifestV2Schema() as any;
    expect(schema.properties.spaces.type).toBe('object');
    // The per-entry shape is the standalone space schema, minus its envelope.
    expect(schema.properties.spaces.additionalProperties.additionalProperties).toBe(false);
    expect(schema.properties.spaces.additionalProperties.properties.sessions).toEqual({
      type: 'string',
      enum: ['private', 'shared'],
    });
    expect(schema.properties.triggers.items.properties.space).toEqual({
      type: 'string',
      minLength: 1,
    });
  });

  test('the file schema declares the block keys, forbids extras, and forbids kortix_version', () => {
    const schema = buildSpaceV2Schema() as any;
    expect(schema.$id).toBe('https://kortix.com/schema/kortix-space.v2.schema.json');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.instructions).toEqual({ type: 'string', deprecated: true });
    expect(schema.properties.sessions).toEqual({ type: 'string', enum: ['private', 'shared'] });
    expect(schema.properties.kortix_version).toBe(false);
  });

  test('an agents entry is a block OR a { from } reference', () => {
    const schema = buildSpaceV2Schema() as any;
    const entry = schema.properties.agents.additionalProperties;
    expect(entry.oneOf).toHaveLength(2);
    expect(entry.oneOf[1]).toEqual({
      type: 'object',
      properties: { from: { type: 'string', minLength: 1 } },
      required: ['from'],
      additionalProperties: false,
    });
  });

  test('the file schema compiles and validates a real file', () => {
    const validate = new Ajv2020({ strict: false }).compile(
      buildSpaceV2Schema() as Record<string, unknown>,
    );
    expect(
      validate({
        name: 'Marketing',
        // Still accepted by the JSON Schema so an editor keeps validating an
        // older file; the imperative validator warns and the loader ignores it.
        context: ['docs/brand.md'],
        agent: 'writer',
        sessions: 'shared',
        agents: { writer: { connectors: ['slack'] }, researcher: { from: 'research' } },
      }),
    ).toBe(true);
    expect(validate({ kortix_version: 2 })).toBe(false);
    expect(validate({ prompt: 'nope' })).toBe(false);
    expect(validate({ agents: { researcher: { from: 'research', connectors: 'all' } } })).toBe(false);
    expect(validate({ sessions: 'everyone' })).toBe(false);
  });
});
