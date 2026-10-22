/** Stable transport: server-action identifiers can disappear during a deployment. */
export async function finalizeServerSignOut(): Promise<void> {
  const response = await fetch('/api/auth/sign-out', {
    method: 'POST',
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`Server sign-out failed (${response.status})`);
}
