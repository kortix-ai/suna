/**
 * The manifest half of subprojects: parse it, write it back, and prove a full
 * round-trip through the REAL YAML serializer — not a hand-built object graph.
 * A subproject that survives read → mutate → serialize → read is the whole
 * contract the CRUD routes depend on.
 */
import { describe, expect, test } from 'bun:test';
import {
  ClaimWarmProjectSessionInputSchema,
  SessionCreateInputSchema,
} from '@kortix/api-contract';

import {
  extractSubprojects,
  removeSubprojectFromManifest,
  stripSubprojectFromTriggers,
  subprojectSpecToEntry,
  upsertSubprojectInManifest,
  type SubprojectSpec,
} from './subprojects';
import {
  extractTriggers,
  parseManifestString,
  serializeManifest,
  triggerSpecToTomlEntry,
} from './triggers';
import { draftToSpec, specToBody, parseTriggerDraft } from './lib/triggers';

const YAML = `kortix_version: 2
default_agent: kortix
project:
  name: probe
agents:
  kortix:
    secrets: all
  writer:
    secrets: all
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
  research: {}
triggers:
  - slug: weekly
    type: cron
    agent: writer
    subproject: marketing
    cron: "0 0 9 * * 1"
    timezone: UTC
    prompt: Draft the weekly update.
  - slug: unrelated
    type: cron
    agent: kortix
    cron: "0 0 9 * * 2"
    timezone: UTC
    prompt: Something else.
`;

const parse = (raw: string) => parseManifestString(raw, 'yaml', 'kortix.yaml');

describe('extractSubprojects', () => {
  test('reads every declared field and defaults the rest', () => {
    const { specs, errors } = extractSubprojects(parse(YAML));
    expect(errors).toEqual([]);
    expect(specs.map((s) => s.slug)).toEqual(['marketing', 'research']);

    const marketing = specs[0]!;
    expect(marketing).toMatchObject({
      slug: 'marketing',
      path: 'kortix.yaml#subprojects.marketing',
      name: 'Marketing',
      description: 'Campaign work.',
      instructions: 'Always write in British English.\n',
      context: ['docs/brand.md', '.kortix/subprojects/marketing/'],
      agent: 'writer',
      sessions: 'shared',
    });

    // An empty block is legal: name defaults to the slug, sessions to private.
    expect(specs[1]).toMatchObject({
      slug: 'research',
      name: 'research',
      description: null,
      instructions: null,
      context: [],
      agent: null,
      sessions: 'private',
    });
  });

  test('a v1 manifest ignores the block instead of erroring', () => {
    const v1 = parseManifestString(
      'kortix_version = 1\n[project]\nname = "probe"\n',
      'toml',
      'kortix.toml',
    );
    v1.raw.subprojects = { marketing: {} };
    expect(extractSubprojects(v1)).toEqual({ specs: [], errors: [] });
  });

  test('a bad slug, a non-table block, a bad mode and a bad path each report, not throw', () => {
    const manifest = parse(YAML);
    manifest.raw.subprojects = {
      'Not A Slug': {},
      scalar: 'nope',
      mode: { sessions: 'public' },
      escape: { context: ['../secrets.env'] },
      absolute: { context: ['/etc/passwd'] },
    };
    const { specs, errors } = extractSubprojects(manifest);
    expect(specs).toEqual([]);
    expect(errors.map((e) => e.slug).sort()).toEqual([
      'Not A Slug',
      'absolute',
      'escape',
      'mode',
      'scalar',
    ]);
    expect(errors.find((e) => e.slug === 'mode')!.error).toContain('sessions must be one of');
    expect(errors.find((e) => e.slug === 'escape')!.path).toBe('kortix.yaml#subprojects.escape');
  });

  test('`subprojects` that is not a map is one top-level error', () => {
    const manifest = parse(YAML);
    manifest.raw.subprojects = ['marketing'];
    const { specs, errors } = extractSubprojects(manifest);
    expect(specs).toEqual([]);
    expect(errors).toEqual([
      {
        slug: '(top-level)',
        path: 'kortix.yaml',
        error: '`subprojects` must be a map of subproject slug → block.',
      },
    ]);
  });
});

describe('subprojectSpecToEntry', () => {
  test('emits only what deviates from the defaults', () => {
    const bare: SubprojectSpec = {
      slug: 'research',
      path: 'kortix.yaml#subprojects.research',
      name: 'research',
      description: null,
      instructions: null,
      context: [],
      agent: null,
      sessions: 'private',
    };
    expect(subprojectSpecToEntry(bare)).toEqual({});
  });
});

describe('upsert / remove / strip — round-trip through real YAML', () => {
  test('upsert then re-read keeps every field', () => {
    const spec: SubprojectSpec = {
      slug: 'sales',
      path: 'kortix.yaml#subprojects.sales',
      name: 'Sales',
      description: 'Pipeline.',
      instructions: 'Be concise.\n',
      context: ['docs/pricing.md'],
      agent: 'kortix',
      sessions: 'shared',
    };
    const next = upsertSubprojectInManifest(parse(YAML), spec);
    const reread = extractSubprojects(parse(serializeManifest(next)));
    expect(reread.errors).toEqual([]);
    expect(reread.specs.find((s) => s.slug === 'sales')).toEqual(spec);
    // The existing ones are untouched.
    expect(reread.specs.map((s) => s.slug)).toEqual(['marketing', 'research', 'sales']);
  });

  test('upsert replaces an existing slug rather than duplicating it', () => {
    const first = extractSubprojects(parse(YAML)).specs[0]!;
    const next = upsertSubprojectInManifest(parse(YAML), { ...first, name: 'Growth' });
    const reread = extractSubprojects(parse(serializeManifest(next)));
    expect(reread.specs.map((s) => s.slug)).toEqual(['marketing', 'research']);
    expect(reread.specs[0]!.name).toBe('Growth');
  });

  test('remove drops one, and drops the whole block with the last one', () => {
    const one = removeSubprojectFromManifest(parse(YAML), 'marketing');
    expect(extractSubprojects(parse(serializeManifest(one))).specs.map((s) => s.slug)).toEqual([
      'research',
    ]);

    const none = removeSubprojectFromManifest(one, 'research');
    expect(none.raw.subprojects).toBeUndefined();
    expect(serializeManifest(none)).not.toContain('subprojects');
    expect(extractSubprojects(parse(serializeManifest(none))).specs).toEqual([]);
  });

  test('remove of an unknown slug is a no-op', () => {
    const next = removeSubprojectFromManifest(parse(YAML), 'nope');
    expect(extractSubprojects(next).specs.map((s) => s.slug)).toEqual(['marketing', 'research']);
  });

  test('strip clears `subproject:` only from the triggers naming it', () => {
    const stripped = stripSubprojectFromTriggers(
      removeSubprojectFromManifest(parse(YAML), 'marketing'),
      'marketing',
    );
    const reread = parse(serializeManifest(stripped));
    expect(reread.raw.subprojects).toEqual({ research: {} });
    const triggers = extractTriggers(reread);
    expect(triggers.errors).toEqual([]);
    expect(triggers.specs.map((s) => [s.slug, s.subproject])).toEqual([
      ['unrelated', null],
      ['weekly', null],
    ]);
    expect(serializeManifest(stripped)).not.toContain('subproject: marketing');
  });
});

describe('trigger `subproject` round-trip', () => {
  test('parse → entry → parse keeps the slug, and omits the key when unset', () => {
    const specs = extractTriggers(parse(YAML)).specs;
    const weekly = specs.find((s) => s.slug === 'weekly')!;
    const unrelated = specs.find((s) => s.slug === 'unrelated')!;
    expect(weekly.subproject).toBe('marketing');
    expect(unrelated.subproject).toBeNull();

    const entry = triggerSpecToTomlEntry(weekly);
    expect(entry.subproject).toBe('marketing');
    expect(triggerSpecToTomlEntry(unrelated)).not.toHaveProperty('subproject');

    const manifest = parse(YAML);
    manifest.raw.triggers = [entry, triggerSpecToTomlEntry(unrelated)];
    const reparsed = extractTriggers(parse(serializeManifest(manifest))).specs;
    expect(reparsed.map((s) => [s.slug, s.subproject])).toEqual([
      ['unrelated', null],
      ['weekly', 'marketing'],
    ]);
  });

  test('a PATCH of an unrelated field keeps `subproject` (specToBody merge base)', () => {
    const weekly = extractTriggers(parse(YAML)).specs.find((s) => s.slug === 'weekly')!;
    const base = specToBody(weekly);
    expect(base.subproject).toBe('marketing');

    const draft = parseTriggerDraft({ ...base, enabled: false }, { existingSlug: 'weekly' });
    expect(draft).not.toHaveProperty('error');
    expect((draft as { subproject: string | null }).subproject).toBe('marketing');
    expect(draftToSpec(draft as never, 'kortix.yaml').subproject).toBe('marketing');
  });

  test('an explicit null or empty string clears it', () => {
    const weekly = extractTriggers(parse(YAML)).specs.find((s) => s.slug === 'weekly')!;
    for (const clear of [null, '']) {
      const draft = parseTriggerDraft(
        { ...specToBody(weekly), subproject: clear },
        { existingSlug: 'weekly' },
      );
      expect((draft as { subproject: string | null }).subproject).toBeNull();
    }
  });
});

/**
 * §5.6 — a warm session is never adopted for a subproject start. The server
 * half of that is a plain refusal: both warm bodies are `.strict()`, so a
 * `subproject` key is a 400 before any handler runs. Pinned here because the
 * rule is invisible in the route file.
 */
describe('warm session bodies refuse a subproject', () => {
  const SESSION_ID = '11111111-1111-4111-8111-111111111111';

  test('the claim body rejects it', () => {
    expect(ClaimWarmProjectSessionInputSchema.safeParse({ session_id: SESSION_ID }).success).toBe(
      true,
    );
    expect(
      ClaimWarmProjectSessionInputSchema.safeParse({
        session_id: SESSION_ID,
        subproject: 'marketing',
      }).success,
    ).toBe(false);
  });

  test('the create body ACCEPTS it — only the warm path refuses', () => {
    expect(SessionCreateInputSchema.safeParse({ subproject: 'marketing' }).success).toBe(true);
    expect(SessionCreateInputSchema.safeParse({ subproject: '' }).success).toBe(false);
  });
});
