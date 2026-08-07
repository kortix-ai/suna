import { describe, expect, test } from 'bun:test';

import { PHASE_LABELS, PHASE_ORDER, phaseStatuses } from './provision-phases';

describe('phaseStatuses', () => {
  test('everything is pending before the first event', () => {
    expect(phaseStatuses(null).map((p) => p.state)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  test('the current phase is active and everything before it is done', () => {
    expect(phaseStatuses('registering').map((p) => p.state)).toEqual([
      'done',
      'done',
      'active',
      'pending',
    ]);
  });

  test('the last phase leaves nothing pending', () => {
    expect(phaseStatuses('seeding').map((p) => p.state)).toEqual([
      'done',
      'done',
      'done',
      'active',
    ]);
  });

  test('an early phase leaves everything after it pending, not done', () => {
    // Paired with the "registering" case above so a reversed comparison
    // (`index > currentIndex` instead of `<`) cannot pass both.
    expect(phaseStatuses('creating_repository').map((p) => p.state)).toEqual([
      'done',
      'active',
      'pending',
      'pending',
    ]);
  });

  test('labels are human, not wire names', () => {
    expect(phaseStatuses('creating_repository')[1]?.label).toBe('Creating repository');
    expect(phaseStatuses('creating_repository')[1]?.label).not.toBe('creating_repository');
  });

  test('phase field carries the wire value, in server order', () => {
    expect(phaseStatuses(null).map((p) => p.phase)).toEqual([
      'validating',
      'creating_repository',
      'registering',
      'seeding',
    ]);
  });
});

describe('PHASE_ORDER / PHASE_LABELS', () => {
  test('every phase in PHASE_ORDER has a human label', () => {
    for (const phase of PHASE_ORDER) {
      expect(typeof PHASE_LABELS[phase]).toBe('string');
      expect(PHASE_LABELS[phase].length).toBeGreaterThan(0);
    }
  });

  test('exactly the four phases the server reports, in its order', () => {
    expect(PHASE_ORDER).toEqual(['validating', 'creating_repository', 'registering', 'seeding']);
  });
});
