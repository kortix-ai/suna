export async function piModelSelectionSupported(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/kortix/health`, {
      headers, signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const value = await response.json() as Record<string, unknown>;
    return value.engine === 'pi' && value.session_model_selection === 'next-prompt-v1';
  } catch { return false; }
}
