import { describe, expect, test } from 'bun:test';
import { runAppHostingReaper } from './hosting-reaper';

describe('Apps managed-hosting reaper', () => {
  test('passes the complete protected set to the hosting backend', async () => {
    const observed: unknown[] = [];
    const result = await runAppHostingReaper(new Date('2026-08-17T12:00:00.000Z'), {
      enabled: true,
      loadProtected: async () => ({
        deploymentIds: new Set(['deployment-1']),
        externalIds: new Set(['service-1']),
      }),
      reconcile: async (input) => {
        observed.push(input);
        return {
          contextsListed: 0,
          imagesListed: 0,
          servicesListed: 1,
          contextsDeleted: 0,
          imagesDeleted: 0,
          servicesDeleted: 1,
          errors: 0,
        };
      },
      graceMs: 60_000,
      maxDeletes: 7,
    });

    expect(result).toMatchObject({ servicesDeleted: 1, errors: 0 });
    expect(observed).toEqual([{
      protectedDeploymentIds: new Set(['deployment-1']),
      protectedExternalIds: new Set(['service-1']),
      now: new Date('2026-08-17T12:00:00.000Z'),
      graceMs: 60_000,
      maxDeletes: 7,
    }]);
  });

  test('fails closed before provider listing when the DB protection lookup fails', async () => {
    let reconcileCalls = 0;
    await expect(runAppHostingReaper(new Date(), {
      enabled: true,
      loadProtected: async () => { throw new Error('database unavailable'); },
      reconcile: async () => {
        reconcileCalls += 1;
        return null;
      },
      graceMs: 60_000,
      maxDeletes: 7,
    })).rejects.toThrow('database unavailable');
    expect(reconcileCalls).toBe(0);
  });

  test('does not query the DB when Lightsail hosting is disabled', async () => {
    let lookupCalls = 0;
    const result = await runAppHostingReaper(new Date(), {
      enabled: false,
      loadProtected: async () => {
        lookupCalls += 1;
        return { deploymentIds: new Set(), externalIds: new Set() };
      },
      reconcile: async () => null,
      graceMs: 60_000,
      maxDeletes: 7,
    });
    expect(result).toBeNull();
    expect(lookupCalls).toBe(0);
  });
});
