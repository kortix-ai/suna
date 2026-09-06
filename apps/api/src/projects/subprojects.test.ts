/**
 * Subprojects as files — `kortix-<slug>.yaml` beside the root manifest (spec
 * 2026-09-06). Pure parsing, the usability rule, and the file round-trip; the
 * git-backed loader is exercised by the SUBP flows against a real repo.
 */
import { describe, expect, test } from 'bun:test';
import {
  agentBlocksUsableIn,
  agentUsableIn,
  extractSubprojectsFromFiles,
  manifestDir,
  parseSubprojectFile,
  stripSubprojectFromTriggers,
  subprojectFileEntries,
  subprojectPathFor,
  subprojectSpecToFileEntry,
  usableAgentNames,
  type SubprojectSpec,
} from './subprojects';
import { mergeSubprojectAgents, type AgentSpec, type LoadedAgents } from './agents';
import { parseManifestText, serializeManifestObject } from '@kortix/manifest-schema';
import type { ParsedManifest } from './triggers';
import { draftToSpec, specToBody, parseTriggerDraft } from './lib/triggers';
import {
  ClaimWarmProjectSessionInputSchema,
  SessionCreateInputSchema,
} from '@kortix/api-contract';
import {
  extractTriggers,
  parseManifestString,
  serializeManifest,
  triggerSpecToTomlEntry,
} from './triggers';

const MARKETING = `
name: Marketing
description: Campaign work.
instructions: |
  Always write in British English.
context:
  - docs/brand.md
  - .kortix/subprojects/marketing/
agent: writer
sessions: shared
agents:
  writer:
    connectors: [slack]
    secrets: [BRAND_API_KEY]
  researcher:
    from: research
`;

function globalAgent(name: string): AgentSpec {
  return {
    name,
    path: `kortix.yaml#agents.${name}`,
    subproject: null,
    enabled: true,
    connectors: [],
    kortixCli: [],
    env: [],
    file: null,
    model: null,
    sandbox: null,
    workspace: null,
  };
}

function manifest(raw: Record<string, unknown>): ParsedManifest {
  return { schemaVersion: 2, raw, format: 'yaml', path: 'kortix.yaml' };
}

describe('file discovery', () => {
  test('manifestDir is the root manifest\'s directory, \'\' for the repo root', () => {
    expect(manifestDir('kortix.yaml')).toBe('');
    expect(manifestDir('./kortix.yaml')).toBe('');
    expect(manifestDir('config/kortix.yaml')).toBe('config');
    expect(manifestDir(null)).toBe('');
  });

  test('subprojectPathFor puts the file beside the root manifest', () => {
    expect(subprojectPathFor('kortix.yaml', 'marketing')).toBe('kortix-marketing.yaml');
    expect(subprojectPathFor('config/kortix.yaml', 'marketing')).toBe('config/kortix-marketing.yaml');
  });

  test('subprojectFileEntries keeps only kortix-<slug>.yaml in exactly that directory, sorted', () => {
    const entries = subprojectFileEntries(
      [
        'kortix.yaml',
        'kortix-research.yaml',
        'kortix-marketing.yaml',
        'kortix-marketing.yml',
        'nested/kortix-nope.yaml',
        'README.md',
      ],
      '',
    );
    expect(entries).toEqual([
      { slug: 'marketing', path: 'kortix-marketing.yaml' },
      { slug: 'research', path: 'kortix-research.yaml' },
    ]);
    expect(subprojectFileEntries(['config/kortix-ops.yaml', 'kortix-root.yaml'], 'config')).toEqual([
      { slug: 'ops', path: 'config/kortix-ops.yaml' },
    ]);
  });
});

describe('parseSubprojectFile', () => {
  test('reads every field, owned agents carry the owner, references are listed', () => {
    const result = parseSubprojectFile('marketing', 'kortix-marketing.yaml', MARKETING);
    if (!result.ok) throw new Error(result.error.error);
    const spec = result.spec;
    expect(spec.slug).toBe('marketing');
    expect(spec.path).toBe('kortix-marketing.yaml');
    expect(spec.name).toBe('Marketing');
    expect(spec.description).toBe('Campaign work.');
    expect(spec.instructions).toContain('British English');
    expect(spec.context).toEqual(['docs/brand.md', '.kortix/subprojects/marketing/']);
    expect(spec.agent).toBe('writer');
    expect(spec.sessions).toBe('shared');
    expect(spec.agents).toEqual(['writer', 'researcher']);
    expect(spec.ownedAgents.map((a) => a.name)).toEqual(['writer']);
    expect(spec.ownedAgents[0]?.subproject).toBe('marketing');
    expect(spec.ownedAgents[0]?.path).toBe('kortix-marketing.yaml#agents.writer');
    expect(spec.ownedAgents[0]?.connectors).toEqual(['slack']);
    expect(spec.references).toEqual([{ name: 'researcher', from: 'research' }]);
    expect(spec.agentsRaw).toEqual({
      writer: { connectors: ['slack'], secrets: ['BRAND_API_KEY'] },
      researcher: { from: 'research' },
    });
  });

  test('an empty file is a subproject with defaults', () => {
    const result = parseSubprojectFile('yo', 'kortix-yo.yaml', '');
    if (!result.ok) throw new Error(result.error.error);
    expect(result.spec).toMatchObject({
      name: 'yo',
      description: null,
      instructions: null,
      context: [],
      agent: null,
      sessions: 'private',
      agents: [],
      ownedAgents: [],
      references: [],
      agentsRaw: null,
    });
  });

  test('invalid YAML, a bad mode, a bad path, an unknown key and a bad slug each report with the file path, not throw', () => {
    const cases: Array<[string, string, string]> = [
      ['marketing', 'name: [unclosed', 'not valid YAML'],
      ['marketing', 'sessions: public', 'sessions'],
      ['marketing', 'context: ["../secrets"]', 'context'],
      ['marketing', 'instruction: oops', 'instruction'],
      ['Bad Slug', 'name: x', 'slug'],
      ['marketing', 'kortix_version: 2', 'kortix_version'],
    ];
    for (const [slug, text, needle] of cases) {
      const result = parseSubprojectFile(slug, 'kortix-marketing.yaml', text);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.path).toBe('kortix-marketing.yaml');
      expect(result.error.error.toLowerCase()).toContain(needle.toLowerCase());
    }
  });
});

describe('extractSubprojectsFromFiles', () => {
  test('specs and errors come back sorted by slug, and one bad file never hides the others', () => {
    const loaded = extractSubprojectsFromFiles([
      { slug: 'research', path: 'kortix-research.yaml', content: 'name: Research' },
      { slug: 'broken', path: 'kortix-broken.yaml', content: 'sessions: nope' },
      { slug: 'marketing', path: 'kortix-marketing.yaml', content: MARKETING },
    ]);
    expect(loaded.specs.map((s) => s.slug)).toEqual(['marketing', 'research']);
    expect(loaded.errors.map((e) => e.slug)).toEqual(['broken']);
    expect(loaded.errors[0]?.path).toBe('kortix-broken.yaml');
  });
});

describe('the usability rule', () => {
  const marketing = parseSubprojectFile('marketing', 'kortix-marketing.yaml', MARKETING);
  const research = parseSubprojectFile(
    'research',
    'kortix-research.yaml',
    'agents:\n  researcher:\n    connectors: []\n',
  );
  if (!marketing.ok || !research.ok) throw new Error('fixtures must parse');
  const specs = [marketing.spec, research.spec];
  const root: LoadedAgents = { specs: [globalAgent('kortix')], errors: [], defaultAgent: 'kortix' };
  const loaded = mergeSubprojectAgents(root, specs);

  test('mergeSubprojectAgents folds owned agents into the roster with their owner', () => {
    expect(loaded.specs.map((a) => `${a.name}@${a.subproject ?? 'root'}`)).toEqual([
      'kortix@root',
      'researcher@research',
      'writer@marketing',
    ]);
    expect(loaded.errors).toEqual([]);
    expect(loaded.defaultAgent).toBe('kortix');
  });

  test('a name declared twice is an error naming both places; the first declaration stays', () => {
    const clash = mergeSubprojectAgents(
      { specs: [globalAgent('writer')], errors: [], defaultAgent: null },
      [marketing.spec],
    );
    expect(clash.specs.map((a) => a.path)).toEqual(['kortix.yaml#agents.writer']);
    expect(clash.errors).toHaveLength(1);
    expect(clash.errors[0]?.error).toContain('kortix.yaml#agents.writer');
    expect(clash.errors[0]?.path).toBe('kortix-marketing.yaml#agents.writer');
  });

  test('globals everywhere; owned and referenced only in their subproject', () => {
    expect(usableAgentNames(loaded, null)).toEqual(['kortix']);
    expect(usableAgentNames(loaded, marketing.spec)).toEqual(['kortix', 'writer', 'researcher']);
    expect(usableAgentNames(loaded, research.spec)).toEqual(['kortix', 'researcher']);
    expect(agentUsableIn(loaded, null, 'writer')).toBe(false);
    expect(agentUsableIn(loaded, marketing.spec, 'writer')).toBe(true);
    expect(agentUsableIn(loaded, research.spec, 'writer')).toBe(false);
    expect(agentUsableIn(loaded, marketing.spec, 'researcher')).toBe(true);
  });

  test('agentBlocksUsableIn hands the compiler owned blocks plus the referenced owner\'s block', () => {
    expect(agentBlocksUsableIn(specs, null)).toEqual({});
    expect(agentBlocksUsableIn(specs, 'marketing')).toEqual({
      writer: { connectors: ['slack'], secrets: ['BRAND_API_KEY'] },
      researcher: { connectors: [] },
    });
    expect(agentBlocksUsableIn(specs, 'research')).toEqual({ researcher: { connectors: [] } });
    expect(agentBlocksUsableIn(specs, 'nope')).toEqual({});
  });
});

describe('file round-trip', () => {
  test('subprojectSpecToFileEntry emits only what deviates, and the agents map verbatim', () => {
    const parsed = parseSubprojectFile('marketing', 'kortix-marketing.yaml', MARKETING);
    if (!parsed.ok) throw new Error(parsed.error.error);
    const entry = subprojectSpecToFileEntry(parsed.spec);
    expect(Object.keys(entry)).toEqual([
      'name',
      'description',
      'instructions',
      'context',
      'agent',
      'sessions',
      'agents',
    ]);
    const minimal: SubprojectSpec = {
      ...parsed.spec,
      name: 'marketing',
      description: null,
      instructions: null,
      context: [],
      agent: null,
      sessions: 'private',
      agentsRaw: null,
    };
    expect(subprojectSpecToFileEntry(minimal)).toEqual({});
  });

  test('serialize → parse keeps every field', () => {
    const parsed = parseSubprojectFile('marketing', 'kortix-marketing.yaml', MARKETING);
    if (!parsed.ok) throw new Error(parsed.error.error);
    const text = serializeManifestObject(subprojectSpecToFileEntry(parsed.spec), 'yaml');
    const again = parseSubprojectFile('marketing', 'kortix-marketing.yaml', text);
    if (!again.ok) throw new Error(again.error.error);
    expect(again.spec).toEqual(parsed.spec);
    expect(parseManifestText(text, 'yaml').agents).toEqual(parsed.spec.agentsRaw);
  });

  test('strip clears `subproject:` only from the triggers naming it', () => {
    const m = manifest({
      kortix_version: 2,
      triggers: [
        { slug: 'a', subproject: 'marketing' },
        { slug: 'b', subproject: 'research' },
        { slug: 'c' },
      ],
    });
    const next = stripSubprojectFromTriggers(m, 'marketing');
    expect(next.raw.triggers).toEqual([{ slug: 'a' }, { slug: 'b', subproject: 'research' }, { slug: 'c' }]);
    // Untouched input.
    expect((m.raw.triggers as Array<Record<string, unknown>>)[0]?.subproject).toBe('marketing');
  });
});

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
