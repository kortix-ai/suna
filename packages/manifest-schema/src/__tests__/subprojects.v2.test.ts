/**
 * Subprojects live in their own file — `kortix-<slug>.yaml`, a sibling of the
 * root manifest (spec 2026-09-06 §2). The root `subprojects:` map is gone.
 *
 * Three validators cover the model:
 *   - the root v2 validator REJECTS `subprojects:`,
 *   - `validateSubprojectFileV2` checks ONE file's shape (keys, types, its
 *     `agents:` map of blocks and `{ from }` references),
 *   - `validateManifestSetV2` checks everything only the whole set can know:
 *     duplicate agent names, `from` targets, `agent:`/`default_agent`
 *     defaults, and `triggers[].subproject`/`triggers[].agent`.
 */
import { describe, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import {
  isAgentReferenceV2,
  type ManifestIssue,
  type ManifestSetV2,
  SUBPROJECT_FILE_RE,
  subprojectFilePath,
  subprojectSlugFromPath,
  validateManifest,
  validateManifestSetV2,
  validateSubprojectFileV2,
} from '../index.ts';
import { buildManifestV2Schema, buildSubprojectFileV2Schema } from '../json-schema.ts';

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

/** Run the file validator and return `[issues, result]`. */
function checkFile(raw: unknown, slug = 'marketing', path?: string) {
  const issues: ManifestIssue[] = [];
  const result = validateSubprojectFileV2(raw, slug, issues, path ? { path } : undefined);
  return { issues, errors: issues.filter((i) => i.severity === 'error'), result };
}

function checkSet(set: ManifestSetV2) {
  const issues: ManifestIssue[] = [];
  validateManifestSetV2(set, issues);
  return issues.filter((i) => i.severity === 'error');
}

// ─── A. helpers ───────────────────────────────────────────────────────────

describe('subproject file naming helpers', () => {
  test('SUBPROJECT_FILE_RE captures the slug from a basename', () => {
    expect('kortix-marketing.yaml'.match(SUBPROJECT_FILE_RE)?.[1]).toBe('marketing');
    expect('kortix-go-to-market_2.yaml'.match(SUBPROJECT_FILE_RE)?.[1]).toBe('go-to-market_2');
  });

  test('SUBPROJECT_FILE_RE rejects the root manifest, .yml, and a bad slug', () => {
    for (const name of [
      'kortix.yaml',
      'kortix-marketing.yml',
      'kortix-Marketing.yaml',
      'kortix-.yaml',
      'kortix-marketing.backup.yaml',
      'kortix-marketing.yaml.bak',
      'notkortix-marketing.yaml',
    ]) {
      expect(SUBPROJECT_FILE_RE.test(name)).toBe(false);
    }
  });

  test('subprojectFilePath joins without a double slash', () => {
    expect(subprojectFilePath('', 'marketing')).toBe('kortix-marketing.yaml');
    expect(subprojectFilePath('apps/thing', 'marketing')).toBe('apps/thing/kortix-marketing.yaml');
    expect(subprojectFilePath('apps/thing/', 'marketing')).toBe('apps/thing/kortix-marketing.yaml');
  });

  test('subprojectSlugFromPath reads the basename, or null', () => {
    expect(subprojectSlugFromPath('kortix-marketing.yaml')).toBe('marketing');
    expect(subprojectSlugFromPath('apps/thing/kortix-marketing.yaml')).toBe('marketing');
    expect(subprojectSlugFromPath('kortix.yaml')).toBeNull();
    expect(subprojectSlugFromPath('deep/kortix-marketing.yml')).toBeNull();
    expect(subprojectSlugFromPath('')).toBeNull();
  });

  test('subprojectFilePath and subprojectSlugFromPath round-trip', () => {
    expect(subprojectSlugFromPath(subprojectFilePath('a/b', 'sales'))).toBe('sales');
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

// ─── B. one file ──────────────────────────────────────────────────────────

describe('validateSubprojectFileV2 — one kortix-<slug>.yaml', () => {
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
      'kortix-marketing.yaml',
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

  test('a non-table body is an error at the file path', () => {
    const { errors } = checkFile('nope', 'marketing', 'kortix-marketing.yaml');
    expect(errors.map((e) => e.path)).toEqual(['kortix-marketing.yaml']);
    const { errors: unpathed } = checkFile(null);
    expect(unpathed.map((e) => e.path)).toEqual(['marketing']);
  });

  test('a slug that is not a valid slug is an error', () => {
    const { errors } = checkFile({}, 'Bad Slug');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('not a valid subproject slug');
  });

  test('an unknown key is an error naming the allowed keys', () => {
    const { errors } = checkFile({ prompt: 'nope' }, 'marketing', 'kortix-marketing.yaml');
    expect(errors.map((e) => e.path)).toEqual(['kortix-marketing.yaml:prompt']);
    expect(errors[0]?.message).toContain('is not a subproject field');
  });

  test('kortix_version in a subproject file is an error', () => {
    const { errors } = checkFile({ kortix_version: 2 });
    expect(errors.map((e) => e.path)).toEqual(['kortix_version']);
    expect(errors[0]?.message).toContain("root manifest's version");
  });

  test('bad field types are errors', () => {
    const { errors } = checkFile({
      name: 5,
      description: [],
      sessions: 'everyone',
      agent: '',
    });
    expect(errors.map((e) => e.path).sort()).toEqual(['agent', 'description', 'name', 'sessions']);
  });

  // The two fields the 2026-09-07 simplification dropped. A file written when
  // they were valid must keep parsing — rejecting it would take its sessions
  // and its owned agents down with it — so they warn and are ignored.
  test('instructions and context are warnings, not errors', () => {
    const { issues, errors, result } = checkFile(
      { instructions: 'British English.', context: ['docs/brand.md'], agents: { writer: {} } },
      'marketing',
      'kortix-marketing.yaml',
    );
    expect(errors).toEqual([]);
    expect(issues.map((i) => [i.path, i.severity])).toEqual([
      ['kortix-marketing.yaml:instructions', 'warning'],
      ['kortix-marketing.yaml:context', 'warning'],
    ]);
    expect(issues[0]?.message).toContain('no longer a subproject field');
    // The rest of the file is still read.
    expect(result.owned).toEqual(['writer']);
  });

  test('issue paths carry the file prefix when one is given', () => {
    const { errors } = checkFile(
      { agents: { writer: { model: 'x' } } },
      'marketing',
      'kortix-marketing.yaml',
    );
    expect(errors.map((e) => e.path)).toEqual(['kortix-marketing.yaml:agents.writer.model']);
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
      'agents.Bad Name',
      'agents.ghost',
      'agents.legacy.env',
      'agents.writer.workspace',
    ]);
    // `ghost` is not a table and `Bad Name` is not a valid name — neither is owned.
    expect(result.owned).toEqual(['writer', 'legacy']);
  });

  test('a non-map agents is an error', () => {
    expect(checkFile({ agents: ['writer'] }).errors.map((e) => e.path)).toEqual(['agents']);
    expect(checkFile({ agents: 'writer' }).errors.map((e) => e.path)).toEqual(['agents']);
  });

  test('a reference may carry no other key', () => {
    const { errors, result } = checkFile({
      agents: { researcher: { from: 'research', connectors: ['slack'] } },
    });
    expect(errors.map((e) => e.path)).toEqual(['agents.researcher']);
    expect(errors[0]?.message).toContain('no other key');
    expect(result.referenced).toEqual([]);
  });

  test('an empty or non-string from is an error', () => {
    expect(checkFile({ agents: { a: { from: '' } } }).errors.map((e) => e.path)).toEqual([
      'agents.a.from',
    ]);
    expect(checkFile({ agents: { a: { from: 7 } } }).errors.map((e) => e.path)).toEqual([
      'agents.a.from',
    ]);
  });
});

// ─── C. the set ───────────────────────────────────────────────────────────

const ROOT = {
  kortix_version: 2,
  default_agent: 'kortix',
  agents: { kortix: { connectors: 'all' } },
};

function file(slug: string, raw: Record<string, unknown>) {
  return { slug, path: subprojectFilePath('', slug), raw };
}

describe('validateManifestSetV2 — cross-file rules', () => {
  test('a valid set passes', () => {
    expect(
      checkSet({
        root: {
          ...ROOT,
          triggers: [
            { slug: 'weekly', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', subproject: 'marketing', agent: 'writer' },
            { slug: 'daily', type: 'cron', cron: '0 0 9 * * *', prompt: 'y', agent: 'kortix' },
          ],
        },
        subprojects: [
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
      subprojects: [file('marketing', { agents: { kortix: {} } })],
    });
    expect(errors.map((e) => e.path)).toEqual(['kortix-marketing.yaml:agents.kortix']);
    expect(errors[0]?.message).toContain('kortix.yaml');
  });

  test('an agent declared in two files is a duplicate naming both', () => {
    const errors = checkSet({
      root: ROOT,
      subprojects: [file('marketing', { agents: { writer: {} } }), file('sales', { agents: { writer: {} } })],
    });
    expect(errors.map((e) => e.path)).toEqual(['kortix-sales.yaml:agents.writer']);
    expect(errors[0]?.message).toContain('kortix-marketing.yaml');
  });

  test('a duplicate slug in the set is an error', () => {
    const errors = checkSet({
      root: ROOT,
      subprojects: [file('marketing', {}), { slug: 'marketing', path: 'sub/kortix-marketing.yaml', raw: {} }],
    });
    expect(errors.map((e) => e.path)).toEqual(['sub/kortix-marketing.yaml']);
    expect(errors[0]?.message).toContain('already declared in kortix-marketing.yaml');
  });

  test('from must name an existing subproject', () => {
    const errors = checkSet({
      root: ROOT,
      subprojects: [file('marketing', { agents: { researcher: { from: 'ghost' } } })],
    });
    expect(errors.map((e) => e.path)).toEqual(['kortix-marketing.yaml:agents.researcher.from']);
    expect(errors[0]?.message).toContain('kortix-ghost.yaml');
  });

  test('from must name an agent OWNED there — not a reference, a global, or itself', () => {
    const errors = checkSet({
      root: ROOT,
      subprojects: [
        // `writer` is only referenced in research, not owned there.
        file('marketing', { agents: { writer: { from: 'research' }, kortix: { from: 'research' } } }),
        file('research', { agents: { writer: { from: 'design' }, self: { from: 'research' } } }),
        file('design', { agents: { writer: {} } }),
      ],
    });
    expect(errors.map((e) => e.path).sort()).toEqual([
      'kortix-marketing.yaml:agents.kortix.from',
      'kortix-marketing.yaml:agents.writer.from',
      'kortix-research.yaml:agents.self.from',
    ]);
    expect(errors.find((e) => e.path.includes('self'))?.message).toContain('itself');
  });

  test("a subproject's agent: must be global, owned, or referenced there", () => {
    const errors = checkSet({
      root: ROOT,
      subprojects: [
        file('marketing', { agent: 'designer' }),
        file('sales', { agent: 'kortix' }),
        file('design', { agent: 'designer', agents: { designer: {} } }),
        file('ads', { agent: 'designer', agents: { designer: { from: 'design' } } }),
      ],
    });
    expect(errors.map((e) => e.path)).toEqual(['kortix-marketing.yaml:agent']);
    expect(errors[0]?.message).toContain('not usable in subproject "marketing"');
  });

  test('default_agent must be a global agent', () => {
    const errors = checkSet({
      root: { ...ROOT, default_agent: 'writer' },
      subprojects: [file('marketing', { agents: { writer: {} } })],
    });
    expect(errors.map((e) => e.path)).toEqual(['default_agent']);
    expect(errors[0]?.message).toContain('marketing');
  });

  test('a trigger naming an undeclared subproject is an error', () => {
    const errors = checkSet({
      root: {
        ...ROOT,
        triggers: [{ slug: 't', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', subproject: 'ghost' }],
      },
      subprojects: [file('marketing', {})],
    });
    expect(errors.map((e) => e.path)).toEqual(['triggers[0].subproject']);
  });

  test("a trigger's agent must be usable in its subproject", () => {
    const errors = checkSet({
      root: {
        ...ROOT,
        triggers: [
          { slug: 'a', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', subproject: 'sales', agent: 'writer' },
          { slug: 'b', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', subproject: 'marketing', agent: 'writer' },
          { slug: 'c', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', subproject: 'sales', agent: 'kortix' },
        ],
      },
      subprojects: [file('marketing', { agents: { writer: {} } }), file('sales', {})],
    });
    expect(errors.map((e) => e.path)).toEqual(['triggers[0].agent']);
    expect(errors[0]?.message).toContain('not usable in subproject "sales"');
  });

  test('a project-level trigger may not use a subproject-owned agent', () => {
    const errors = checkSet({
      root: {
        ...ROOT,
        triggers: [{ slug: 'a', type: 'cron', cron: '0 0 9 * * 1', prompt: 'x', agent: 'writer' }],
      },
      subprojects: [file('marketing', { agents: { writer: {} } })],
    });
    expect(errors.map((e) => e.path)).toEqual(['triggers[0].agent']);
    expect(errors[0]?.message).toContain('marketing');
  });

  test('the set validator reports no shape issues — that is the file validator’s job', () => {
    const errors = checkSet({
      root: ROOT,
      subprojects: [file('marketing', { prompt: 'nope', agents: { writer: { model: 'x' } } })],
    });
    expect(errors).toEqual([]);
  });

  test('an empty set is valid', () => {
    expect(checkSet({ root: ROOT, subprojects: [] })).toEqual([]);
  });
});

// ─── D. the root manifest ─────────────────────────────────────────────────

describe('the root v2 manifest', () => {
  test('rejects a subprojects: key and names the file convention', () => {
    const errors = errorsOf(`${BASE}
subprojects:
  marketing:
    name: Marketing
`);
    expect(errors.map((e) => e.path)).toEqual(['subprojects']);
    expect(errors[0]?.message).toContain('kortix-<slug>.yaml');
  });

  test('rejects an empty subprojects: key too', () => {
    expect(errorsOf(`${BASE}\nsubprojects: {}\n`).map((e) => e.path)).toEqual(['subprojects']);
  });

  test('a trigger with a subproject no longer fails root validation on its scoped agent', () => {
    // `writer` is owned by kortix-marketing.yaml; the root cannot know that, so
    // the root validator leaves scoped triggers to `validateManifestSetV2`.
    const errors = errorsOf(`${BASE}
triggers:
  - slug: weekly
    type: cron
    cron: "0 0 9 * * 1"
    prompt: x
    subproject: marketing
    agent: writer
`);
    expect(errors).toEqual([]);
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

describe('the subproject-file JSON schema', () => {
  test('the v2 manifest schema no longer declares subprojects', () => {
    const schema = buildManifestV2Schema() as any;
    expect(schema.properties.subprojects).toBeUndefined();
    expect(schema.properties.triggers.items.properties.subproject).toEqual({
      type: 'string',
      minLength: 1,
    });
  });

  test('the file schema declares the block keys, forbids extras, and forbids kortix_version', () => {
    const schema = buildSubprojectFileV2Schema() as any;
    expect(schema.$id).toBe('https://kortix.com/schema/kortix-subproject.v2.schema.json');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.instructions).toEqual({ type: 'string', deprecated: true });
    expect(schema.properties.sessions).toEqual({ type: 'string', enum: ['private', 'shared'] });
    expect(schema.properties.kortix_version).toBe(false);
  });

  test('an agents entry is a block OR a { from } reference', () => {
    const schema = buildSubprojectFileV2Schema() as any;
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
      buildSubprojectFileV2Schema() as Record<string, unknown>,
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
