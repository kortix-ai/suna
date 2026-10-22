#!/usr/bin/env bun
/**
 * Live, black-box CLI matrix using a real project+session-scoped agent PAT.
 *
 * The runner creates a confirmed Supabase user and a managed project, inserts a
 * real session row, then mints the token through the production
 * createAccountToken() path with session_id + agent_grant. Every CLI assertion
 * launches a child process. The token is never printed.
 *
 * Required:
 *   E2E_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY)
 *   E2E_ANON_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)
 *   DATABASE_URL
 *   API_KEY_SECRET (normally loaded with dotenvx from apps/api/.env)
 *
 * Example for an isolated worktree:
 *   eval "$(supabase --workdir ~/.kortix/worktrees/<name>/sb status -o env)"
 *   E2E_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" E2E_ANON_KEY="$ANON_KEY" \
 *   DATABASE_URL="$DB_URL" E2E_API_URL=http://127.0.0.1:18908/v1 \
 *   E2E_SUPABASE_URL="$API_URL" \
 *   dotenvx run -f apps/api/.env -- bun apps/api/scripts/e2e-cli-agent-token.ts
 */
import { commandMatrix } from './e2e-cli/command-matrix';
import {
  ANON_KEY,
  SERVICE_KEY,
  cleanup,
  deniedGrantBoundary,
  fail,
  failed,
  log,
  passed,
  setup,
} from './e2e-cli/harness';

if (!SERVICE_KEY || !ANON_KEY || !process.env.DATABASE_URL || !process.env.API_KEY_SECRET) {
  throw new Error(
    'E2E_SERVICE_ROLE_KEY, E2E_ANON_KEY, DATABASE_URL, and API_KEY_SECRET are required',
  );
}

try {
  await setup();
  await commandMatrix();
  await deniedGrantBoundary();
} catch (error) {
  fail();
  log(`FATAL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup();
}

log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
