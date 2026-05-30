// Response shapes for the API endpoints the CLI talks to. Keep in sync with
// apps/api/src/accounts/index.ts and apps/api/src/projects/index.ts.

export interface AccountMembership {
  account_id: string;
  slug: string;
  name: string;
  personal_account: boolean;
  role: string;
}

export interface MeResponse {
  user_id: string;
  email: string;
  accounts: AccountMembership[];
}

export interface ProjectSummary {
  project_id: string;
  account_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  manifest_path: string;
  status: 'active' | 'archived';
  metadata?: Record<string, unknown>;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
  /** Web dashboard URL for this project (server-provided; not the API host). */
  dashboard_url?: string;
}

// ── Secrets ───────────────────────────────────────────────────────────────

export interface ProjectSecret {
  secret_id: string;
  project_id: string;
  name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectSecretsResponse {
  items: ProjectSecret[];
  required: string[];
  optional: string[];
  manifest_status: 'loaded' | 'missing' | 'error';
  manifest_path: string | null;
  manifest_error?: string;
}

// ── Provider OAuth ───────────────────────────────────────────────────────

export interface OauthCredentialSummary {
  provider_id: string;
  expires_in_ms: number | null;
  updated_at: string;
}

export interface OauthListResponse {
  items: OauthCredentialSummary[];
}

export interface OauthFlowStartResponse {
  flow_id: string;
  verification_url: string;
  user_code: string;
  expires_at: number;
  interval_ms: number;
}

export type OauthPollResponse =
  | {
      status: 'pending';
      next_poll_ms?: number;
    }
  | {
      status: 'success';
      credential: OauthCredentialSummary;
    }
  | {
      status: 'expired';
    }
  | {
      status: 'failed';
      error: string;
    };

// ── Sessions ──────────────────────────────────────────────────────────────

export interface ProjectSession {
  session_id: string;
  account_id: string;
  project_id: string;
  branch_name: string;
  base_ref: string;
  sandbox_provider: string;
  sandbox_id: string;
  sandbox_url: string | null;
  opencode_session_id: string | null;
  name: string | null;
  agent_name: string;
  status:
    | 'queued'
    | 'branching'
    | 'provisioning'
    | 'running'
    | 'stopped'
    | 'failed'
    | 'completed';
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Triggers ──────────────────────────────────────────────────────────────

export interface ProjectTrigger {
  slug: string;
  path: string;
  name: string;
  type: 'cron' | 'webhook';
  agent: string;
  enabled: boolean;
  cron: string | null;
  timezone: string;
  secret_env: string | null;
  prompt_template: string;
  last_fired_at: string | null;
  webhook_url: string | null;
}

export interface ProjectTriggersResponse {
  triggers: ProjectTrigger[];
  errors: Array<{ path: string; error: string }>;
}

export interface TriggerFireResponse {
  status: 'queued' | 'fired';
  reason?: string | null;
  session_id?: string | null;
}

// ── Change Requests ───────────────────────────────────────────────────────

export type ChangeRequestStatus = 'open' | 'merged' | 'closed';

export interface ChangeRequest {
  cr_id: string;
  account_id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  base_ref: string;
  head_ref: string;
  status: ChangeRequestStatus;
  head_commit_sha: string | null;
  base_commit_sha: string | null;
  origin_session_id: string | null;
  created_by: string;
  merged_at: string | null;
  merged_by: string | null;
  merge_commit_sha: string | null;
  closed_at: string | null;
  closed_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ChangeRequestsListResponse {
  change_requests: ChangeRequest[];
}

export interface ChangeRequestDetailResponse {
  change_request: ChangeRequest;
}

export interface ChangeRequestFile {
  path: string;
  old_path: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
  additions: number;
  deletions: number;
}

export interface ChangeRequestDiffResponse {
  cr_id: string;
  base_ref: string;
  head_ref: string;
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
  files: ChangeRequestFile[];
  files_changed: number;
  additions: number;
  deletions: number;
  patch: string;
}

export interface ChangeRequestMergePreview {
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
  can_fast_forward: boolean;
  can_merge: boolean;
  conflicts: string[];
  is_up_to_date: boolean;
}

export interface ChangeRequestMergeResponse {
  change_request: ChangeRequest;
  merge: {
    merge_commit_sha: string;
    fast_forward: boolean;
    base_sha_before: string;
    base_sha_after: string;
  };
}
