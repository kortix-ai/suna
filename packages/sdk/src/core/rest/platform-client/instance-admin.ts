/**
 * Platform API client — managed VPS ("JustAVPS") instance admin: server-type
 * catalog, create/delete, error reporting, the legacy free-computer claim,
 * and the provisioning status/stream endpoints polled by the provisioning UI.
 */

import { backendApi } from '../../http/api-client';
import { getPlatformUrl } from './shared';

export interface ServerType {
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  cpuType: 'shared' | 'dedicated';
  architecture: 'x86' | 'arm';
  priceMonthly: number;
  priceMonthlyMarkup: number;
  location: string;
}

export interface ServerTypesResponse {
  serverTypes: ServerType[];
  location: string;
  defaultServerType?: string;
  defaultLocation?: string;
}

export async function getJustavpsServerTypes(location?: string): Promise<ServerTypesResponse> {
  const params = location ? `?location=${location}` : '';
  const response = await backendApi.get<ServerTypesResponse>(
    `/platform/sandbox/justavps/server-types${params}`,
  );
  if (response.error) {
    if (
      response.error.status === 404 &&
      /justavps provider is not enabled/i.test(response.error.message || '')
    ) {
      return {
        serverTypes: [],
        location: location || 'hel1',
      };
    }
    throw response.error;
  }
  return response.data!;
}

export interface CreateInstanceRequest {
  provider: 'justavps';
  serverType?: string;
  location?: string;
  name?: string;
  backgroundProvisioning?: boolean;
}

export async function createInstance(request: CreateInstanceRequest): Promise<any> {
  const response = await backendApi.post<any>('/platform/sandbox', request, { timeout: 180000 });
  if (response.error) throw response.error;
  return response.data!;
}

export async function deleteInstance(sandboxId: string): Promise<{ success: boolean }> {
  const response = await backendApi.delete<{ success: boolean }>(
    `/platform/sandbox?sandbox_id=${sandboxId}`,
  );
  if (response.error) throw response.error;
  return response.data!;
}

export async function markInstanceError(sandboxId: string, errorMessage: string): Promise<void> {
  await backendApi.post(
    '/platform/sandbox/mark-error',
    { sandbox_id: sandboxId, error_message: errorMessage },
    { showErrors: false, timeout: 10000 },
  );
}

/** Claim a free default computer for legacy paid users. */
export async function claimComputer(): Promise<any> {
  const response = await backendApi.post<any>('/platform/sandbox/claim-computer', {}, { timeout: 60000 });
  if (response.error) throw response.error;
  return response.data!;
}

// ── Provisioning status/stream (polled by useSandboxPoller) ─────────────────

/** Structurally identical to web's `ProvisioningStageInfo` (apps/web/src/lib/provisioning-stages.ts). */
export interface SandboxProvisionStageInfo {
  id: string;
  progress: number;
  message: string;
}

export interface SandboxProvisionStatus {
  status: 'provisioning' | 'active' | 'error' | 'stopped' | 'archived' | 'not_found';
  stage: string | null;
  stageProgress: number | null;
  stageMessage: string | null;
  machineInfo: { ip: string; serverType: string; location: string } | null;
  stages: SandboxProvisionStageInfo[] | null;
  error?: string | null;
  startedAt: string | null;
}

export async function getSandboxProvisionStatus(
  sandboxId: string,
): Promise<SandboxProvisionStatus | null> {
  const res = await backendApi.get<SandboxProvisionStatus>(
    `/platform/sandbox/${sandboxId}/status`,
    { showErrors: false, timeout: 10_000 },
  );
  return res.success ? (res.data ?? null) : null;
}

/**
 * Build the SSE URL for the live provisioning stream. The EventSource
 * transport itself stays in the host app (the SDK has no EventSource-based
 * streaming primitive yet) — this only centralizes the URL + query-string
 * construction so callers don't hardcode `/platform/sandbox/*` paths.
 */
export function getSandboxProvisionStreamUrl(sandboxId: string, token: string): string {
  const base = getPlatformUrl();
  return `${base}/platform/sandbox/${sandboxId}/provision-stream?token=${encodeURIComponent(token)}`;
}
