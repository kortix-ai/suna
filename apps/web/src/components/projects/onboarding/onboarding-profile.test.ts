import { describe, expect, test } from 'bun:test';

import {
  buildOnboardingKickoffPrompt,
  buildSteps,
  deriveCompanyDomain,
  firstStepAfterSurvey,
  isValidCompanyHttpLink,
  starterPromptsFor,
  surveyPosition,
  USE_CASE_OPTIONS,
} from './onboarding-profile';

describe('buildSteps', () => {
  test('includes the tools step when connectors are enabled', () => {
    expect(buildSteps(true)).toEqual(['company', 'tools', 'slack', 'plan', 'done']);
  });

  // Self-host without Pipedream configured has no catalogue to offer, so the
  // step is dropped rather than landing the user on a dead 501.
  test('drops only the tools step when connectors are disabled', () => {
    expect(buildSteps(false)).toEqual(['company', 'slack', 'plan', 'done']);
  });

  // A screen that asks nothing and tells nothing is a screen the user pays for
  // and gets nothing back from. Alan, Brilliant, and Headspace all open on
  // their first real question. There is also no use-case screen — a forced
  // single-bucket pick asks a question that does not have one right answer.
  test('opens on a question — there is no welcome screen and no use-case screen', () => {
    expect(buildSteps(true)[0]).toBe('company');
    expect(buildSteps(false)[0]).toBe('company');
    expect(buildSteps(true)).not.toContain('welcome');
    expect(buildSteps(true)).not.toContain('use-case');
  });

  // `project.connector.read` left the member floor role in #6522. A plain
  // member invited into someone else's project still gets this wizard on first
  // open, and "Connect your tools" 403s on `listConnectors` — a bare
  // "forbidden" toast over the whole flow. Slack goes with it: Channels is a
  // scope of Connectors and rides the same leaf.
  test('drops the connector steps for a caller without project.connector.read', () => {
    expect(buildSteps(true, false)).toEqual(['company', 'plan', 'done']);
    expect(buildSteps(false, false)).toEqual(['company', 'plan', 'done']);
  });

  test('a permitted caller keeps them, and the default argument is permissive', () => {
    expect(buildSteps(true, true)).toEqual(['company', 'tools', 'slack', 'plan', 'done']);
    // Optimistic default: an unresolved probe must not silently shorten the
    // wizard for someone who does hold the leaf.
    expect(buildSteps(true)).toEqual(buildSteps(true, true));
  });

  // The wizard's own Skip lands on `firstStepAfterSurvey(steps)`. With the
  // connector steps gone that has to be `plan`, not an index that no longer
  // exists — a hardcoded 1 would have dropped a member onto `done`.
  test('skip lands on the first non-survey step that actually remains', () => {
    const steps = buildSteps(true, false);
    expect(steps[firstStepAfterSurvey(steps)]).toBe('plan');
  });
});

describe('surveyPosition', () => {
  test('numbers the one remaining survey step', () => {
    expect(surveyPosition('company')).toEqual({ index: 1, total: 1 });
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
    expect(firstStepAfterSurvey(steps)).toBe(1);
    expect(steps[1]).toBe('tools');
  });

  // The skip must not assume the tools step exists — with connectors disabled
  // the next real step is Slack at the same index.
  test('lands on slack when connectors are disabled', () => {
    const steps = buildSteps(false);
    expect(firstStepAfterSurvey(steps)).toBe(1);
    expect(steps[1]).toBe('slack');
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

describe('buildOnboardingKickoffPrompt', () => {
  test('references the real domain value, not a placeholder', () => {
    const prompt = buildOnboardingKickoffPrompt('acme.com', 0);
    expect(prompt).toContain('acme.com');
  });

  test('falls back to a domain-agnostic opener when the survey was skipped', () => {
    const prompt = buildOnboardingKickoffPrompt('', 0);
    expect(prompt).not.toContain('undefined');
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('trims the domain before embedding it', () => {
    expect(buildOnboardingKickoffPrompt('  acme.com  ', 0)).toContain('acme.com');
    expect(buildOnboardingKickoffPrompt('  acme.com  ', 0)).not.toContain(' acme.com  ');
  });

  test('mentions connected tools only when there are any, and pluralizes correctly', () => {
    const none = buildOnboardingKickoffPrompt('acme.com', 0);
    const one = buildOnboardingKickoffPrompt('acme.com', 1);
    const many = buildOnboardingKickoffPrompt('acme.com', 3);
    expect(none).not.toContain('tool');
    expect(one).toContain('1 tool ');
    expect(many).toContain('3 tools');
  });

  test('is a first-person request the agent can act on, not marketing copy', () => {
    const prompt = buildOnboardingKickoffPrompt('acme.com', 0);
    expect(prompt.startsWith('I ')).toBe(true);
  });
});

describe('option sets', () => {
  test('offers seven use cases with unique values', () => {
    expect(USE_CASE_OPTIONS).toHaveLength(7);
    expect(new Set(USE_CASE_OPTIONS.map((o) => o.value)).size).toBe(7);
  });
});
