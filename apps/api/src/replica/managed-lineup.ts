// Kortix managed models = what Platinum Inference offers. Read before the first
// request, then refreshed on every replica (an in-memory cache, not a job).
import { loadManagedLineup } from '../llm-gateway/models/managed-models';

const REFRESH_MS = 5 * 60_000;
const BOOT_ATTEMPTS = 3;

let timer: ReturnType<typeof setInterval> | null = null;

/** Bounded: after BOOT_ATTEMPTS the API starts with the lineup it has and the refresh retries. */
export async function loadManagedLineupAtBoot(): Promise<void> {
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
    if (await loadManagedLineup()) return;
    if (attempt < BOOT_ATTEMPTS) await Bun.sleep(1_000 * attempt);
  }
}

export function startManagedLineupRefresh(): void {
  stopManagedLineupRefresh();
  timer = setInterval(() => void loadManagedLineup(), REFRESH_MS);
}

export function stopManagedLineupRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
