import { describe, expect, test } from 'bun:test';

import {
  REFINE_DEFAULT_EVERY_TURNS,
  REFINE_DEFAULT_MAX_PER_SESSION_PER_DAY,
  REFINE_DEFAULT_WARMUP_TURNS,
  extractRefine,
} from './refine';
import { type ParsedManifest, parseManifestString } from './triggers';

function manifestWith(refineYaml: string): ParsedManifest {
  const raw = [
    'kortix_version: 2',
    'default_agent: kortix',
    'agents:',
    '  kortix:',
    '    skills: all',
    refineYaml,
  ].join('\n');
  return parseManifestString(raw, 'yaml', 'kortix.yaml');
}

describe('extractRefine', () => {
  test('absent block → null spec, no errors', () => {
    const { spec, errors } = extractRefine(manifestWith(''));
    expect(spec).toBeNull();
    expect(errors).toEqual([]);
  });

  test('minimal enabled block gets every default', () => {
    const { spec, errors } = extractRefine(manifestWith('refine:\n  enabled: true'));
    expect(errors).toEqual([]);
    expect(spec).toEqual({
      enabled: true,
      everyTurns: REFINE_DEFAULT_EVERY_TURNS,
      warmupTurns: REFINE_DEFAULT_WARMUP_TURNS,
      maxPerSessionPerDay: REFINE_DEFAULT_MAX_PER_SESSION_PER_DAY,
      agents: ['kortix'],
    });
  });

  test('enabled must be literally true — absent/false/truthy-string stay disabled', () => {
    for (const value of ['false', '"yes"', '1']) {
      const { spec } = extractRefine(manifestWith(`refine:\n  enabled: ${value}`));
      expect(spec?.enabled).toBe(false);
    }
  });

  test('full block round-trips', () => {
    const { spec, errors } = extractRefine(
      manifestWith(
        [
          'refine:',
          '  enabled: true',
          '  every_turns: 40',
          '  warmup_turns: 5',
          '  max_per_session_per_day: 3',
          '  agents: [kortix, writer]',
        ].join('\n'),
      ),
    );
    expect(errors).toEqual([]);
    expect(spec).toEqual({
      enabled: true,
      everyTurns: 40,
      warmupTurns: 5,
      maxPerSessionPerDay: 3,
      agents: ['kortix', 'writer'],
    });
  });

  test('out-of-range and non-integer fields error and degrade to defaults', () => {
    const { spec, errors } = extractRefine(
      manifestWith(
        ['refine:', '  enabled: true', '  every_turns: 0', '  warmup_turns: 2.5'].join('\n'),
      ),
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('every_turns');
    expect(errors[1]).toContain('warmup_turns');
    expect(spec?.everyTurns).toBe(REFINE_DEFAULT_EVERY_TURNS);
    expect(spec?.warmupTurns).toBe(REFINE_DEFAULT_WARMUP_TURNS);
  });

  test('agents defaults to the manifest default_agent', () => {
    const raw = [
      'kortix_version: 2',
      'default_agent: writer',
      'agents:',
      '  writer:',
      '    skills: all',
      'refine:',
      '  enabled: true',
    ].join('\n');
    const { spec } = extractRefine(parseManifestString(raw, 'yaml', 'kortix.yaml'));
    expect(spec?.agents).toEqual(['writer']);
  });

  test('reflector agents are rejected from the allowlist', () => {
    const { spec, errors } = extractRefine(
      manifestWith('refine:\n  enabled: true\n  agents: [kortix, harness-reflector]'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('harness-reflector');
    expect(spec?.agents).toEqual(['kortix']);
  });

  test('non-map refine block errors without a spec', () => {
    const { spec, errors } = extractRefine(manifestWith('refine: true'));
    expect(spec).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
