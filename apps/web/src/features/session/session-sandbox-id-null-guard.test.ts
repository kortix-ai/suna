import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectSessionStartSeed } from '@kortix/sdk';
import type { ProjectSession } from '@kortix/sdk';

// Regression for Better Stack pattern e6d0e044 —
// `TypeError: Cannot read properties of null (reading 'slice')` thrown on the
// co-worker session page (`/projects/:id/sessions/:sessionId`). A render-path
// `.slice()` on `sandbox.sandbox_id` crashed when `sandbox` was truthy but
// `sandbox_id` resolved to `null`. The null reached the page through the
// `SessionCacheWarmer` → `projectSessionStartSeed` cache seed: the
// `project_sessions.sandbox_id` column is nullable (legacy Suna-migration rows
// are minted with it null and provisioning only writes `sandbox_url`), so the
// seed produced a `ProjectSessionSandbox` carrying a `null` `sandbox_id`, which
// `useSession` then handed straight to the page.

const pageSource = readFileSync(
  join(
    import.meta.dir,
    '../../app/(app)/projects/[id]/sessions/[sessionId]/page.tsx',
  ),
  'utf8',
);

function runningSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 'S1',
    project_id: 'P1',
    account_id: 'acct-1',
    branch_name: 'S1',
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: 'sbx-db-1',
    sandbox_url: 'https://api.kortix.com/v1/p/ext-1/8000',
    opencode_session_id: 'oc-1',
    name: null,
    custom_name: null,
    agent_name: 'default',
    status: 'running',
    error: null,
    metadata: {},
    opencode_sessions: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  } satisfies ProjectSession;
}

describe('session-page sandbox_id null guard (BS e6d0e044)', () => {
  test('the page guards sandbox.sandbox_id before calling .slice (no null deref)', () => {
    // The crash site was `sandbox ? \`session ${sandbox.sandbox_id.slice(0, 8)}\` : undefined`.
    // The guard must gate on `sandbox_id` itself, not just `sandbox`, because a
    // truthy sandbox object can still carry a null `sandbox_id`. The guarded
    // form uses optional chaining + a truthy check on the id before the slice.
    expect(pageSource).toContain('sandbox?.sandbox_id');
    expect(pageSource).toContain('sandbox.sandbox_id.slice(0, 8)');
    // The original unguarded ternary — `sandbox ? ... sandbox.sandbox_id.slice`
    // with NO `?.` on sandbox_id — must be gone, otherwise a truthy sandbox
    // with a null id still throws.
    expect(pageSource).not.toContain(
      'sandbox ? `session ${sandbox.sandbox_id.slice(0, 8)}` : undefined',
    );
  });

  test('projectSessionStartSeed drops a running row whose sandbox_id is null (the producer guard)', () => {
    // Happy path: a normal running row with all fields set seeds a ready sandbox.
    const seeded = projectSessionStartSeed(runningSession());
    expect(seeded).not.toBeNull();
    expect(seeded?.sandbox?.sandbox_id).toBe('sbx-db-1');

    // Null sandbox_id (legacy Suna-migration row) MUST NOT seed — otherwise the
    // page receives a truthy sandbox with a null id and crashes on `.slice`.
    // The wire type declares `sandbox_id: string`, but the DB column is nullable
    // (migration rows are minted null and never back-filled), so the runtime
    // path is exercised through a cast here.
    expect(
      projectSessionStartSeed(runningSession({ sandbox_id: null as unknown as string })),
    ).toBeNull();
    // An empty-string id is equally invalid (the label would render "session ").
    expect(projectSessionStartSeed(runningSession({ sandbox_id: '' }))).toBeNull();
  });
});
