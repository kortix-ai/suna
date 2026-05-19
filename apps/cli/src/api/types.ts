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
