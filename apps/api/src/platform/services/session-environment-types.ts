/**
 * The environment's wire shape, in a module with no imports.
 *
 * Both halves of the split (`session-environment.ts` for bring-up,
 * `session-environment-teardown.ts` for teardown) return it, and a type-only
 * module keeps the light half from importing the heavy one just to name it.
 */
export interface SessionEnvironmentInfo {
  sessionId: string;
  status: string;
  externalId: string | null;
  /** Direct provider-edge origin of the daemon (port 8000), null until active. */
  previewUrl: string | null;
  /** Edge auth token for previewUrl, null until active. */
  previewToken: string | null;
  /** Purpose-bound worker-to-environment HMAC key, null until active. */
  rpcSecret: string | null;
}
