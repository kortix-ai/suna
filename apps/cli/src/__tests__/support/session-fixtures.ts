import type { Auth } from '../../api/auth.ts';
import type { ProjectSession } from '../../api/types.ts';

/** Shared fixtures for the `attach-opencode` / `session-runtime` unit tests. */

export const auth: Auth = {
  api_base: 'https://api.example.test',
  token: 'kortix_pat_test',
  user_id: 'user-1',
  user_email: 'dev@example.test',
  account_id: 'acct-1',
  logged_in_at: '2026-09-17T00:00:00.000Z',
};

export const session: ProjectSession = {
  session_id: 'abcd1234-0000-0000-0000-000000000000',
  account_id: 'acct-1',
  project_id: 'proj',
  branch_name: 'kortix/test',
  base_ref: 'main',
  sandbox_provider: 'platinum',
  sandbox_id: 'sb-1',
  sandbox_url: null,
  opencode_session_id: 'ses_opencode',
  name: 'Fix the thing',
  custom_name: null,
  agent_name: 'default',
  status: 'running',
  error: null,
  metadata: {},
  created_at: '2026-09-17T00:00:00.000Z',
  updated_at: '2026-09-17T00:00:00.000Z',
};
