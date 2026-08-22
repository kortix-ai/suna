import { describe, expect, test } from 'bun:test';

import { providerQueryPlan } from './provider-load-plan';

/**
 * Gateway mode is the only mode. Inside a project route the provider list is
 * ALWAYS the gateway's `/model-picker` answer — never the sandbox's own
 * `provider.list`, never gated on project detail, never gated on the runtime
 * being up (the picker must paint before the sandbox boots). Outside a
 * project route there is no model-picker to ask, so the runtime's own list is
 * the only source, and only once the runtime is reachable.
 */
describe('providerQueryPlan', () => {
  test('a project route loads the gateway model-picker before the runtime is ready', () => {
    expect(providerQueryPlan({ projectId: 'project-1', runtimeReady: false })).toEqual({
      gateway: true,
      runtime: false,
    });
  });

  test('a project route never falls back to the runtime provider list, even when ready', () => {
    expect(providerQueryPlan({ projectId: 'project-1', runtimeReady: true })).toEqual({
      gateway: true,
      runtime: false,
    });
  });

  test('outside a project route the runtime list loads once the runtime is ready', () => {
    expect(providerQueryPlan({ projectId: null, runtimeReady: true })).toEqual({
      gateway: false,
      runtime: true,
    });
  });

  test('outside a project route nothing loads before the runtime is ready', () => {
    expect(providerQueryPlan({ projectId: null, runtimeReady: false })).toEqual({
      gateway: false,
      runtime: false,
    });
  });
});
