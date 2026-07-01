import type { Effect } from 'effect';
// Session-status constants — deliberately dependency-free so lean, hot modules
// (the sandbox reaper, the concurrency-cap counter) can import them without
// pulling in the heavy serializer graph (config, snapshots, github…).
//
// NOTE: the partial index idx_project_sessions_account_active (see
// packages/db/drizzle/20260617102106_account_active_session_index.sql) hard-codes
// this exact set in its WHERE predicate to keep the concurrency-cap COUNT fast.
// If you change these statuses, update that index's predicate in a new migration
// or the planner will silently stop using it.
export const ACTIVE_SESSION_STATUSES = ['queued', 'branching', 'provisioning', 'running'] as const;

export const PROVISIONING_SESSION_STATUSES = ['queued', 'branching', 'provisioning'] as const;
