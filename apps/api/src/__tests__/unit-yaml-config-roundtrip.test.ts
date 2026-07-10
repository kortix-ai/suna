import { describe, test, expect } from 'bun:test';
import { parseManifestString, serializeManifest, extractTriggers } from '../projects/triggers';
import { draftToSpec } from '../projects/lib/triggers';
import { extractAgents } from '../projects/agents';
import { extractApps } from '../projects/apps';
import { extractConnectors } from '../projects/connectors';

// Empirical ground truth for the dual-format (TOML v1 + YAML v2) manifest core:
// parse → extract each resource → serialize → re-parse, for BOTH formats, and
// prove the write path preserves the file's own format (a .yaml project must
// never serialize back as TOML).

const YAML_V2 = `kortix_version: 2
default_agent: kortix
project:
  name: probe
  description: A probe project.
env:
  required: []
  optional: [STRIPE_API_KEY]
opencode:
  config_dir: .kortix/opencode
agents:
  kortix:
    connectors: all
    secrets: all
    kortix_cli: all
    skills: all
  scout:
    kortix_cli: [project.cr.open]
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

const TOML_V1 = `kortix_version = 1
default_agent = "kortix"

[[agents]]
name = "kortix"
env = "all"
connectors = "all"

[[agents]]
name = "scout"
connectors = ["github"]

[[triggers]]
slug = "nightly"
name = "Nightly"
type = "cron"
agent = "kortix"
enabled = true
cron = "0 0 3 * * *"
prompt = "do the nightly thing"
`;

describe('YAML v2 manifest — parse + extract', () => {
  const m = parseManifestString(YAML_V2, 'yaml', 'kortix.yaml');

  test('parses as yaml, schema v2, format/path threaded', () => {
    expect(m.format).toBe('yaml');
    expect(m.path).toBe('kortix.yaml');
    expect(m.schemaVersion).toBe(2);
  });

  test('extractAgents reads the v2 agents MAP', () => {
    const { specs, errors } = extractAgents(m);
    expect(errors).toEqual([]);
    const names = specs.map((s) => s.name).sort();
    expect(names).toEqual(['kortix', 'scout']);
    const scout = specs.find((s) => s.name === 'scout')!;
    expect(scout.kortixCli).toEqual(['project.cr.open']);
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

  test('extractApps / extractConnectors never throw on a yaml manifest', () => {
    expect(() => extractApps(m)).not.toThrow();
    expect(() => extractConnectors(m)).not.toThrow();
  });
});

describe('TOML v1 manifest — parse + extract (parity)', () => {
  const m = parseManifestString(TOML_V1, 'toml', 'kortix.toml');

  test('parses as toml, schema v1', () => {
    expect(m.format).toBe('toml');
    expect(m.schemaVersion).toBe(1);
  });

  test('extractAgents reads the v1 [[agents]] ARRAY', () => {
    const { specs, errors } = extractAgents(m);
    expect(errors).toEqual([]);
    expect(specs.map((s) => s.name).sort()).toEqual(['kortix', 'scout']);
    expect(specs.find((s) => s.name === 'scout')!.connectors).toEqual(['github']);
  });

  test('extractTriggers reads the toml [[triggers]] array', () => {
    const { specs, errors } = extractTriggers(m);
    expect(errors).toEqual([]);
    expect(specs.map((s) => s.slug)).toEqual(['nightly']);
  });
});

describe('round-trip serialize preserves the file format', () => {
  test('yaml manifest → serialize stays YAML (agents map, not [[agents]]) + re-parses equal', () => {
    const m = parseManifestString(YAML_V2, 'yaml', 'kortix.yaml');
    const out = serializeManifest(m);
    expect(out).toMatch(/^kortix_version: 2/m); // yaml scalar, not `kortix_version = 2`
    expect(out).toContain('agents:');
    expect(out).not.toContain('[[agents]]');
    // Re-parse and confirm no data loss on the round-trip.
    const m2 = parseManifestString(out, 'yaml', 'kortix.yaml');
    expect(extractAgents(m2).specs.map((s) => s.name).sort()).toEqual(['kortix', 'scout']);
    expect(extractTriggers(m2).specs.map((s) => s.slug)).toEqual(['nightly']);
  });

  test('toml manifest → serialize stays TOML ([[agents]], not agents:)', () => {
    const m = parseManifestString(TOML_V1, 'toml', 'kortix.toml');
    const out = serializeManifest(m);
    expect(out).toMatch(/kortix_version = 1/);
    expect(out).toContain('[[agents]]');
    const m2 = parseManifestString(out, 'toml', 'kortix.toml');
    expect(extractAgents(m2).specs.map((s) => s.name).sort()).toEqual(['kortix', 'scout']);
  });
});

describe('draftToSpec — new trigger spec path uses the real manifest file', () => {
  const draft = {
    slug: 'nightly', name: 'Nightly', type: 'cron' as const, agent: 'kortix', model: null,
    enabled: true, promptTemplate: 'do it', cron: '0 0 3 * * *', runAt: null,
    timezone: 'UTC', secretEnv: null, sessionMode: 'fresh' as const,
  };

  test('YAML project → path is kortix.yaml#triggers.<slug> (not hardcoded toml)', () => {
    expect(draftToSpec(draft, 'kortix.yaml').path).toBe('kortix.yaml#triggers.nightly');
  });

  test('TOML default preserved when no path passed', () => {
    expect(draftToSpec(draft).path).toBe('kortix.toml#triggers.nightly');
  });
});
