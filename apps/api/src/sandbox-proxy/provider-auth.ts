/** Provider-edge refusals are distinct from the sandbox's signed-context gate. */
export async function isProviderIngressAuthFailure(provider: string, response: Response): Promise<boolean> {
  if (provider !== 'daytona') return false;
  if (response.status >= 300 && response.status < 400) {
    try {
      const location = new URL(response.headers.get('location') ?? '');
      return location.origin === 'https://api.auth.daytona.io'
        && location.pathname === '/user_management/authorize';
    } catch {
      return false;
    }
  }
  if (response.status !== 401) return false;
  const body = await response.clone().json().catch(() => null);
  return body?.statusCode === 401 && body?.code === 'UNAUTHORIZED'
    && typeof body?.message === 'string'
    && body.message.startsWith('unauthorized: authentication failed:');
}
