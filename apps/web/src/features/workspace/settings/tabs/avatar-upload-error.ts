/**
 * The messages each browser gives a request that never reached a server:
 * Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError when
 * attempting to fetch resource.", React Native "Network request failed".
 */
const NETWORK_FAILURE = /^(failed to fetch|load failed|networkerror when attempting to fetch resource\.?|network request failed)$/i;

/**
 * Whether an avatar upload failed before any server answered (KRTX-2838): the
 * user gets "check your connection" and a Retry, not the raw browser text.
 */
export function isOfflineUploadError(error: unknown): boolean {
  return error instanceof Error && NETWORK_FAILURE.test(error.message.trim());
}
