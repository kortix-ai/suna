import { describe, test, expect } from 'bun:test';
import { parseManifestString, serializeManifest } from '../projects/triggers';
import { applyAgentScopeV2 } from '../projects/lib/agent-config-v2';
import { extractAgents } from '../projects/agents';

// applyAgentScopeV2 merges a /scope edit into the `agents:` map: the wire `env`
// ↦ `secrets`, deny-by-default omit, and every other field of the block preserved.

const YAML = `default_agent: kortix
agents:
  kortix:
    connectors: all
    secrets: all
    kortix_permissions: all
    skills: all
  scout:
    kortix_permissions: [project.gitops.push]
    connectors: [github]
    skills: [research]
`;

function manifest() {
  return parseManifestString(YAML, 'kortix.yaml');
}

describe('applyAgentScopeV2 — agents map scope edit', () => {
  test('set connectors to a list — updates the map, preserves other governance', () => {
    const m = manifest();
    const r = applyAgentScopeV2(m, 'scout', { connectors: ['github', 'linear'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scout = (r.raw.agents as Record<string, any>).scout;
    expect(scout.connectors).toEqual(['github', 'linear']);
    // kortix_permissions + skills untouched.
    expect(scout.kortix_permissions).toEqual(['project.gitops.push']);
    expect(scout.skills).toEqual(['research']);
  });

  test('wire `env` maps to `secrets` (NOT `env`)', () => {
    const m = manifest();
    const r = applyAgentScopeV2(m, 'scout', { env: ['API_KEY'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scout = (r.raw.agents as Record<string, any>).scout;
    expect(scout.secrets).toEqual(['API_KEY']);
    expect(scout.env).toBeUndefined(); // never writes the retired `env` key
  });

  test("'all' is written explicitly (the default is none, not all)", () => {
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
    expect(scout.kortix_permissions).toEqual(['project.gitops.push']);
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
    expect(out).not.toContain('kortix_version');
    const m2 = parseManifestString(out, 'kortix.yaml');
    const scout = extractAgents(m2).specs.find((s) => s.name === 'scout')!;
    expect(scout.connectors).toEqual(['github', 'linear']);
    // extractAgents surfaces `secrets` as the spec.env field.
    expect(scout.env).toEqual(['API_KEY']);
  });
});
