/**
 * Deployment provider adapter interface.
 *
 * The Kortix API stays provider-agnostic; concrete providers (Freestyle
 * today, Vercel/Cloudflare/etc. tomorrow) implement this surface and are
 * looked up by name through the registry in ./index.ts.
 *
 * Keep the request/result shape minimal — only fields shared across the
 * `[[apps]]` workflow live here. Provider-specific knobs belong inside the
 * adapter implementation, not the interface.
 */

export type AppSourceGit = {
  type: 'git';
  /** Full clone URL — `https://...` or `git@...`. */
  repo: string;
  /** Optional branch / tag / sha. */
  branch?: string;
  /** Subdirectory inside the repo (monorepo case). */
  rootPath?: string;
};

export type AppSourceTar = {
  type: 'tar';
  /** Pre-built tarball URL. */
  url: string;
};

export type AppSource = AppSourceGit | AppSourceTar;

export interface AppBuild {
  command?: string;
  outDir?: string;
  envVars?: Record<string, string>;
}

export interface DeploymentRequest {
  accountId: string;
  projectId: string;
  appSlug: string;
  source: AppSource;
  domains: string[];
  build?: AppBuild;
  env?: Record<string, string>;
  framework?: string;
}

export interface DeploymentResult {
  /** Opaque ID minted by the upstream provider — what we hand back to
   *  stop()/logs() later. */
  providerId: string;
  /** Best public URL we can compute (first domain, schemed). null if
   *  the provider didn't return one. */
  liveUrl: string | null;
  status: 'active' | 'failed';
  error?: string;
}

export interface DeploymentProvider {
  /** Stable id used by the registry + persisted in `deployments.provider`. */
  readonly name: string;
  /** Create (or re-create) the deployment. Must not throw on upstream
   *  failure — return `{ status: 'failed', error }` so the caller can
   *  still persist the attempt. */
  deploy(req: DeploymentRequest): Promise<DeploymentResult>;
  /** Tear down by provider id. Best-effort; safe to call on already-stopped. */
  stop(providerId: string): Promise<void>;
  /** Fetch logs for a given deployment. Shape is provider-defined. */
  logs(providerId: string): Promise<unknown>;
}
