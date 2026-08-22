/**
 * The environment contract for this node.
 *
 * WHY THIS FILE EXISTS. `config.ts` declares 29 keys. An ENV-READ scan of
 * production source finds 67 names read directly off the environment, plus
 * three reached through constant indirection (`env[CODEX_AUTH_JSON_SECRET]`,
 * `env[OPENCODE_AUTH_JSON_SECRET]`, `env[SECRET_CAPABILITIES_ENV_NAME]`). Nothing
 * stated the whole contract, so an install could not be validated, a missing
 * variable produced a silent misbehaviour instead of an error, and nobody could
 * answer "what does a box need to be given?" without reading 44 modules.
 *
 * This is that answer, as data. It is deliberately a DECLARATION, not a reader:
 * it changes no runtime behaviour and every existing read site keeps working
 * exactly as it does today. The tripwire in `__tests__/env-contract.test.ts`
 * fails when a name appears in the source that is not declared here, which is
 * what keeps the contract true after the refactor rather than review discipline.
 *
 * See docs/specs/2026-08-21-kortixd.md §5.3.
 */

/**
 * Which part of the node owns this variable. After the workload split these
 * become module boundaries; today they are the map of what would move where.
 */
export type EnvOwner =
  /** Node core: ports, paths, state, identity, convergence. */
  | 'core'
  /** Host services that any workload can use: static web, pty, file, proxy. */
  | 'host'
  /** Repo materialization and git credentials. */
  | 'git'
  /** Secret delivery and the egress boundary. */
  | 'secrets'
  /** LLM + connector proxies and the model catalog. */
  | 'llm'
  /** The OpenCode harness adapter. */
  | 'harness/opencode'
  /** Monitor workload. */
  | 'monitor'
  /** Warm-seed workload. */
  | 'warm-seed'
  /** Not ours. Read from the ambient environment, owned by the OS or a tool. */
  | 'external'

/**
 * WHEN a value may change under a running process. This is the single most
 * dangerous property in the daemon — see docs/specs/2026-08-21-kortixd.md
 * §5.3.1.
 *
 * `reloadSessionEnv()` rewrites `process.env` at runtime when a warm-seed fork
 * adopts its real session. A `session` key captured at boot is therefore STALE
 * after adoption, and a fork will run with the deriving session's credentials —
 * exactly the 2026-06-10 incident where forks answered health on `main` with
 * another session's tokens.
 *
 * NOT THE SAME AXIS as `BOOT_ONLY_KORTIX_ENV_NAMES` in
 * `src/__tests__/runtime-env-allowlist-completeness.test.ts`. That set answers
 * "may `POST /kortix/env` PUSH this value into a running process?" — and for
 * several names the answer is no even though they are `reload: 'session'` here.
 * This axis answers a different question: "must it be RE-READ when the node is
 * claimed?". A name can be re-read on adoption and still be forbidden from a
 * live push. P1 must not drive a claim off `sessionScopedNames()` as though it
 * were a live-update allowlist.
 */
export type EnvReload =
  /** Fixed for the life of the process. Safe to read once and cache. */
  | 'boot'
  /** Re-read on every claim/adopt. NEVER cache across a session boundary. */
  | 'session'

export type EnvKind =
  /** Proves who this node/session is. Treat as a credential. */
  | 'identity'
  /** What this node was told to do. Arrives with a claim. */
  | 'assignment'
  /** A filesystem location. */
  | 'path'
  /** A port number. */
  | 'port'
  /** A behavioural switch. */
  | 'flag'
  /** A tuning number or timeout. */
  | 'tuning'

export interface EnvBinding {
  readonly name: string
  readonly owner: EnvOwner
  readonly reload: EnvReload
  readonly kind: EnvKind
  /** True when the value is a credential and must never be logged or echoed. */
  readonly secret?: boolean
  /** True when the name is reached through a constant rather than `env.NAME`. */
  readonly indirect?: boolean
  /** What it does, and what breaks without it. One line. */
  readonly doc: string
}

const b = (
  name: string,
  owner: EnvOwner,
  reload: EnvReload,
  kind: EnvKind,
  doc: string,
  extra: { secret?: boolean; indirect?: boolean } = {},
): EnvBinding => ({ name, owner, reload, kind, doc, ...extra })

/**
 * Every environment name this daemon reads. Ordered by owner so the file reads
 * as the module map it will become.
 */
export const ENV_CONTRACT: readonly EnvBinding[] = [
  // ── core ────────────────────────────────────────────────────────────────
  b('KORTIXD_VERSION', 'core', 'boot', 'tuning', 'Version stamped into the standalone daemon binary at build time.'),
  b('KORTIX_SERVICE_PORT', 'core', 'boot', 'port', 'The control server port. 8000 is a hard contract with the API proxy.'),
  b('KORTIX_WORKSPACE', 'core', 'boot', 'path', 'Workspace root. Defaults to /workspace.'),
  b('KORTIX_PROJECT_TARGET', 'core', 'boot', 'path', 'Where the project repo is materialized. Defaults to the workspace.'),
  b('KORTIX_WORKLOAD', 'core', 'boot', 'flag', 'Selects the workload. Empty means the session workload.'),
  b('KORTIX_RUNTIME_STATE_DIR', 'core', 'boot', 'path', 'Node state directory. Holds pins and convergence bookkeeping.'),
  b('KORTIX_AUDIT_SPOOL_PATH', 'core', 'boot', 'path', 'Local audit spool. Survives an unreachable API.'),
  b('KORTIX_AGENT_STATE_DIR', 'core', 'boot', 'path', 'Where staged daemon updates land. Owned by the supervisor.'),
  b('KORTIX_AGENT_BIN', 'core', 'boot', 'path', 'Baked daemon path. Test seam only; production never sets it.'),
  b('KORTIX_API_URL', 'core', 'session', 'identity', 'The control plane this node converges against and reports to.'),
  b('KORTIX_COMPUTE_NODE_ID', 'core', 'boot', 'identity', 'Stable logical compute-node id used by the outbound channel.'),
  b('KORTIX_SANDBOX_TOKEN', 'core', 'session', 'identity', 'The node credential: HMAC key for user-context and bearer for sandbox routes.', { secret: true }),
  b('KORTIX_TOKEN', 'core', 'session', 'identity', 'Legacy alias for KORTIX_SANDBOX_TOKEN. Kept for daemons baked before the rename.', { secret: true }),
  b('KORTIX_CLI_TOKEN', 'core', 'session', 'identity', 'Session token acting as the launching user. Distinct from the node credential.', { secret: true }),
  b('KORTIX_PROJECT_ID', 'core', 'session', 'assignment', 'Project this session belongs to.'),
  b('KORTIX_SESSION_ID', 'core', 'session', 'assignment', 'Session this node is currently claimed by. Absent on an unclaimed node.'),
  b('KORTIX_AGENT_NAME', 'core', 'session', 'assignment', 'Agent the session runs as. Used for authorization on relayed calls.'),
  b('KORTIX_FRONTEND_URL', 'core', 'session', 'assignment', 'Public dashboard base, so the agent can build user-facing links.', { indirect: true }),

  // ── host services ───────────────────────────────────────────────────────
  b('KORTIX_STATIC_PORT', 'host', 'boot', 'port', 'Static web server. 3211 is a hard contract with apps/web preview URLs.'),

  // ── git ─────────────────────────────────────────────────────────────────
  b('KORTIX_PROJECT_AUTO_CLONE', 'git', 'session', 'flag', 'Whether this session materializes a repo at boot.'),
  b('KORTIX_REPO_URL', 'git', 'session', 'assignment', 'Project remote. Credentials are fetched just-in-time, never baked.'),
  b('KORTIX_BRANCH_NAME', 'git', 'session', 'assignment', 'Session branch. A fork that keeps the seed value serves the wrong branch.'),
  b('KORTIX_DEFAULT_BRANCH', 'git', 'session', 'assignment', 'Fallback branch when the session names none.'),
  b('KORTIX_BASE_SHA', 'git', 'session', 'assignment', 'Commit the session branches from.'),
  b('KORTIX_SESSION_FRESH', 'git', 'session', 'flag', 'Marks a session with no prior working tree.'),
  b('KORTIX_SESSION_BRANCH_RESTORE', 'git', 'session', 'flag', 'Requires a resumed session to restore its recorded branch before readiness.'),
  b('KORTIX_GIT_DELTA_BUNDLE_BASE64', 'git', 'session', 'assignment', 'Inline git bundle carrying unpushed work into the box.'),
  b('KORTIX_GIT_DELTA_PARENT_SHA', 'git', 'session', 'assignment', 'Parent commit the delta bundle applies onto.'),
  b('KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64', 'git', 'session', 'assignment', 'Inline parent commit object for the delta bundle.'),
  b('KORTIX_CLONE_DEPTH', 'git', 'boot', 'tuning', 'Boot clone depth. 1 is shallow; history is backfilled off the critical path.'),
  b('KORTIX_CLONE_FILTER', 'git', 'boot', 'tuning', 'Partial-clone filter. Empty by default; blobless measured slower than full.'),
  b('KORTIX_BRANCH_FETCH_ATTEMPTS', 'git', 'boot', 'tuning', 'How many times to poll for the session branch to appear on the remote.'),
  b('KORTIX_BRANCH_FETCH_DELAY', 'git', 'boot', 'tuning', 'Seconds between branch-fetch attempts.'),
  b('KORTIX_GIT_USER_NAME', 'git', 'boot', 'tuning', 'Commit author name for agent commits.'),
  b('KORTIX_GIT_USER_EMAIL', 'git', 'boot', 'tuning', 'Commit author email for agent commits.'),

  // ── secrets + egress boundary ───────────────────────────────────────────
  b('KORTIX_PROJECT_SECRET_NAMES', 'secrets', 'session', 'assignment', 'Which project secrets this session carries. Names only.', { indirect: true }),
  b('KORTIX_PROJECT_SECRETS_REVISION', 'secrets', 'session', 'assignment', 'Revision of the delivered secret set, so a stale write is detectable.', { indirect: true }),
  b('KORTIX_SECRET_CAPABILITIES', 'secrets', 'session', 'assignment', 'Per-secret usage grants. Drives the egress shim rules.'),
  b('KORTIX_EGRESS_SHIM_PORT', 'secrets', 'boot', 'port', 'CONNECT-only TLS shim port. Blocked from the port proxy on purpose.'),

  // ── llm + connector proxies ─────────────────────────────────────────────
  b('KORTIX_LLM_BASE_URL', 'llm', 'session', 'assignment', 'Gateway this session bills against.'),
  b('KORTIX_LLM_API_KEY', 'llm', 'session', 'identity', 'Per-session gateway credential.', { secret: true }),
  b('KORTIX_LLM_PROXY_URL', 'llm', 'session', 'assignment', 'In-box LLM proxy the harness points at.'),
  b('KORTIX_LLM_PROXY_PORT', 'llm', 'boot', 'port', 'Port the in-box LLM proxy binds.'),
  b('KORTIX_LLM_CATALOG_FILE', 'llm', 'session', 'path', 'Baked model catalog. A degraded file means the minimal model set.'),
  b('KORTIX_LLM_CATALOG_URL', 'llm', 'session', 'assignment', 'Where a warm seed fetches the full catalog from.'),
  b('KORTIX_LLM_HOTSWAP', 'llm', 'boot', 'flag', 'Allows swapping the gateway credential without restarting the harness.'),
  b('KORTIX_CONNECTORS_PROXY_URL', 'llm', 'session', 'assignment', 'In-box connector proxy base.'),
  b('KORTIX_CONNECTORS_PROXY_PORT', 'llm', 'boot', 'port', 'Port the connector proxy binds.'),
  b('KORTIX_CONNECTORS_MCP_ENABLED', 'llm', 'session', 'flag', 'Whether connectors are exposed to the harness over MCP.'),

  // ── harness: opencode ───────────────────────────────────────────────────
  b('KORTIX_OPENCODE_INTERNAL_PORT', 'harness/opencode', 'boot', 'port', 'Live half of the opencode port pair.'),
  b('KORTIX_OPENCODE_STANDBY_PORT', 'harness/opencode', 'boot', 'port', 'Idle half. A verified reload proves the new process before swapping.'),
  b('KORTIX_DEFAULT_OPENCODE_CONFIG_DIR', 'harness/opencode', 'boot', 'path', 'Out-of-repo config dir used before a project config is resolved.'),
  b('KORTIX_OPENCODE_MODEL', 'harness/opencode', 'session', 'assignment', 'Model the session starts on.'),
  b('KORTIX_OPENCODE_DENY_ENV', 'harness/opencode', 'session', 'assignment', 'Env names withheld from the harness process.'),
  b('KORTIX_OPENCODE_DEBUG', 'harness/opencode', 'boot', 'flag', 'Verbose harness logging.'),
  b('KORTIX_OPENCODE_BINARY_PREFETCH', 'harness/opencode', 'boot', 'flag', 'Prefetches the managed OpenCode executable off the session readiness path.'),
  b('KORTIX_COMPILED_AGENT_CONFIG', 'harness/opencode', 'session', 'assignment', 'Agent config compiled by the API. The box never compiles it itself.'),
  b('KORTIX_COMPILED_AGENT_CONFIG_ETAG', 'harness/opencode', 'session', 'assignment', 'Etag of the compiled config, so a stale config is detectable.'),
  b('KORTIX_INITIAL_PROMPT', 'harness/opencode', 'session', 'assignment', 'First prompt delivered at boot.'),
  b('KORTIX_INITIAL_TURN_TOKEN', 'harness/opencode', 'session', 'identity', 'One-shot token proving the initial turn was accepted.', { secret: true }),
  b('KORTIX_INITIAL_TURN_MESSAGE_ID', 'harness/opencode', 'session', 'assignment', 'Message id the initial turn is attributed to.'),
  b('KORTIX_BOOTSTRAP_OPENCODE_SESSION', 'harness/opencode', 'session', 'flag', 'Create a conversation at boot even with no prompt.'),
  b('KORTIX_TURN_AUTO_RESUME', 'harness/opencode', 'boot', 'flag', 'Whether an interrupted turn resumes itself.'),
  b('OPENCODE_CONFIG', 'harness/opencode', 'session', 'path', 'Passed to the harness process.'),
  b('OPENCODE_CONFIG_CONTENT', 'harness/opencode', 'session', 'assignment', 'Inline harness config. Merges rather than replaces.'),
  b('OPENCODE_AUTH_JSON', 'harness/opencode', 'session', 'identity', 'Inline harness auth payload. Read via env[OPENCODE_AUTH_JSON_SECRET] and deleted from the spawn env after use.', { secret: true, indirect: true }),
  b('CODEX_AUTH_JSON', 'harness/opencode', 'session', 'identity', 'Codex subscription auth, materialized to auth.json mode 0600. Read via env[CODEX_AUTH_JSON_SECRET] and deleted from the spawn env after use.', { secret: true, indirect: true }),
  b('OPENCODE_LOG_LEVEL', 'harness/opencode', 'boot', 'flag', 'Harness log level.'),

  // ── monitor workload ────────────────────────────────────────────────────
  b('KORTIX_MONITORS', 'monitor', 'session', 'assignment', 'Enabled monitors as JSON. The box never parses kortix.yaml itself.'),
  b('KORTIX_MONITOR_BOX_EPOCH', 'monitor', 'session', 'assignment', 'This boot epoch. Ingest rejects a batch stamped with another value.'),

  // ── warm-seed workload ──────────────────────────────────────────────────
  b('KORTIX_WARM_SEED', 'warm-seed', 'boot', 'flag', 'Boots a session-less runtime for snapshot capture.'),
  b('KORTIX_WARM_SEED_PROJECT_CLONE', 'warm-seed', 'boot', 'flag', 'Whether the seed bakes a project clone into the snapshot.'),

  // ── external ────────────────────────────────────────────────────────────
  b('SHELL', 'external', 'boot', 'path', 'Shell used for PTY and on_boot commands.'),
  b('TMPDIR', 'external', 'boot', 'path', 'Temp directory for staged writes.'),
  b('SLACK_CHANNEL_ID', 'external', 'session', 'assignment', 'Present when the session was launched from a Slack channel.'),
  b('SLACK_THREAD_TS', 'external', 'session', 'assignment', 'Slack thread the session reports back into.'),
]

/** Every declared name. */
export function envNames(): string[] {
  return ENV_CONTRACT.map((e) => e.name)
}

/** Lookup by name. */
export function envBinding(name: string): EnvBinding | undefined {
  return ENV_CONTRACT.find((e) => e.name === name)
}

/**
 * Names that MUST be re-read when a node is claimed by a session. Caching one
 * of these across a claim is the warm-fork identity bug; see the module doc.
 */
export function sessionScopedNames(): string[] {
  return ENV_CONTRACT.filter((e) => e.reload === 'session').map((e) => e.name)
}

/** Names carrying a credential. Never log, echo, or include in a health body. */
export function secretNames(): string[] {
  return ENV_CONTRACT.filter((e) => e.secret).map((e) => e.name)
}

/** Everything one owner is responsible for. The future module boundary. */
export function bindingsFor(owner: EnvOwner): EnvBinding[] {
  return ENV_CONTRACT.filter((e) => e.owner === owner)
}
