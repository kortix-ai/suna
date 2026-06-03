/**
 * Poll a URL until it responds with 2xx. Throws after maxMs.
 */
export async function waitForUrl(
  url: string,
  maxMs = 120_000,
  intervalMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for ${url} after ${maxMs / 1000}s`);
}

/**
 * Poll the sandbox health endpoint until it reports opencode ready.
 */
export async function waitForSandboxReady(
  healthUrl = 'http://localhost:14000/kortix/health',
  maxMs = 480_000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        const data = (await res.json()) as { status?: string; opencode?: boolean };
        if (data.status === 'ok' && data.opencode === true) return;
      }
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`Sandbox not ready at ${healthUrl} after ${maxMs / 1000}s`);
}
