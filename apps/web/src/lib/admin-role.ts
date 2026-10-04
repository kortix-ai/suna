import { getUserRolesWithToken } from '@kortix/sdk';

/**
 * Check the platform-admin role for an access token by forwarding it to the
 * backend `/user-roles` endpoint, matching the client-side `useAdminRole` hook.
 *
 * Fails closed: an unreachable backend is not an admin.
 */
export async function isAdminAccessToken(accessToken: string): Promise<boolean> {
  try {
    const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '';

    const data = await getUserRolesWithToken<{ isAdmin?: boolean }>({
      backendUrl,
      accessToken,
    });
    return data.isAdmin === true;
  } catch {
    return false;
  }
}
