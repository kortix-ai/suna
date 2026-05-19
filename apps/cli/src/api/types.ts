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
