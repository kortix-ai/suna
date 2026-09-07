/**
 * Spaces as files — `kortix-<slug>.yaml` beside the root manifest (spec
 * 2026-09-06). Pure parsing, the usability rule, and the file round-trip; the
 * git-backed loader is exercised by the SUBP flows against a real repo.
 */
import { describe, expect, test } from 'bun:test';
import {
  agentBlocksUsableIn,
  agentUsableIn,
  extractSpacesFromFiles,
  manifestDir,
  parseSpaceFile,
  stripSpaceFromTriggers,
  spaceFileEntries,
  spacePathFor,
  spaceSpecToFileEntry,
  usableAgentNames,
  type SpaceSpec,
} from './spaces';
import { mergeSpaceAgents, type AgentSpec, type LoadedAgents } from './agents';
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
    space: null,
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

  test('spacePathFor puts the file beside the root manifest', () => {
    expect(spacePathFor('kortix.yaml', 'marketing')).toBe('kortix-marketing.yaml');
    expect(spacePathFor('config/kortix.yaml', 'marketing')).toBe('config/kortix-marketing.yaml');
  });

  test('spaceFileEntries keeps only kortix-<slug>.yaml in exactly that directory, sorted', () => {
    const entries = spaceFileEntries(
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
    expect(spaceFileEntries(['config/kortix-ops.yaml', 'kortix-root.yaml'], 'config')).toEqual([
      { slug: 'ops', path: 'config/kortix-ops.yaml' },
    ]);
  });
});

describe('parseSpaceFile', () => {
  test('reads every field, owned agents carry the owner, references are listed', () => {
    const result = parseSpaceFile('marketing', 'kortix-marketing.yaml', MARKETING);
    if (!result.ok) throw new Error(result.error.error);
    const spec = result.spec;
    expect(spec.slug).toBe('marketing');
    expect(spec.path).toBe('kortix-marketing.yaml');
    expect(spec.name).toBe('Marketing');
    expect(spec.description).toBe('Campaign work.');
    expect(spec.agent).toBe('writer');
    expect(spec.sessions).toBe('shared');
    expect(spec.agents).toEqual(['writer', 'researcher']);
    expect(spec.ownedAgents.map((a) => a.name)).toEqual(['writer']);
    expect(spec.ownedAgents[0]?.space).toBe('marketing');
    expect(spec.ownedAgents[0]?.path).toBe('kortix-marketing.yaml#agents.writer');
    expect(spec.ownedAgents[0]?.connectors).toEqual(['slack']);
    expect(spec.references).toEqual([{ name: 'researcher', from: 'research' }]);
    expect(spec.agentsRaw).toEqual({
      writer: { connectors: ['slack'], secrets: ['BRAND_API_KEY'] },
      researcher: { from: 'research' },
    });
  });

  test('an empty file is a space with defaults', () => {
    const result = parseSpaceFile('yo', 'kortix-yo.yaml', '');
    if (!result.ok) throw new Error(result.error.error);
    expect(result.spec).toMatchObject({
      name: 'yo',
      description: null,
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
      ['marketing', 'instruction: oops', 'instruction'],
      ['Bad Slug', 'name: x', 'slug'],
      ['marketing', 'kortix_version: 2', 'kortix_version'],
    ];
    for (const [slug, text, needle] of cases) {
      const result = parseSpaceFile(slug, 'kortix-marketing.yaml', text);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.path).toBe('kortix-marketing.yaml');
      expect(result.error.error.toLowerCase()).toContain(needle.toLowerCase());
    }
  });
});

describe('extractSpacesFromFiles', () => {
  test('specs and errors come back sorted by slug, and one bad file never hides the others', () => {
    const loaded = extractSpacesFromFiles([
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
  const marketing = parseSpaceFile('marketing', 'kortix-marketing.yaml', MARKETING);
  const research = parseSpaceFile(
    'research',
    'kortix-research.yaml',
    'agents:\n  researcher:\n    connectors: []\n',
  );
  if (!marketing.ok || !research.ok) throw new Error('fixtures must parse');
  const specs = [marketing.spec, research.spec];
  const root: LoadedAgents = { specs: [globalAgent('kortix')], errors: [], defaultAgent: 'kortix' };
  const loaded = mergeSpaceAgents(root, specs);

  test('mergeSpaceAgents folds owned agents into the roster with their owner', () => {
    expect(loaded.specs.map((a) => `${a.name}@${a.space ?? 'root'}`)).toEqual([
      'kortix@root',
      'researcher@research',
      'writer@marketing',
    ]);
    expect(loaded.errors).toEqual([]);
    expect(loaded.defaultAgent).toBe('kortix');
  });

  test('a name declared twice is an error naming both places; the first declaration stays', () => {
    const clash = mergeSpaceAgents(
      { specs: [globalAgent('writer')], errors: [], defaultAgent: null },
      [marketing.spec],
    );
    expect(clash.specs.map((a) => a.path)).toEqual(['kortix.yaml#agents.writer']);
    expect(clash.errors).toHaveLength(1);
    expect(clash.errors[0]?.error).toContain('kortix.yaml#agents.writer');
    expect(clash.errors[0]?.path).toBe('kortix-marketing.yaml#agents.writer');
  });

  test('globals everywhere; owned and referenced only in their space', () => {
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
  test('spaceSpecToFileEntry emits only what deviates, and the agents map verbatim', () => {
    const parsed = parseSpaceFile('marketing', 'kortix-marketing.yaml', MARKETING);
    if (!parsed.ok) throw new Error(parsed.error.error);
    const entry = spaceSpecToFileEntry(parsed.spec);
    expect(Object.keys(entry)).toEqual(['name', 'description', 'agent', 'sessions', 'agents']);
    const minimal: SpaceSpec = {
      ...parsed.spec,
      name: 'marketing',
      description: null,
      agent: null,
      sessions: 'private',
      agentsRaw: null,
    };
    expect(spaceSpecToFileEntry(minimal)).toEqual({});
  });

  test('serialize → parse keeps every field', () => {
    const parsed = parseSpaceFile('marketing', 'kortix-marketing.yaml', MARKETING);
    if (!parsed.ok) throw new Error(parsed.error.error);
    const text = serializeManifestObject(spaceSpecToFileEntry(parsed.spec), 'yaml');
    const again = parseSpaceFile('marketing', 'kortix-marketing.yaml', text);
    if (!again.ok) throw new Error(again.error.error);
    expect(again.spec).toEqual(parsed.spec);
    expect(parseManifestText(text, 'yaml').agents).toEqual(parsed.spec.agentsRaw);
  });

  test('strip clears `space:` only from the triggers naming it', () => {
    const m = manifest({
      kortix_version: 2,
      triggers: [
        { slug: 'a', space: 'marketing' },
        { slug: 'b', space: 'research' },
        { slug: 'c' },
      ],
    });
    const next = stripSpaceFromTriggers(m, 'marketing');
    expect(next.raw.triggers).toEqual([{ slug: 'a' }, { slug: 'b', space: 'research' }, { slug: 'c' }]);
    // Untouched input.
    expect((m.raw.triggers as Array<Record<string, unknown>>)[0]?.space).toBe('marketing');
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
triggers:
  - slug: weekly
    type: cron
    agent: writer
    space: marketing
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

describe('trigger `space` round-trip', () => {
  test('parse → entry → parse keeps the slug, and omits the key when unset', () => {
    const specs = extractTriggers(parse(YAML)).specs;
    const weekly = specs.find((s) => s.slug === 'weekly')!;
    const unrelated = specs.find((s) => s.slug === 'unrelated')!;
    expect(weekly.space).toBe('marketing');
    expect(unrelated.space).toBeNull();

    const entry = triggerSpecToTomlEntry(weekly);
    expect(entry.space).toBe('marketing');
    expect(triggerSpecToTomlEntry(unrelated)).not.toHaveProperty('space');

    const manifest = parse(YAML);
    manifest.raw.triggers = [entry, triggerSpecToTomlEntry(unrelated)];
    const reparsed = extractTriggers(parse(serializeManifest(manifest))).specs;
    expect(reparsed.map((s) => [s.slug, s.space])).toEqual([
      ['unrelated', null],
      ['weekly', 'marketing'],
    ]);
  });

  test('a trigger still written with `subproject:` keeps its scoping, and is rewritten as `space:`', () => {
    // The pre-2026-09-07 spelling. `extractTriggers` reads it so a manifest
    // written before the rename does not silently lose its scoping; the next
    // write of that trigger emits `space:`.
    const legacy = parse(YAML.replace('subproject: marketing', 'subproject: marketing'));
    legacy.raw.triggers = [
      { slug: 'legacy', type: 'cron', agent: 'writer', subproject: 'marketing', cron: '0 0 9 * * 1', timezone: 'UTC', prompt: 'x' },
      { slug: 'both', type: 'cron', agent: 'writer', subproject: 'research', space: 'marketing', cron: '0 0 9 * * 1', timezone: 'UTC', prompt: 'x' },
    ];
    const specs = extractTriggers(legacy).specs;
    expect(specs.find((s) => s.slug === 'legacy')?.space).toBe('marketing');
    // `space` wins when both are present.
    expect(specs.find((s) => s.slug === 'both')?.space).toBe('marketing');

    const entry = triggerSpecToTomlEntry(specs.find((s) => s.slug === 'legacy')!);
    expect(entry.space).toBe('marketing');
    expect(entry).not.toHaveProperty('subproject');
  });

  test('a PATCH of an unrelated field keeps `space` (specToBody merge base)', () => {
    const weekly = extractTriggers(parse(YAML)).specs.find((s) => s.slug === 'weekly')!;
    const base = specToBody(weekly);
    expect(base.space).toBe('marketing');

    const draft = parseTriggerDraft({ ...base, enabled: false }, { existingSlug: 'weekly' });
    expect(draft).not.toHaveProperty('error');
    expect((draft as { space: string | null }).space).toBe('marketing');
    expect(draftToSpec(draft as never, 'kortix.yaml').space).toBe('marketing');
  });

  test('an explicit null or empty string clears it', () => {
    const weekly = extractTriggers(parse(YAML)).specs.find((s) => s.slug === 'weekly')!;
    for (const clear of [null, '']) {
      const draft = parseTriggerDraft(
        { ...specToBody(weekly), space: clear },
        { existingSlug: 'weekly' },
      );
      expect((draft as { space: string | null }).space).toBeNull();
    }
  });
});

/**
 * §5.6 — a warm session is never adopted for a space start. The server
 * half of that is a plain refusal: both warm bodies are `.strict()`, so a
 * `space` key is a 400 before any handler runs. Pinned here because the
 * rule is invisible in the route file.
 */
describe('warm session bodies refuse a space', () => {
  const SESSION_ID = '11111111-1111-4111-8111-111111111111';

  test('the claim body rejects it', () => {
    expect(ClaimWarmProjectSessionInputSchema.safeParse({ session_id: SESSION_ID }).success).toBe(
      true,
    );
    expect(
      ClaimWarmProjectSessionInputSchema.safeParse({
        session_id: SESSION_ID,
        space: 'marketing',
      }).success,
    ).toBe(false);
  });

  test('the create body ACCEPTS it — only the warm path refuses', () => {
    expect(SessionCreateInputSchema.safeParse({ space: 'marketing' }).success).toBe(true);
    expect(SessionCreateInputSchema.safeParse({ space: '' }).success).toBe(false);
  });
});
