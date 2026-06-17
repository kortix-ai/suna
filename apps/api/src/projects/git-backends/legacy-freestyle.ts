import { callFreestyle, getFreestyleApiKey } from '../../deployments/providers/freestyle';

async function freestyleJson<T>(
  path: string,
  options: { method: string; body?: unknown; timeoutMs?: number },
  action: string,
): Promise<T> {
  let res: Response;
  try {
    res = await callFreestyle(path, options);
  } catch (err) {
    throw new Error(
      `Freestyle git: ${action} failed - ${err instanceof Error ? err.message : 'unreachable'}`,
    );
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let message = text || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || parsed.description || parsed.error || message;
    } catch {
      // Keep raw response text.
    }
    throw new Error(`Freestyle git: ${action} failed (${res.status}) - ${message}`);
  }

  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Freestyle git: ${action} returned non-JSON response`);
  }
}

export async function isLegacyFreestyleGitConfigured(): Promise<boolean> {
  return Boolean(await getFreestyleApiKey());
}

export async function mintLegacyFreestyleRepoToken(input: {
  repoId: string;
  identityId?: string | null;
}): Promise<{ identityId: string | null; token: string }> {
  if (!input.identityId) {
    throw new Error('Freestyle git: managed project is missing identity id');
  }

  const data = await freestyleJson<Record<string, unknown>>(
    `/git/v1/identity/${input.identityId}/tokens`,
    { method: 'POST', timeoutMs: 15_000 },
    'mint token',
  );
  const token = String(data.token ?? data.accessToken ?? data.value ?? '');
  if (!token) {
    throw new Error('Freestyle git: token response missing token value');
  }
  return { identityId: input.identityId, token };
}
