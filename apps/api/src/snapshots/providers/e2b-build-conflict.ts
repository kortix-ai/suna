import type { ProviderState } from './index';

const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_POLL_MS = 3_000;

export function isE2BConcurrentBuildConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('400: build is not in waiting state');
}

export async function waitForConcurrentE2BBuild(
  getState: () => Promise<ProviderState>,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const sleep =
    opts.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const state = await getState();
    if (state === 'active') return;
    if (!['missing', 'building'].includes(state)) {
      throw new Error(`Concurrent E2B build settled as ${state}`);
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  throw new Error(`Concurrent E2B build did not become active within ${timeoutMs}ms`);
}
