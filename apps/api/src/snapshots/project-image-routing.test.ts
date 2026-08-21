import { describe, expect, test } from 'bun:test';
import {
  projectImageNameMatchesIdentity,
  projectImageReadCandidates,
  projectImageWriteName,
  type ProjectImageRollout,
} from './project-image-routing';
import {
  legacyPerProjectWarmImageName,
  perProjectWarmImageName,
  scopedPerProjectWarmImageName,
} from './ppwarm-names';

const PROJECT = '0945686d-1111-2222-3333-444455556666';
const TIP = 'a'.repeat(40);
const BASE = 'kortix-default-r1';
const SLUG = 'default';
const SCOPE = '123456789abc';

const fast: ProjectImageRollout = {
  fastConfigured: true,
  fastEnabled: true,
  dataPlaneScope: SCOPE,
};
const explicitRollback: ProjectImageRollout = {
  fastConfigured: true,
  fastEnabled: false,
  dataPlaneScope: SCOPE,
};
const legacy: ProjectImageRollout = {
  fastConfigured: false,
  fastEnabled: false,
  dataPlaneScope: SCOPE,
};

describe('project image routing', () => {
  test('FAST writes scoped and reads scoped before both existing formats', () => {
    const scoped = scopedPerProjectWarmImageName(SCOPE, PROJECT, TIP, BASE, SLUG);
    const unscoped = perProjectWarmImageName(PROJECT, TIP, BASE, SLUG);
    const old = legacyPerProjectWarmImageName(PROJECT, TIP, BASE);

    expect(projectImageWriteName(PROJECT, TIP, BASE, SLUG, fast)).toBe(scoped);
    expect(projectImageReadCandidates(PROJECT, TIP, BASE, SLUG, true, fast)).toEqual([
      { name: scoped, format: 'scoped' },
      { name: unscoped, format: 'unscoped' },
      { name: old, format: 'legacy' },
    ]);
  });

  test('explicit rollback and an absent FAST flag preserve existing writes and reads', () => {
    const unscoped = perProjectWarmImageName(PROJECT, TIP, BASE, SLUG);
    const old = legacyPerProjectWarmImageName(PROJECT, TIP, BASE);

    for (const rollout of [explicitRollback, legacy]) {
      expect(projectImageWriteName(PROJECT, TIP, BASE, SLUG, rollout)).toBe(unscoped);
      expect(projectImageReadCandidates(PROJECT, TIP, BASE, SLUG, true, rollout)).toEqual([
        { name: unscoped, format: 'unscoped' },
        { name: old, format: 'legacy' },
      ]);
    }
  });

  test('never offers the template-less legacy image to a custom template', () => {
    expect(projectImageReadCandidates(PROJECT, TIP, BASE, 'custom', false, fast)).toEqual([
      {
        name: scopedPerProjectWarmImageName(SCOPE, PROJECT, TIP, BASE, 'custom'),
        format: 'scoped',
      },
      {
        name: perProjectWarmImageName(PROJECT, TIP, BASE, 'custom'),
        format: 'unscoped',
      },
    ]);
  });

  test('does not require a valid scoped key while FAST is inactive', () => {
    expect(
      projectImageWriteName(PROJECT, TIP, BASE, SLUG, {
        ...explicitRollback,
        dataPlaneScope: 'not-used',
      }),
    ).toBe(perProjectWarmImageName(PROJECT, TIP, BASE, SLUG));
  });

  test('validates durable names from each compatible rollout format', () => {
    const scoped = scopedPerProjectWarmImageName(SCOPE, PROJECT, TIP, BASE, SLUG);
    const priorPlaneScoped = scopedPerProjectWarmImageName(
      '2'.repeat(12),
      PROJECT,
      TIP,
      BASE,
      SLUG,
    );
    const unscoped = perProjectWarmImageName(PROJECT, TIP, BASE, SLUG);
    const old = legacyPerProjectWarmImageName(PROJECT, TIP, BASE);

    expect(projectImageNameMatchesIdentity(scoped, PROJECT, TIP, BASE, SLUG, true)).toBe(
      true,
    );
    expect(
      projectImageNameMatchesIdentity(priorPlaneScoped, PROJECT, TIP, BASE, SLUG, true),
    ).toBe(true);
    expect(projectImageNameMatchesIdentity(unscoped, PROJECT, TIP, BASE, SLUG, true)).toBe(
      true,
    );
    expect(projectImageNameMatchesIdentity(old, PROJECT, TIP, BASE, SLUG, true)).toBe(true);
    expect(projectImageNameMatchesIdentity(old, PROJECT, TIP, BASE, 'custom', false)).toBe(
      false,
    );
    expect(
      projectImageNameMatchesIdentity(scoped, PROJECT, `${TIP}x`, BASE, SLUG, true),
    ).toBe(false);
    expect(
      projectImageNameMatchesIdentity(scoped, `${PROJECT}x`, TIP, BASE, SLUG, true),
    ).toBe(false);
    expect(
      projectImageNameMatchesIdentity(scoped, PROJECT, TIP, `${BASE}-next`, SLUG, true),
    ).toBe(false);
    expect(
      projectImageNameMatchesIdentity(scoped, PROJECT, TIP, BASE, 'custom', true),
    ).toBe(false);
    expect(projectImageNameMatchesIdentity('kpp2-not-valid', PROJECT, TIP, BASE, SLUG, true)).toBe(
      false,
    );
  });
});
