// Public sandbox share links — `/v1/p/share`. Sandbox-scoped, NOT project-
// scoped: the route takes a `sandbox_id` (the sandbox's external id), never a
// Kortix project id, and proxies through to the sandbox daemon's own
// `/kortix/share` endpoints (see apps/api/src/sandbox-proxy/routes/share.ts).
// Lives in `projects-client` for barrel/discoverability reasons even though
// its URLs sit outside `/projects`.

import { backendApi } from '../api-client';
import { unwrap } from './shared';

export interface PublicSandboxShare {
  url: string;
  port: number;
  token: string;
  expiresAt: string;
  label?: string;
}

export interface CreateSandboxShareInput {
  sandboxId: string;
  port: number;
  ttl?: string;
  label?: string;
}

export interface CreateSandboxShareResponse {
  url: string;
  expiresAt?: string;
  label?: string;
}

/** Every active public share link for a sandbox. */
export async function listSandboxShares(sandboxId: string): Promise<PublicSandboxShare[]> {
  const data = unwrap(
    await backendApi.get<{ shares?: PublicSandboxShare[] }>(
      `/p/share?sandbox_id=${encodeURIComponent(sandboxId)}`,
    ),
    'Failed to load public links',
  );
  return data.shares ?? [];
}

/** Create a token-gated public URL for a sandbox port. */
export async function createSandboxShare(
  input: CreateSandboxShareInput,
): Promise<CreateSandboxShareResponse> {
  return unwrap(
    await backendApi.post<CreateSandboxShareResponse>('/p/share', {
      sandbox_id: input.sandboxId,
      port: input.port,
      ttl: input.ttl,
      label: input.label,
    }),
    'Failed to generate public URL',
  );
}

/** Revoke a public share link by its token. */
export async function revokeSandboxShare(sandboxId: string, token: string): Promise<void> {
  const res = await backendApi.delete(
    `/p/share/${encodeURIComponent(token)}?sandbox_id=${encodeURIComponent(sandboxId)}`,
  );
  if (!res.success) throw new Error(res.error?.message ?? 'Failed to revoke public link');
}
