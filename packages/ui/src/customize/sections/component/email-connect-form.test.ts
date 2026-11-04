import { describe, expect, test } from 'bun:test';

import { defaultSenders, senderPolicyFor, teamDomainOf } from './email-connect-form';

/**
 * A new inbox starts sessions on the project's credits, so the connect form
 * preselects the narrowest sender choice that still names a real person, and
 * never offers a public mail provider as "people at <domain>".
 */
describe('who can email a new inbox', () => {
  test('a work email preselects its domain; a public provider preselects only the viewer', () => {
    expect(teamDomainOf('ada@acme.io')).toBe('acme.io');
    expect(defaultSenders('ada@acme.io')).toBe('team');
    expect(teamDomainOf('ada@gmail.com')).toBeNull();
    expect(defaultSenders('ada@gmail.com')).toBe('me');
    expect(defaultSenders(null)).toBe('anyone');
  });

  test('each choice maps to the server policy', () => {
    expect(senderPolicyFor('me', { email: 'Ada@Acme.io', customList: '' })).toEqual({
      mode: 'restricted', allowedEmails: ['ada@acme.io'], allowedDomains: [], allowedRegex: null,
    });
    expect(senderPolicyFor('team', { email: 'ada@acme.io', customList: '' })).toEqual({
      mode: 'restricted', allowedEmails: [], allowedDomains: ['acme.io'], allowedRegex: null,
    });
    expect(senderPolicyFor('anyone', { email: 'ada@acme.io', customList: '' }).mode).toBe('allow_all');
  });

  test('a custom list routes entries by shape and drops duplicates', () => {
    expect(
      senderPolicyFor('custom', { email: null, customList: 'bob@x.io\n@partner.io, acme.io,bob@x.io' }),
    ).toEqual({
      mode: 'restricted', allowedEmails: ['bob@x.io'], allowedDomains: ['partner.io', 'acme.io'], allowedRegex: null,
    });
  });

  test('a team choice with a public provider never widens to anyone at that provider', () => {
    expect(senderPolicyFor('team', { email: 'ada@gmail.com', customList: '' })).toEqual({
      mode: 'restricted', allowedEmails: ['ada@gmail.com'], allowedDomains: [], allowedRegex: null,
    });
  });
});
