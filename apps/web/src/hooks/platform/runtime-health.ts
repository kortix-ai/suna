export interface SandboxGlobalHealth {
  healthy: boolean;
  version?: string;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchSandboxGlobalHealth(
  sandboxBaseUrl: string,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<SandboxGlobalHealth> {
  try {
    const res = await fetchImpl(`${sandboxBaseUrl}/kortix/health`, init);
    if (!res.ok) return { healthy: false };
    const data = await res.json().catch(() => null);
    return {
      healthy: data?.runtimeReady === true,
      version: typeof data?.version === 'string' ? data.version : undefined,
    };
  } catch {
    return { healthy: false };
  }
}
