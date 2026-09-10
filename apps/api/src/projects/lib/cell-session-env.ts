import { agentConfigEtag } from './compile-agent-config';

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
  /** The session's agent — `project_sessions.agent_name`. */
  agentName?: string | null;
  /** The session's resolved model, `metadata.opencode_model` (`provider/id`). */
  model?: string | null;
  /** The compiled config for that agent — its prompt, model and permissions
   *  (cell-agent-config.ts). */
  compiledAgentConfig?: string | null;
  /** The ref this session runs on — `project_sessions.base_ref`. */
  baseRef?: string | null;
  /** This project's git origin THROUGH KORTIX, when the session may have a checkout. */
  repoUrl?: string | null;
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
  const agent = input.agentName?.trim();
  const model = input.model?.trim();
  const compiled = input.compiledAgentConfig?.trim();
  const baseRef = input.baseRef?.trim();
  const repoUrl = input.repoUrl?.trim();
  return {
    KORTIX_SESSION_ID: input.sessionId,
    KORTIX_PROJECT_ID: input.projectId,
    ...(apiUrl ? { KORTIX_API_URL: apiUrl } : {}),
    ...(token ? { KORTIX_TOKEN: token } : {}),
    ...(gateway ? { KORTIX_LLM_BASE_URL: gateway } : {}),
    // WHOSE AGENT AND WHOSE MODEL. A cell is born with the create body's
    // CELLD_VAR_*, and on a shared runner that body belongs to whichever
    // session created the box — so every later session on it ran the FIRST
    // session's agent name and model, and a restarted cell ran none at all.
    // These are per-session and re-sent with the rest.
    ...(agent ? { KORTIX_AGENT_NAME: agent, KORTIX_AGENT: agent } : {}),
    ...(model ? { KORTIX_MODEL: model } : {}),
    // The project's own agent: its `.md` body is the system prompt, its
    // frontmatter the model. Absent for a v1 project, and absent is not empty
    // — an empty string would tell the cell "this project has an agent with no
    // prompt" and silence the built-in one.
    ...(compiled
      ? {
          KORTIX_COMPILED_AGENT_CONFIG: compiled,
          KORTIX_COMPILED_AGENT_CONFIG_ETAG: agentConfigEtag(compiled) ?? '',
        }
      : {}),
    // THE PROJECT'S FILES. A cell clones through the Kortix git proxy with the
    // token above — no host credential, no new authority. Absent means "no
    // checkout", which is what every cell had until now: an empty workspace,
    // no skills, no AGENTS.md and a Files panel with nothing in it.
    ...(repoUrl ? { KORTIX_REPO_URL: repoUrl } : {}),
    ...(baseRef ? { KORTIX_BASE_REF: baseRef } : {}),
  };
}
