/**
 * Every `kortix` table that carries `account_id` or `project_id`, by what it
 * becomes when the account and the project fold into the workspace
 * (.agents/skills/learnings/work/workspaces/design.md §1.2, §6.2). Release 2
 * and Release 3 migrate by these classes; `workspace-key-classes.test.ts`
 * fails on a table that is in no class or in a class its columns contradict,
 * so a new table is classified the day it lands.
 *
 *   core                      the three tables the workspace is made of.
 *   expand                    account_id only; gains workspace_id in Release 1
 *                             (M7, kortix.workspace_expand_tables()), drops
 *                             account_id in Release 3.
 *   excluded                  account_id only; keeps it (person-keyed, records
 *                             that outlive the workspace, or a later design).
 *   workspace_owned           both keys, project_id NOT NULL: project_id is
 *                             renamed workspace_id, account_id dropped (R3).
 *   workspace_owned_nullable  both keys, project_id NULL means account-wide:
 *                             R2 fills it with the workspace id, then as above.
 *   ledger                    history: keeps the payer at the time as
 *                             legacy_account_id, never rewritten (R3 renames).
 *   project_only              project_id only: renamed workspace_id (R3).
 */

export const WORKSPACE_KEY_CLASSES = {
  core: ['accounts', 'projects', 'workspaces'],
  expand: [
    'account_deletion_requests',
    'account_github_installation_states',
    'account_github_installations',
    'account_github_user_tokens',
    'account_groups',
    'account_invitations',
    'account_memberships',
    'account_scim_users',
    'account_secret_grants',
    'account_session_activity',
    'account_sso_group_mappings',
    'account_sso_providers',
    'api_keys',
    'app_runtimes',
    'app_site_blobs',
    'app_site_files',
    'app_volumes',
    'audit_reconciliation_state',
    'audit_webhooks',
    'billing_customers',
    'capture_device_grants',
    'capture_devices',
    'capture_enrollment_tokens',
    'capture_enrollments',
    'capture_workspaces',
    'claude_subscription_logins',
    'cli_device_grants',
    'credit_accounts',
    'credit_ledger',
    'credit_purchases',
    'credit_usage',
    'enterprise_contracts',
    'oauth_access_tokens',
    'oauth_authorization_codes',
    'oauth_clients',
    'provider_events',
    'roles',
    'sandbox_compute_sessions',
    'scim_tokens',
    'timeline_actions',
    'timeline_audio',
    'timeline_chunks',
    'timeline_frames',
    'yolo_member_tokens',
  ],
  excluded: [
    // Person-keyed.
    'platform_user_roles',
    'feedback',
    'chrome_connections',
    'free_credit_claims',
    // Records that outlive the workspace.
    'workspace_name_backups',
    'retention_erasures',
    // Mixed person/workspace namespace: their own design in Release 2.
    'tunnel_connections',
    'tunnel_permissions',
    'tunnel_permission_requests',
    'tunnel_rpc_forwards',
    // Legacy and unused.
    'sandboxes',
    'account_subscription_ends',
    // Normalized in Release 2b (scope_type 'workspace').
    'role_assignments',
    // Not in the design.md §6.2 lists (2026-11-06). A workspace-owned credential
    // like oauth_access_tokens: classify before Release 2.
    'oauth_refresh_tokens',
    // Credit codes (dev, 2026-11-06): one redemption per code and account, a
    // money record that outlives the workspace. Release 2 decides whether the
    // limit is per workspace or per person.
    'credit_code_redemptions',
  ],
  workspace_owned: [
    'app_artifacts',
    'apps',
    'artifacts',
    'change_requests',
    'connection_oauth_applications',
    'connection_oauth_sessions',
    'connector_attachments',
    'connector_calls',
    'connector_connections',
    'connector_held_calls',
    'connectors',
    'gateway_api_keys',
    'project_access_requests',
    // Goals (dev, 2026-11-06): a goal belongs to the project.
    'project_goals',
    'project_git_connections',
    'project_git_credentials',
    'project_monitor_boxes',
    'project_session_connector_bindings',
    'project_session_groups',
    'project_session_public_shares',
    'project_sessions',
    'project_snapshot_builds',
    'project_spaces',
    'project_trigger_event_polls',
    'project_trigger_event_subscriptions',
    'prompt_attachments',
    'provider_transitions',
    'review_items',
    'rooms',
    'session_content_purges',
    'session_idle_watches',
    'session_lifecycle_commands',
    'session_logs',
    'session_pending_permissions',
    'session_pending_questions',
    'session_runtime_projections',
    'session_sandbox_identities',
    'session_sandboxes',
    'session_turns',
  ],
  workspace_owned_nullable: [
    'account_model_preferences',
    'account_secret_resources',
    // NULL project_id = a personal key: stays NULL (design.md §4 step 6).
    'account_tokens',
    'drives',
    'sandbox_templates',
    'service_accounts',
  ],
  ledger: [
    'audit_activity_daily',
    'audit_events',
    'claude_subscription_login_flows',
    'gateway_request_logs',
    'legacy_sandbox_migrations',
    'notifications',
    'storage_charges',
    'suna_account_migrations',
    'tunnel_audit_logs',
    'tunnel_device_auth_requests',
    'usage_events',
  ],
  project_only: [
    // A goal's event log carries project_id only (dev, 2026-11-06).
    'project_goal_events',
    'artifact_comment_screenshot_objects',
    'artifact_comment_threads',
    'artifact_events',
    'base_tip_checks',
    'chat_channel_bindings',
    'chat_installs',
    'chat_pending_auth_messages',
    'chat_threads',
    'chat_turn_streams',
    'chrome_attachments',
    'chrome_grants',
    'config_release_failures',
    'config_release_heads',
    'config_releases',
    'connector_project_policies',
    'connector_project_settings',
    'connector_sync_fences',
    'drive_grants',
    'gateway_budgets',
    'gateway_otel_configs',
    'gateway_spend_daily',
    'notification_watchers',
    'project_config_summaries',
    'project_llm_routing_policies',
    'project_monitor_events',
    'project_secret_requests',
    'project_secret_tombstones',
    'project_secrets',
    'project_session_secret_handles',
    'project_signing_keys',
    'project_snapshot_archives',
    'project_space_links',
    'project_space_watchers',
    'project_trigger_executions',
    'project_trigger_runtime',
    'project_trigger_session_access_grants',
    'project_user_marks',
    'project_user_provider_connections',
    'room_members',
    'session_peer_messages',
    'session_tasks',
    'session_tool_approvals',
    'teams_pending_uploads',
    'trigger_watchers',
    'voice_call_read_cursors',
    'voice_call_turns',
    'voice_join_links',
    // The split ledger: a record of moves, never renamed.
    'workspace_split_runs',
  ],
} as const satisfies Record<string, readonly string[]>;

export type WorkspaceKeyClass = keyof typeof WORKSPACE_KEY_CLASSES;

/** The class of a `kortix` table, or null when it carries neither key. */
export function workspaceKeyClassOf(table: string): WorkspaceKeyClass | null {
  for (const [klass, tables] of Object.entries(WORKSPACE_KEY_CLASSES) as Array<[WorkspaceKeyClass, readonly string[]]>) {
    if (tables.includes(table)) return klass;
  }
  return null;
}
