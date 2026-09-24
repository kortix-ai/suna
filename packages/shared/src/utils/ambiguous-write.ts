/**
 * Did an ambiguous write commit? Shared by apps/web (session create, warm
 * claim) and apps/mobile (warm claim), so both treat a timed-out write the
 * same way: ask the server before falling back to a second write.
 */

/**
 * Failures that say nothing about whether the server committed.
 *
 * `TIMEOUT` is the SDK's 30 s client abort and `request_deadline` is the API's
 * 25 s 503. Neither stops the handler: the create or claim transaction still
 * commits after the client gave up. A first prompt with attachments rides as
 * data: URLs, so a slow uplink reaches both limits. Measured on dev with a
 * 6 MiB PNG at 300 KiB/s up: the claim and the fallback create both aborted at
 * 30 s, both sessions were created, and the agent answered in both — while the
 * home composer unlocked with the prompt still in it.
 */
export function isAmbiguousCreateFailure(code: string | undefined): boolean {
  return code === "TIMEOUT" || code === "request_deadline";
}

/** The string `code` an SDK `ApiError` (or any error-like value) carries. */
export function errorCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
}

export const COMMIT_CONFIRM_ATTEMPTS = 5;
export const COMMIT_CONFIRM_DELAY_MS = 2_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask the server, up to `attempts` times, whether an ambiguous write landed.
 *
 * Polls because the commit can land AFTER the client's abort. A probe that
 * throws (a 404 before the row is visible) counts as "not yet".
 */
export async function confirmCommitted(
  probe: () => Promise<boolean>,
  {
    attempts = COMMIT_CONFIRM_ATTEMPTS,
    delayMs = COMMIT_CONFIRM_DELAY_MS,
    sleep = wait,
  }: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    try {
      if (await probe()) return true;
    } catch {
      // Not visible yet.
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
