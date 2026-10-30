/**
 * The two ways delivering a minted key to the CLI's local callback fails.
 * Both name the one sign-in path that needs no callback at all: a personal
 * key passed to `kortix login --token` (KRTX-1976).
 */
const TOKEN_FALLBACK =
  'Or create a key under Settings → Personal access keys and run `kortix login --token <key>`.';

export function callbackUnreachableMessage(host: string, reason: string): string {
  return `Could not reach ${host}: ${reason}. Make sure \`kortix login\` is running in your terminal and try again. ${TOKEN_FALLBACK}`;
}

export function callbackTimeoutMessage(host: string): string {
  return `Timed out delivering the API key to ${host}. Is the \`kortix login\` process still running in your terminal? ${TOKEN_FALLBACK}`;
}
