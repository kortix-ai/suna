import { describe, expect, test } from 'bun:test';

import {
  buildSteps,
  deriveCompanyDomain,
  starterPromptsFor,
  WORK_OPTIONS,
} from './onboarding-profile';

describe('buildSteps', () => {
  test('asks three things when connectors are available', () => {
    expect(buildSteps(true)).toEqual(['work', 'apps', 'models']);
  });

  // A self-host without a connector provider has no catalogue to pick from.
  test('drops the apps step when connectors are disabled', () => {
    expect(buildSteps(false)).toEqual(['work', 'models']);
  });

  // `project.connector.read` left the member floor role in #6522. The
  // catalogue would 403 for a plain member.
  test('drops the apps step for a caller without project.connector.read', () => {
    expect(buildSteps(true, false)).toEqual(['work', 'models']);
  });

  // Optimistic default: an unresolved probe must not silently shorten the
  // wizard for someone who does hold the leaf.
  test('the default argument is permissive', () => {
    expect(buildSteps(true)).toEqual(buildSteps(true, true));
  });

  // Models is the step whose primary opens the project.
  test('always ends on models', () => {
    for (const steps of [buildSteps(true), buildSteps(false), buildSteps(true, false)]) {
      expect(steps.at(-1)).toBe('models');
    }
  });
});

describe('deriveCompanyDomain', () => {
  test('extracts the domain from a work email', () => {
    expect(deriveCompanyDomain('sam@acme.com')).toBe('acme.com');
  });

  test('lowercases and trims', () => {
    expect(deriveCompanyDomain('  Sam@ACME.CO.UK ')).toBe('acme.co.uk');
  });

  // We never suggest `gmail.com` as somebody's employer.
  test('returns empty for a consumer inbox', () => {
    expect(deriveCompanyDomain('sam@gmail.com')).toBe('');
    expect(deriveCompanyDomain('sam@icloud.com')).toBe('');
    expect(deriveCompanyDomain('sam@outlook.com')).toBe('');
  });

  test('returns empty for missing or malformed input', () => {
    expect(deriveCompanyDomain(null)).toBe('');
    expect(deriveCompanyDomain(undefined)).toBe('');
    expect(deriveCompanyDomain('')).toBe('');
    expect(deriveCompanyDomain('not-an-email')).toBe('');
    expect(deriveCompanyDomain('sam@')).toBe('');
  });

  // A single-label host is not a company domain, and `isWorkEmail` would wave
  // it through because it only denylists known consumer providers.
  test('returns empty for a domain with no dot', () => {
    expect(deriveCompanyDomain('sam@localhost')).toBe('');
  });
});

describe('starterPromptsFor', () => {
  test('returns three prompts for every option', () => {
    for (const option of WORK_OPTIONS) {
      const prompts = starterPromptsFor(option);
      expect(prompts).toHaveLength(3);
      for (const p of prompts) {
        expect(p.title.length).toBeGreaterThan(0);
        expect(p.prompt.length).toBeGreaterThan(0);
        expect(p.template.length).toBeGreaterThan(0);
      }
    }
  });

  test('falls back to three prompts when the survey was skipped', () => {
    expect(starterPromptsFor(null)).toHaveLength(3);
  });

  test('gives each use case a distinct lead prompt', () => {
    const leads = WORK_OPTIONS.map((o) => starterPromptsFor(o)[0]?.template);
    expect(new Set(leads).size).toBe(WORK_OPTIONS.length);
  });
});

describe('work options', () => {
  test('offers eight unique answers, ending on "Something else"', () => {
    expect(WORK_OPTIONS).toHaveLength(8);
    expect(new Set(WORK_OPTIONS).size).toBe(8);
    expect(WORK_OPTIONS.at(-1)).toBe('other');
  });
});
