// Shared IAM test mocks. Authz-agnostic suites use lightweight db mocks that
// don't model the IAM role graph, so they bypass that seam here instead of
// re-declaring the same block in every file.
import { mock } from 'bun:test';

/** Bypass the IAM engine, allowing every action. Use only in suites that are
 *  NOT testing authz denial — those keep a role-aware engine mock.
 *
 *  `authorize` / `assertAuthorized` / `listAccessibleResources` are re-exported
 *  from `../iam` via `./dispatcher`, so the mock MUST target the dispatcher. */
export function mockIamEngineAllowAll(): void {
  mock.module('../../iam/dispatcher', () => ({
    authorize: async () => ({ allowed: true }),
    assertAuthorized: async () => {},
    listAccessibleResources: async () => ({ mode: 'all', ids: [] }),
  }));
}
