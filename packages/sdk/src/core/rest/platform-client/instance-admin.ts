/** Generic instance administration and provisioning status surfaces. */

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
