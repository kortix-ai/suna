/** Generic instance administration and provisioning status surfaces. */

import { retiredEndpointError } from '../../http/api/errors';

/** @deprecated The standalone VPS catalog was retired. */
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

/** @deprecated The standalone VPS catalog was retired. */
export interface ServerTypesResponse {
  serverTypes: ServerType[];
  location: string;
  defaultServerType?: string;
  defaultLocation?: string;
}

/**
 * @deprecated The standalone VPS catalog was retired. This compatibility stub
 * remains only so existing npm consumers do not fail to import the SDK.
 */
export async function getJustavpsServerTypes(location?: string): Promise<ServerTypesResponse> {
  return { serverTypes: [], location: location || 'hel1' };
}

/** @deprecated Standalone instance provisioning was retired. */
export interface CreateInstanceRequest {
  provider: 'justavps';
  serverType?: string;
  location?: string;
  name?: string;
  backgroundProvisioning?: boolean;
}

/**
 * @deprecated Standalone instance provisioning was retired. The supported
 * sandbox provider contract is `daytona | platinum | e2b`.
 */
export async function createInstance(_request: CreateInstanceRequest): Promise<never> {
  throw new Error(
    'Retired instance provisioning is unavailable. Create a project session with daytona, platinum, or e2b.',
  );
}

/** @deprecated The account-level sandbox was removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function deleteInstance(_sandboxId: string): Promise<{ success: boolean }> {
  throw retiredEndpointError('deleteInstance');
}

/**
 * @deprecated The account-level sandbox was removed from the API. A no-op: it
 * was best-effort and never threw, so it still resolves without a request.
 */
export async function markInstanceError(_sandboxId: string, _errorMessage: string): Promise<void> {}

/** @deprecated The legacy free computer was removed from the API. Always rejects with `ENDPOINT_RETIRED`. */
export async function claimComputer(): Promise<any> {
  throw retiredEndpointError('claimComputer');
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

/**
 * @deprecated The account-level sandbox was removed from the API. Resolves
 * `null` without a request: it returned `null` on any failure and never threw.
 */
export async function getSandboxProvisionStatus(
  _sandboxId: string,
): Promise<SandboxProvisionStatus | null> {
  return null;
}

/**
 * @deprecated The account-level sandbox was removed from the API. Throws
 * `ENDPOINT_RETIRED`: the stream this URL named no longer exists.
 */
export function getSandboxProvisionStreamUrl(_sandboxId: string, _token: string): string {
  throw retiredEndpointError('getSandboxProvisionStreamUrl');
}
