// Session-status constants — deliberately dependency-free so lean, hot modules
// (the sandbox reaper, the backpressure counter) can import them without
// pulling in the heavy serializer graph (config, snapshots, github…).
//
// NOTE: the partial index idx_project_sessions_account_active hard-codes this
// exact set in its WHERE predicate. It served the retired account session cap
// and has no reader now; drop it in its own migration.
export const ACTIVE_SESSION_STATUSES = ['queued', 'branching', 'provisioning', 'running'] as const;

export const PROVISIONING_SESSION_STATUSES = ['queued', 'branching', 'provisioning'] as const;
