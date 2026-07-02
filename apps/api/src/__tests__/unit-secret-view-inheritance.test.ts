/**
 * Unit tests for buildSecretView's `inherited_from` provenance (the read side of
 * the "assign human → agent" pyramid). The field names the agent(s) an assigned
 * member inherits a secret from — but ONLY when inheritance is the REASON they
 * can use it (a secret they'd have anyway via project-wide/direct share is not
 * mislabelled inherited, and an UNSET secret can't be inherited at all).
 */
import { describe, expect, test } from 'bun:test';
import { buildSecretView } from '../projects/lib/serializers';
import type { ShareSubject } from '../executor/share';

const SUBJECT: ShareSubject = { userId: 'u-me', groupIds: [] };
const OTHER = 'u-other';

// Minimal shared-row fixture — buildSecretView only reads shareScope + a few
// timestamp/id fields. Cast keeps the test free of the full Drizzle row shape.
function sharedRow(shareScope: 'project' | 'restricted'): any {
  return {
    secretId: 's-1',
    projectId: 'p-1',
    name: 'STRIPE_KEY',
    valueEnc: 'enc',
    scope: 'runtime',
    shareScope,
    ownerUserId: null,
    active: true,
    createdBy: OTHER,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

// Minimal PERSONAL override row (owner = me).
function personalRow(): any {
  return {
    secretId: 's-p',
    projectId: 'p-1',
    name: 'STRIPE_KEY',
    valueEnc: 'enc',
    scope: 'runtime',
    shareScope: 'restricted',
    ownerUserId: SUBJECT.userId,
    active: true,
    createdBy: SUBJECT.userId,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

const sources = (agents: string[]) => new Map<string, string[]>([['STRIPE_KEY', agents]]);

describe('buildSecretView — inherited_from provenance', () => {
  test('restricted secret NOT shared with me, but declared by an assigned agent → usable + inherited_from', () => {
    const v = buildSecretView({
      name: 'STRIPE_KEY',
      shared: sharedRow('restricted'),
      sharedGrants: [{ principalType: 'member', principalId: OTHER }], // shared with someone else
      subject: SUBJECT,
      canManageShared: false,
      inheritedSources: sources(['billing-bot']),
    });
    expect(v.usable_by_me).toBe(true);
    expect(v.inherited_from).toEqual(['billing-bot']);
    expect(v.effective_source).toBe('shared');
  });

  test('restricted secret not shared with me and NOT inherited → not usable, no provenance', () => {
    const v = buildSecretView({
      name: 'STRIPE_KEY',
      shared: sharedRow('restricted'),
      sharedGrants: [{ principalType: 'member', principalId: OTHER }],
      subject: SUBJECT,
      canManageShared: false,
      inheritedSources: new Map(), // I'm assigned to no agent that declares it
    });
    expect(v.usable_by_me).toBe(false);
    expect(v.inherited_from).toBeNull();
  });

  test('project-wide secret I can use anyway is NOT mislabelled inherited (inheritance is not the reason)', () => {
    const v = buildSecretView({
      name: 'STRIPE_KEY',
      shared: sharedRow('project'),
      sharedGrants: [],
      subject: SUBJECT,
      canManageShared: false,
      inheritedSources: sources(['billing-bot']), // an agent also declares it, but I'd have it regardless
    });
    expect(v.usable_by_me).toBe(true);
    expect(v.inherited_from).toBeNull();
  });

  test('UNSET shared secret (personal override only) is never inherited even if an agent declares it', () => {
    const v = buildSecretView({
      name: 'STRIPE_KEY',
      shared: undefined, // no shared value exists to inherit
      personal: personalRow(),
      subject: SUBJECT,
      canManageShared: false,
      inheritedSources: sources(['billing-bot']),
    });
    // No shared row → nothing to inherit; the personal override is what makes it usable.
    expect(v.inherited_from).toBeNull();
    expect(v.effective_source).toBe('mine');
  });

  test('multiple assigned agents declaring the same secret are all credited', () => {
    const v = buildSecretView({
      name: 'STRIPE_KEY',
      shared: sharedRow('restricted'),
      sharedGrants: [{ principalType: 'member', principalId: OTHER }],
      subject: SUBJECT,
      canManageShared: false,
      inheritedSources: sources(['billing-bot', 'ops-bot']),
    });
    expect(v.inherited_from).toEqual(['billing-bot', 'ops-bot']);
  });
});
