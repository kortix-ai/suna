import { describe, test, expect } from 'bun:test';
import { parseManifestString, serializeManifest } from '../projects/triggers';
import { applyAgentScopeV2 } from '../projects/lib/agent-config-v2';
import { extractAgents } from '../projects/agents';

// Regression for the v2-YAML agent-scope bug: the /scope route used
// applyAgentScope (v1 `[[agents]]` array only), which treated a v2 `agents:` map
// as an empty array → every scope edit on a YAML project 404'd. applyAgentScopeV2
// merges into the map correctly: v1 wire `env` ↦ v2 `secrets`, deny-by-default
// omit, and every other governance field preserved.

const YAML = `kortix_version: 2
default_agent: kortix
agents:
  kortix:
    connectors: all
    secrets: all
    kortix_cli: all
    skills: all
  scout:
    kortix_cli: [project.cr.open]
    connectors: [github]
    skills: [research]
`;

function manifest() {
  return parseManifestString(YAML, 'yaml', 'kortix.yaml');
}

describe('applyAgentScopeV2 — v2 agents map scope edit', () => {
  test('set connectors to a list — updates the map, preserves other governance', () => {
    const m = manifest();
    const r = applyAgentScopeV2(m, 'scout', { connectors: ['github', 'linear'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scout = (r.raw.agents as Record<string, any>).scout;
    expect(scout.connectors).toEqual(['github', 'linear']);
    // kortix_cli + skills untouched.
    expect(scout.kortix_cli).toEqual(['project.cr.open']);
    expect(scout.skills).toEqual(['research']);
  });

  test('wire `env` maps to v2 `secrets` (NOT `env`)', () => {
    const m = manifest();
    const r = applyAgentScopeV2(m, 'scout', { env: ['API_KEY'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scout = (r.raw.agents as Record<string, any>).scout;
    expect(scout.secrets).toEqual(['API_KEY']);
    expect(scout.env).toBeUndefined(); // never writes the v1 key into a v2 block
  });

  test("'all' is written explicitly (v2 default is none, not all)", () => {
    const m = manifest();
    const r = applyAgentScopeV2(m, 'scout', { env: 'all', connectors: 'all' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scout = (r.raw.agents as Record<string, any>).scout;
    expect(scout.secrets).toBe('all');
    expect(scout.connectors).toBe('all');
  });

  test('empty selection ([] = none) OMITS the key (deny-by-default idiom)', () => {
    const m = manifest();
    const r = applyAgentScopeV2(m, 'scout', { env: [], connectors: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scout = (r.raw.agents as Record<string, any>).scout;
    expect(scout).not.toHaveProperty('secrets');
    expect(scout).not.toHaveProperty('connectors');
    // Non-scope fields still preserved.
    expect(scout.kortix_cli).toEqual(['project.cr.open']);
  });

  test('undeclared agent → notFound (route maps to 404)', () => {
    const m = manifest();
    const r = applyAgentScopeV2(m, 'ghost', { connectors: ['x'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notFound).toBe(true);
  });

  test('round-trips: serialize stays YAML, re-parse reflects the edit via extractAgents', () => {
    const m = manifest();
    const r = applyAgentScopeV2(m, 'scout', { connectors: ['github', 'linear'], env: ['API_KEY'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    m.raw = r.raw;
    const out = serializeManifest(m);
    expect(out).toContain('agents:');
    expect(out).not.toContain('[[agents]]');
    const m2 = parseManifestString(out, 'yaml', 'kortix.yaml');
    const scout = extractAgents(m2).specs.find((s) => s.name === 'scout')!;
    expect(scout.connectors).toEqual(['github', 'linear']);
    // extractAgentsV2 surfaces v2 `secrets` as the unified spec.env field.
    expect(scout.env).toEqual(['API_KEY']);
  });
});
