import { describe, expect, test } from 'bun:test';

import {
  buildSteps,
  COMPANY_SIZES,
  deriveCompanyDomain,
  firstStepAfterSurvey,
  isValidCompanyHttpLink,
  starterPromptsFor,
  surveyPosition,
  USE_CASE_OPTIONS,
} from './onboarding-profile';

describe('buildSteps', () => {
  test('includes the tools step when connectors are enabled', () => {
    expect(buildSteps(true)).toEqual(['use-case', 'company', 'tools', 'slack', 'plan', 'done']);
  });

  // Self-host without Pipedream configured has no catalogue to offer, so the
  // step is dropped rather than landing the user on a dead 501.
  test('drops only the tools step when connectors are disabled', () => {
    expect(buildSteps(false)).toEqual(['use-case', 'company', 'slack', 'plan', 'done']);
  });

  // A screen that asks nothing and tells nothing is a screen the user pays for
  // and gets nothing back from. Alan, Brilliant, and Headspace all open on
  // their first real question.
  test('opens on a question — there is no welcome screen', () => {
    expect(buildSteps(true)[0]).toBe('use-case');
    expect(buildSteps(false)[0]).toBe('use-case');
    expect(buildSteps(true)).not.toContain('welcome');
  });
});

describe('surveyPosition', () => {
  test('numbers the two survey steps', () => {
    expect(surveyPosition('use-case')).toEqual({ index: 1, total: 2 });
    expect(surveyPosition('company')).toEqual({ index: 2, total: 2 });
  });

  // The eyebrow counts SURVEY questions, not wizard steps, so removing the
  // tools step must not renumber it.
  test('is null for every non-survey step', () => {
    for (const id of ['tools', 'slack', 'plan', 'done'] as const) {
      expect(surveyPosition(id)).toBeNull();
    }
  });
});

describe('firstStepAfterSurvey', () => {
  test('lands on tools when connectors are enabled', () => {
    const steps = buildSteps(true);
    expect(firstStepAfterSurvey(steps)).toBe(2);
    expect(steps[2]).toBe('tools');
  });

  // The skip must not assume the tools step exists — with connectors disabled
  // the next real step is Slack at the same index.
  test('lands on slack when connectors are disabled', () => {
    const steps = buildSteps(false);
    expect(firstStepAfterSurvey(steps)).toBe(2);
    expect(steps[2]).toBe('slack');
  });

  test('never returns a survey step', () => {
    for (const steps of [buildSteps(true), buildSteps(false)]) {
      const target = steps[firstStepAfterSurvey(steps)];
      expect(target).toBeDefined();
      expect(surveyPosition(target!)).toBeNull();
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

describe('isValidCompanyHttpLink', () => {
  test('allows empty — the field is optional', () => {
    expect(isValidCompanyHttpLink('')).toBe(true);
    expect(isValidCompanyHttpLink('   ')).toBe(true);
  });

  test('allows bare hostnames and http(s) URLs', () => {
    expect(isValidCompanyHttpLink('acme.com')).toBe(true);
    expect(isValidCompanyHttpLink('https://acme.com')).toBe(true);
    expect(isValidCompanyHttpLink('http://acme.co.uk/path')).toBe(true);
    expect(isValidCompanyHttpLink('  ACME.COM  ')).toBe(true);
  });

  test('rejects free text, other schemes, and single-label hosts', () => {
    expect(isValidCompanyHttpLink('not a company')).toBe(false);
    expect(isValidCompanyHttpLink('localhost')).toBe(false);
    expect(isValidCompanyHttpLink('ftp://acme.com')).toBe(false);
    expect(isValidCompanyHttpLink('javascript:alert(1)')).toBe(false);
    expect(isValidCompanyHttpLink('127.0.0.1')).toBe(false);
  });
});

describe('starterPromptsFor', () => {
  test('returns three prompts for every option', () => {
    for (const option of USE_CASE_OPTIONS) {
      const prompts = starterPromptsFor(option.value);
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
    const leads = USE_CASE_OPTIONS.map((o) => starterPromptsFor(o.value)[0]?.template);
    expect(new Set(leads).size).toBe(USE_CASE_OPTIONS.length);
  });
});

describe('option sets', () => {
  test('offers seven use cases with unique values', () => {
    expect(USE_CASE_OPTIONS).toHaveLength(7);
    expect(new Set(USE_CASE_OPTIONS.map((o) => o.value)).size).toBe(7);
  });

  // Must match features/contact/demo-qualifier-modal.tsx so a user who both
  // onboards and books a demo is never offered two different scales.
  test('uses the canonical company-size scale', () => {
    expect(COMPANY_SIZES).toEqual(['1-10', '11-50', '51-200', '201-1000', '1000+']);
  });
});
