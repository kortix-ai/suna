import { describe, test, expect } from 'bun:test';
import {
  parseManifestString,
  serializeManifest,
  extractTriggers,
  triggerSpecToFlatEntry,
} from '../projects/triggers';
import { draftToSpec, parseTriggerDraft } from '../projects/lib/triggers';
import { extractAgents } from '../projects/agents';
import { extractConnectors } from '../projects/connectors';

// Empirical ground truth for the manifest core: parse → extract each resource
// → serialize → re-parse, with no data loss.

const MANIFEST = `default_agent: kortix
project:
  name: probe
  description: A probe project.
env:
  required: []
  optional: [STRIPE_API_KEY]
agents:
  kortix:
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
  scout:
    kortix_permissions: [project.gitops.push]
    connectors: [github]
triggers:
  - slug: nightly
    name: Nightly
    type: cron
    agent: scout
    enabled: true
    cron: "0 0 3 * * *"
    timezone: UTC
    prompt: do the nightly thing
`;

describe('manifest — parse + extract', () => {
  const m = parseManifestString(MANIFEST, 'kortix.yaml');

  test('the path is threaded', () => {
    expect(m.path).toBe('kortix.yaml');
  });

  test('extractAgents reads the agents map', () => {
    const { specs, errors } = extractAgents(m);
    expect(errors).toEqual([]);
    const names = specs.map((s) => s.name).sort();
    expect(names).toEqual(['kortix', 'scout']);
    const scout = specs.find((s) => s.name === 'scout')!;
    expect(scout.permissions).toEqual(['project.gitops.push']);
    expect(scout.connectors).toEqual(['github']);
    const kortix = specs.find((s) => s.name === 'kortix')!;
    expect(kortix.connectors).toBe('all');
  });

  test('extractTriggers reads the yaml triggers list', () => {
    const { specs, errors } = extractTriggers(m);
    expect(errors).toEqual([]);
    expect(specs.map((s) => s.slug)).toEqual(['nightly']);
    expect(specs[0].agent).toBe('scout');
  });

  test('extractConnectors never throws', () => {
    expect(() => extractConnectors(m)).not.toThrow();
  });
});

describe('round-trip serialize', () => {
  test('serialize → re-parse loses no data and writes no kortix_version', () => {
    const m = parseManifestString(MANIFEST, 'kortix.yaml');
    const out = serializeManifest(m);
    expect(out).not.toContain('kortix_version');
    expect(out).toContain('agents:');
    const m2 = parseManifestString(out, 'kortix.yaml');
    expect(extractAgents(m2).specs.map((s) => s.name).sort()).toEqual(['kortix', 'scout']);
    expect(extractTriggers(m2).specs.map((s) => s.slug)).toEqual(['nightly']);
  });
});

describe('draftToSpec — new trigger spec path uses the real manifest file', () => {
  const draft = {
    slug: 'nightly', name: 'Nightly', type: 'cron' as const, agent: 'kortix', model: null,
    enabled: true, promptTemplate: 'do it', cron: '0 0 3 * * *', runAt: null,
    timezone: 'UTC', secretEnv: null, run: null, monitorMode: null, intervalSeconds: null,
    expectEventWithinSeconds: null, sessionMode: 'fresh' as const, pinnedSessionId: null,
        sessionKey: null,
        filter: null,
  };

  test('a kortix.yml project → path is kortix.yml#triggers.<slug>', () => {
    expect(draftToSpec(draft, 'kortix.yml').path).toBe('kortix.yml#triggers.nightly');
  });

  test('no path passed → kortix.yaml (the default)', () => {
    expect(draftToSpec(draft).path).toBe('kortix.yaml#triggers.nightly');
  });
});

describe('session_mode = pinned — parse, validate, serialize', () => {
  const yamlWith = (triggerExtra: string) => `default_agent: kortix
project:
  name: probe
  description: A probe project.
env:
  required: []
  optional: []
agents:
  kortix:
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
triggers:
  - slug: loop
    name: Loop
    type: cron
    agent: kortix
    enabled: true
    cron: "0 0 * * * *"
    timezone: UTC
    prompt: keep going
${triggerExtra}`;

  test('a pinned trigger parses sessionMode + pinnedSessionId', () => {
    const m = parseManifestString(
      yamlWith('    session_mode: pinned\n    session_id: sess-abc\n'),
      'kortix.yaml',
    );
    const { specs, errors } = extractTriggers(m);
    expect(errors).toEqual([]);
    expect(specs[0].sessionMode).toBe('pinned');
    expect(specs[0].pinnedSessionId).toBe('sess-abc');
  });

  test('pinned WITHOUT session_id is a parse error', () => {
    const m = parseManifestString(yamlWith('    session_mode: pinned\n'), 'kortix.yaml');
    const { errors } = extractTriggers(m);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].error).toMatch(/session_id/);
  });

  test('triggerSpecToFlatEntry emits session_mode + session_id for pinned', () => {
    const m = parseManifestString(
      yamlWith('    session_mode: pinned\n    session_id: sess-xyz\n'),
      'kortix.yaml',
    );
    const spec = extractTriggers(m).specs[0];
    const entry = triggerSpecToFlatEntry(spec);
    expect(entry.session_mode).toBe('pinned');
    expect(entry.session_id).toBe('sess-xyz');
  });

  test('fresh trigger omits session_mode/session_id on serialize', () => {
    const m = parseManifestString(yamlWith(''), 'kortix.yaml');
    const entry = triggerSpecToFlatEntry(extractTriggers(m).specs[0]);
    expect(entry.session_mode).toBeUndefined();
    expect(entry.session_id).toBeUndefined();
  });

  test('parseTriggerDraft: pinned requires session_id; fresh nulls it', () => {
    const base = { name: 'p', type: 'cron', cron: '0 0 * * * *', prompt_template: 'x' };
    const ok = parseTriggerDraft(
      { ...base, session_mode: 'pinned', session_id: 'sess-1' },
      { existingSlug: null },
    );
    expect('error' in ok).toBe(false);
    if (!('error' in ok)) expect(ok.pinnedSessionId).toBe('sess-1');

    const bad = parseTriggerDraft({ ...base, session_mode: 'pinned' }, { existingSlug: null });
    expect('error' in bad).toBe(true);

    const fresh = parseTriggerDraft(base, { existingSlug: null });
    if (!('error' in fresh)) expect(fresh.pinnedSessionId).toBe(null);
  });
});

describe('a non-trigger edit keeps the file as written', () => {
  const SOURCE = [
    '# The project manifest: each comment explains a grant. Keep them.',
    'default_agent: worker',
    '',
    '# Project skills, registered by name.',
    'skills: {}',
    '',
    'agents:',
    '  worker:',
    '    tools: [read, bash]',
    '    # Full checkout: this agent edits files.',
    '    workspace: { project_repository: true }',
    '    secrets: all',
    '',
  ].join('\n');

  test('adding a skill and narrowing a grant change only those lines; every comment stays', () => {
    const manifest = parseManifestString(SOURCE, 'kortix.yaml');
    manifest.raw = {
      ...manifest.raw,
      skills: { 'release-notes': 'skills/release-notes' },
      agents: { worker: { ...(manifest.raw.agents as any).worker, secrets: ['HELPDESK_TOKEN'] } },
    };
    const written = serializeManifest(manifest);
    for (const comment of SOURCE.match(/#.*/g) ?? []) expect(written).toContain(comment);
    expect(written).toContain('    tools: [read, bash]\n');
    expect(written).toContain('    workspace: { project_repository: true }\n');
    expect(parseManifestString(written, 'kortix.yaml').raw).toEqual(manifest.raw);
  });
});
