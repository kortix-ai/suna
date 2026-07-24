import { describe, expect, test } from 'bun:test';
import type { ProviderTransitionRow } from './provider-transition-store';
import {
  serializeTransition,
  toPublicTransitionState,
  toPublicTransitionView,
  type PreparationView,
} from './provider-transition-view';

function fakeRow(overrides: Partial<ProviderTransitionRow> = {}): ProviderTransitionRow {
  return {
    transitionId: 't-1',
    projectId: 'p-1',
    status: 'building',
    sourceProvider: 'daytona',
    targetProvider: 'platinum',
    generation: 3,
    snapshotName: 'kortix-ppwarm-p1-secretimage',
    externalTemplateId: 'tpl_internal_secret',
    commitSha: 'deadbeef',
    attempts: 2,
    lastError: 'platinum GET /v1/templates -> 500 internal stack trace leaked here',
    errorClass: 'transient',
    requestedAt: new Date('2026-01-01T00:00:00.000Z'),
    readyAt: null,
    activatedAt: null,
    ...overrides,
  } as unknown as ProviderTransitionRow;
}

describe('serializeTransition (FIX-L discriminant)', () => {
  test('carries the kind:"preparation" discriminant', () => {
    const v = serializeTransition(fakeRow(), 'daytona');
    expect(v.kind).toBe('preparation');
  });

  test('preserves the internal fields for the PATCH prepare body (unchanged wire reality)', () => {
    const v = serializeTransition(fakeRow(), 'daytona');
    expect(v.snapshot_name).toBe('kortix-ppwarm-p1-secretimage');
    expect(v.external_template_id).toBe('tpl_internal_secret');
    expect(v.last_error).toContain('internal stack trace');
    expect(v.attempts).toBe(2);
    expect(v.active_provider).toBe('daytona');
  });
});

describe('toPublicTransitionView (FIX-L public projection)', () => {
  const pub = toPublicTransitionView(serializeTransition(fakeRow(), 'daytona'));

  test('DROPS internal build/lease detail — no raw error string, image name, template id, or attempts', () => {
    expect('last_error' in pub).toBe(false);
    expect('snapshot_name' in pub).toBe(false);
    expect('external_template_id' in pub).toBe(false);
    expect('attempts' in pub).toBe(false);
    // No lease_epoch / lease-holder ever exists on PreparationView, so it cannot leak.
    expect('lease_epoch' in pub).toBe(false);
    // The poll response is a single shape, not the PATCH union — no discriminant.
    expect('kind' in pub).toBe(false);
  });

  test('exposes status / providers / generation / timestamps / user-safe error class + label', () => {
    expect(pub.status).toBe('building');
    expect(pub.source_provider).toBe('daytona');
    expect(pub.target_provider).toBe('platinum');
    expect(pub.generation).toBe(3);
    expect(pub.error_class).toBe('transient'); // the CLASS, not the raw string
    expect(pub.requested_at).toBe('2026-01-01T00:00:00.000Z');
    expect(pub.ready_at).toBeNull();
    expect(typeof pub.label).toBe('string');
    expect(pub.label.length).toBeGreaterThan(0);
  });
});

describe('toPublicTransitionState', () => {
  test('maps latest + history through the public projection and preserves active_provider', () => {
    const latest: PreparationView = serializeTransition(fakeRow({ transitionId: 't-new' }), 'daytona');
    const older: PreparationView = serializeTransition(
      fakeRow({ transitionId: 't-old', status: 'failed' }),
      'daytona',
    );
    const state = toPublicTransitionState({ active_provider: 'daytona', latest, history: [latest, older] });
    expect(state.active_provider).toBe('daytona');
    expect(state.latest?.transition_id).toBe('t-new');
    expect(state.history).toHaveLength(2);
    // Every history item is the stripped public shape.
    for (const item of state.history) {
      expect('last_error' in item).toBe(false);
      expect('snapshot_name' in item).toBe(false);
    }
  });

  test('null latest maps to null (no transition yet)', () => {
    const state = toPublicTransitionState({ active_provider: null, latest: null, history: [] });
    expect(state.latest).toBeNull();
    expect(state.history).toEqual([]);
  });
});
