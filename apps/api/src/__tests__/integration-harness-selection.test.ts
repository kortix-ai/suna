/**
 * The harness-selection contract, driven end to end over the REAL starter
 * template: template files -> kortix.yaml -> compileRuntimeConfig -> the
 * operator gate that createProjectSession consults before it persists
 * `runtime_harness`.
 *
 * The property worth locking: the shipped starter can only ever resolve
 * `opencode`. There is no input to it that yields claude, codex, or pi, and no
 * operator setting that turns it into one — the manifest is an input, never an
 * authority.
 *
 * This file once also drove a second, v3 multi-harness starter, asserting that a
 * manifest DECLARING four harnesses is still refused three of them until an
 * operator opts in. That starter no longer exists (one starter, kortix_version
 * 2), so the block had no subject. No coverage moved with it: the gate and its
 * kill switch are pinned directly in projects/lib/harness-gate.test.ts, and the
 * "a v3 manifest is offered no migration" verdict in
 * projects/lib/manifest-verdict.test.ts, both against hand-authored input rather
 * than a scaffold. v3 PARSING is deliberately retained for a hand-written
 * manifest; only the v3 starter is gone.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_STARTER_TEMPLATE_ID, getStarterFiles } from '@kortix/starter';

import { compileRuntimeConfig } from '../projects/lib/compile-runtime-config';
import { enabledHarnessIds, isHarnessEnabled } from '../projects/lib/harness-gate';
import { resolveManifestVerdict } from '../projects/lib/manifest-verdict';
import { parseManifestString } from '../projects/triggers';

const EVERY_HARNESS = 'opencode,claude,codex,pi';

function compiledFor(template: string) {
  const files = getStarterFiles({
    projectName: 'Acme Co',
    repoFullName: 'kortix/acme-co',
    template: template as never,
  });
  const manifestFile = files.find((f) => f.path === 'kortix.yaml');
  if (!manifestFile) throw new Error(`starter "${template}" scaffolds no kortix.yaml`);
  const parsed = parseManifestString(manifestFile.content, 'yaml', 'kortix.yaml');
  const compiled = compileRuntimeConfig(parsed.raw);
  if (!compiled) throw new Error(`starter "${template}" produced no runtime config`);
  return { compiled, manifest: manifestFile.content };
}

describe('the shipped starter — the harness chain can only land on opencode', () => {
  const { compiled } = compiledFor(DEFAULT_STARTER_TEMPLATE_ID);

  test('compiles a single kortix_version 2 opencode runtime profile', () => {
    expect(compiled.version).toBe(2);
    expect(Object.values(compiled.runtimes).map((r) => r.harness)).toEqual(['opencode']);
  });

  test('every declared agent resolves to opencode', () => {
    expect([...new Set(Object.values(compiled.agents).map((a) => a.harness))]).toEqual([
      'opencode',
    ]);
  });

  test('the default agent is declared, enabled, and on opencode', () => {
    expect(compiled.agents[compiled.defaultAgent]).toMatchObject({
      enabled: true,
      harness: 'opencode',
    });
  });

  test('its harness passes the gate on a default deployment', () => {
    for (const agent of Object.values(compiled.agents)) {
      expect(isHarnessEnabled(agent.harness, '')).toBe(true);
    }
  });

  test('it cannot silently resolve claude, codex, or pi even with the gate wide open', () => {
    const harnesses = new Set(Object.values(compiled.agents).map((a) => a.harness));
    for (const harness of ['claude', 'codex', 'pi']) {
      expect(harnesses.has(harness as never)).toBe(false);
    }
    expect(enabledHarnessIds(EVERY_HARNESS)).toContain('claude');
  });

  test('a v2 project is NOT told to migrate', () => {
    const { manifest } = compiledFor(DEFAULT_STARTER_TEMPLATE_ID);
    const verdict = resolveManifestVerdict({ raw: manifest, format: 'yaml', path: 'kortix.yaml' });

    expect(verdict.version).toBe(2);
    expect(verdict.migration_offered).toBe(false);
    expect(verdict.target_version).toBeNull();
    expect(verdict.unknown_reason).toBeNull();
  });
});
