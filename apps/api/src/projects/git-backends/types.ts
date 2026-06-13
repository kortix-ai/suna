/**
 * Provider-agnostic git hosting backend.
 *
 * Backends own provider-specific URL/repo/token API details. Token resolution
 * stays with the project layer and is handed to `buildUpstream`, so the git
 * proxy can consume one neutral upstream shape.
 */

export type GitScope = 'read' | 'write';

export interface UpstreamGit {
  url: string;
  headers: Record<string, string>;
}

export interface GitConnectionRef {
  provider: string;
  upstreamUrl: string;
  externalRepoId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  installationId: string | null;
  credentialRef: string | null;
  defaultBranch: string;
  managed: boolean;
  metadata: Record<string, unknown>;
}

export interface ProvisionInput {
  accountId: string;
  projectId: string;
  slug: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface ProvisionedRepo {
  provider: string;
  upstreamUrl: string;
  externalRepoId: string | null;
  repoOwner: string | null;
  repoName: string | null;
  installationId: string | null;
  credentialRef: string | null;
  defaultBranch: string;
  initialToken: string | null;
}

export interface SeedFile {
  path: string;
  content: string;
}

export interface GitHostBackend {
  readonly id: string;
  isConfigured(): Promise<boolean>;
  createRepo(input: ProvisionInput): Promise<ProvisionedRepo>;
  deleteRepo(ref: GitConnectionRef): Promise<void>;
  buildUpstream(ref: GitConnectionRef, token: string | null, scope: GitScope): UpstreamGit;
  seedFiles?(
    ref: GitConnectionRef,
    token: string,
    files: SeedFile[],
    opts: { branch: string; message: string; baseFiles?: SeedFile[] },
  ): Promise<void>;
  /**
   * Invite a host user as a collaborator on a MANAGED repo, so the project
   * creator can pull "their" repo into their own host account. Self-resolves an
   * admin-capable credential; only meaningful for managed repos.
   */
  inviteCollaborator?(ref: GitConnectionRef, username: string, scope: GitScope): Promise<InviteResult>;
  /**
   * Mint a short-lived, credential-embedded git URL for pushing to this repo
   * from an EXTERNAL context (e.g. a legacy-migration VM) where `buildUpstream`'s
   * header-based auth can't be threaded into a remote `git push`. The credential
   * is baked into the URL, so the result is a SECRET — never log it. Optional;
   * only managed backends implement it.
   */
  authedPushUrl?(ref: GitConnectionRef): Promise<string>;
}

export interface InviteResult {
  username: string;
  permission: string;
  /** Pending-invitation URL the user accepts, or null if already a collaborator. */
  invitationUrl: string | null;
  alreadyCollaborator: boolean;
}

export function basicAuthHeader(token: string): Record<string, string> {
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}
