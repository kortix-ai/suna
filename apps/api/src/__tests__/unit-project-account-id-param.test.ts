import { describe, expect, test } from 'bun:test';
import { projectsApp } from '../projects/lib/app';
// Importing the routes module registers the account-scoped GitHub routes on
// `projectsApp`. No mocks: the request must die at the guard, before any
// database access.
import { registerGithubInstallationsRoutes } from '../projects/routes/github-installations';
registerGithubInstallationsRoutes();

// A malformed `account_id` used to flow from the query string through
// `resolveProjectAccount` into the account-membership lookup, whose
// `account_id` comparison targets a uuid column. Postgres rejected the
// parameter (SQLSTATE 22P02) and the route answered 500 "Internal server
// error" instead of a validation error (dogfood journey proj-create-github-byo,
// GET /v1/projects/github/installations?account_id=not-a-uuid → 500).
// `resolveProjectAccount` now refuses a non-uuid account_id before any lookup;
// these tests pin that through the real route module.

const MALFORMED = 'not-a-uuid';

describe('malformed account_id is a 400, not a 500', () => {
  test('GET /github/installations?account_id=not-a-uuid answers 400 with a code', async () => {
    const res = await projectsApp.request(`/github/installations?account_id=${MALFORMED}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe(true);
    expect(body.status).toBe(400);
    expect(body.code).toBe('invalid_account_id');
    expect(body.message).toBe('account_id must be a valid id');
  });

  test('GET /github/installation?account_id=not-a-uuid answers 400 too', async () => {
    const res = await projectsApp.request(`/github/installation?account_id=${MALFORMED}`);
    expect(res.status).toBe(400);
  });
});
