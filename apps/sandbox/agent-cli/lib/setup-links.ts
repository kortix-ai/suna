/**
 * Setup-link minting — the agent's way to hand a human a short-lived link to
 * (a) enter a project secret value, or (b) 1-click connect a Pipedream app
 * (Quick Connect). The agent NEVER sees the value / never holds a raw key; it
 * just surfaces the URL. The web UI renders the URL as a fill-in modal; Slack
 * renders it as a tappable link.
 *
 * These hit the project-scoped mint endpoints (NOT the executor gateway), so
 * they use the generic kortix client (KORTIX_TOKEN) + KORTIX_PROJECT_ID.
 */
import { CliError } from './cli';
import { kortixPost } from './api';
import { kortixProjectId } from './env';

export interface SecretLinkResult {
  kind: 'secret';
  url: string;
  names: string[];
  scope: string;
  expires_at: string;
}

export interface ConnectLinkResult {
  kind: 'connector';
  url: string;
  slug: string;
  app: string | null;
  expires_at: string;
}

function projectId(): string {
  const id = kortixProjectId();
  if (!id) throw new CliError('KORTIX_PROJECT_ID not set — cannot mint a setup link.', 'MISSING_ENV');
  return id;
}

export async function mintSecretLink(opts: {
  names: string[];
  scope?: 'runtime' | 'connector';
  expiresInMinutes?: number;
  labels?: Record<string, string>;
  descriptions?: Record<string, string>;
}): Promise<SecretLinkResult> {
  if (opts.names.length === 0) throw new CliError('at least one secret name is required', 'USAGE');
  return kortixPost<SecretLinkResult>(`/projects/${projectId()}/secret-requests`, {
    names: opts.names,
    scope: opts.scope,
    expires_in_minutes: opts.expiresInMinutes,
    labels: opts.labels,
    descriptions: opts.descriptions,
  });
}

export async function mintConnectLink(opts: {
  slug: string;
  expiresInMinutes?: number;
}): Promise<ConnectLinkResult> {
  if (!opts.slug) throw new CliError('connector slug is required', 'USAGE');
  return kortixPost<ConnectLinkResult>(`/projects/${projectId()}/connect-requests`, {
    slug: opts.slug,
    expires_in_minutes: opts.expiresInMinutes,
  });
}
