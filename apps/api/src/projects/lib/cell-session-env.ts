/**
 * THE CONFIGURATION A CELL NEEDS, RE-SENT ON EVERY PROMPT.
 *
 * A session's own settings — its Kortix token above all — reach a cell exactly
 * once, as `CELLD_VAR_*` in the sandbox create body. Nothing ever sends them
 * again, and the cell has no way to ask. So anything that restarts the box
 * loses them permanently, and Platinum's `sandbox.start` carries no envVars
 * (fixed on platinum-dev, undeployed), which means every rolled cell comes back
 * unconfigured.
 *
 * WHAT THAT LOOKS LIKE, seen on a real session on dev 2026-09-09 (cf508733):
 *
 *   "active": "scripted", "credential": {"length": 0},
 *   "tools": {"backend":"daemon","url":"http://host.docker.internal:7070"}
 *   user:      hello
 *   assistant: I ran the command and wrote proof.txt
 *
 * With no model configured the worker falls back to its scripted fixture, and
 * its tool calls go to a daemon that does not exist on the platform. The
 * session appears to hang and then answers something unrelated to the question.
 *
 * Re-sending is cheap and idempotent: the values are the ones the create body
 * used, the cell stores them in its own SQLite (so they now outlive the
 * isolate), and a cell that already has them applies the same strings again.
 * That makes the box self-healing rather than dependent on a restart never
 * happening.
 *
 * The token is not minted here. It is the session token already stored on the
 * sandbox row as `config.serviceKey` — the same value the create body sent as
 * KORTIX_TOKEN — so this re-sends what the session already has rather than
 * issuing new authority.
 */

export interface CellSessionEnvInput {
  sessionId: string;
  projectId: string;
  /** The API base the cell calls back on (turn-end relay, transcript store). */
  apiUrl: string;
  /** The session token: `session_sandboxes.config.serviceKey`. */
  serviceKey: string | null | undefined;
  /** The LLM gateway base, when this session is on the gateway. */
  llmBaseUrl?: string | null;
}

/**
 * Pure, so what a cell is told is asserted rather than read back off a box.
 *
 * A missing token yields no `KORTIX_TOKEN` key at all rather than an empty
 * string: the worker treats empty as "no credential" anyway, and writing one
 * would overwrite a good value with a blank on any path where the row has not
 * loaded yet.
 */
export function cellSessionEnv(input: CellSessionEnvInput): Record<string, string> {
  const apiUrl = String(input.apiUrl ?? '').replace(/\/+$/, '');
  const token = input.serviceKey?.trim();
  const gateway = input.llmBaseUrl?.trim();
  return {
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_PROJECT_ID: input.projectId,
    ...(apiUrl ? { KORTIX_API_URL: apiUrl } : {}),
    ...(token ? { KORTIX_TOKEN: token } : {}),
    ...(gateway ? { KORTIX_LLM_BASE_URL: gateway } : {}),
  };
}
