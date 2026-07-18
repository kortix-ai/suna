/**
 * Snapshot build error classification.
 *
 * A failed snapshot build is the single most product-breaking failure in the
 * platform: no ready image means new sessions can't boot. To recover well we
 * need to know *why* a build failed so the UI can route it correctly — a
 * Dockerfile bug is fixable by an agent (edit the repo, open a CR), while a
 * dead dev tunnel or a Daytona gateway blip is infrastructure the user just
 * retries.
 *
 * The classifier is intentionally heuristic (regex over the error string) —
 * Daytona/Docker don't give us structured error codes. Order matters: the
 * most specific buckets are checked first.
 */

export type SnapshotErrorCategory =
  /** The Daytona org hit its snapshot quota — builds fail org-wide until GC frees slots. */
  | 'quota'
  /** User's Dockerfile / build steps failed (RUN, COPY, apt-get, npm…). Fixable by an agent. */
  | 'dockerfile'
  /** A step in the KORTIX-INJECTED runtime layer failed. Platform's fault, not the repo's. */
  | 'layer'
  /** Kortix callback URL (KORTIX_URL) unreachable — usually a down dev tunnel. */
  | 'tunnel'
  /** Daytona transport / gateway / socket blip — transient provider infra. */
  | 'provider'
  /** Build exceeded its deadline or was orphaned by an API restart. */
  | 'timeout'
  /** A Kortix runtime artifact (agent binary, entrypoint, CLI) was missing at build time. */
  | 'runtime'
  /** Commit/clone/auth resolution against the git host failed. */
  | 'git'
  /** Anything we couldn't bucket. */
  | 'unknown';

export interface SnapshotErrorInfo {
  category: SnapshotErrorCategory;
  /** Short human label for a badge / headline. */
  title: string;
  /** One-line explanation + the suggested next step. */
  hint: string;
  /**
   * Whether an in-sandbox agent can plausibly fix this by editing the repo and
   * opening a change request (Dockerfile / git config), vs. infra the user must
   * retry (tunnel, provider, timeout, missing runtime artifact).
   */
  fixableByAgent: boolean;
}

const RULES: Array<{ category: SnapshotErrorCategory; test: RegExp }> = [
  // Org snapshot quota exhausted — most specific, must outrank 'provider'
  // (the raw message usually contains 'daytona'/'snapshot' too).
  {
    category: 'quota',
    test: /quota|snapshot limit|limit of \d+ snapshots|maximum number of snapshots|too many snapshots|snapshot count/i,
  },
  // Our packaging is missing an artifact the layered Dockerfile COPYs in.
  {
    category: 'runtime',
    test: /required artifact missing|required directory missing|kortix_snapshot_.*_path|kortix-agent|kortix-entrypoint|slack-cli|executor-sdk|run `bun run build`/i,
  },
  // The sandbox can't call back to the API (dead tunnel / loopback KORTIX_URL).
  {
    category: 'tunnel',
    test: /kortix_url|callback url|kortix_url_unreachable|loopback|\btunnel\b|cloudflared|unreachable/i,
  },
  // Couldn't resolve the commit, clone the repo, or authenticate to the host.
  {
    category: 'git',
    test: /resolve.*commit|could not resolve|repository not found|fatal: repository|could not read from remote|github app|authentication failed|git auth|clone failed|permission denied \(publickey\)/i,
  },
  // Build ran past the deadline or was abandoned by a restart.
  {
    category: 'timeout',
    test: /orphaned|timed out|timeout|deadline|exceeded the time/i,
  },
  // Daytona transport / gateway flakiness.
  {
    category: 'provider',
    test: /daytona|snapshot with name .* not found|socket connection|idle connection|socket hang up|bad gateway|\bgateway\b|\b50[234]\b|econnreset|econnrefused|etimedout|\beof\b|network error/i,
  },
  // A step in the KORTIX-INJECTED runtime layer failed — the user's Dockerfile is
  // fine and an agent "fixing" it can only make things worse. MUST outrank
  // 'dockerfile', whose generic patterns ('apt-get', 'did not complete
  // successfully', 'non-zero code') match these too — that miscategorization is
  // exactly what dispatched an agent to repair a CORRECT Dockerfile after the
  // floor's pip tried to uninstall a dpkg-owned numpy.
  //
  // Markers are the ones that can only plausibly come from our own layer: the
  // pyfloor venv path, dpkg-vs-pip ownership conflicts, and an apt-less base
  // (our floor assumes Debian-family; the user's own FROM may not be).
  // Caveat: a user Dockerfile that itself pip-installs over a dpkg-owned package
  // can produce the same dpkg-conflict text and land here. We accept that — the
  // hint points at the platform and the failure is one a human should read either
  // way, which beats dispatching an agent at a Dockerfile that is not broken.
  {
    category: 'layer',
    test: /\/opt\/kortix\/pyfloor|record file not found|installed by debian|externally-managed-environment|apt-get: (not found|command not found)|apt-get: No such file/i,
  },
  // The user's Dockerfile / build steps failed.
  {
    category: 'dockerfile',
    test: /dockerfile|failed to solve|did not complete successfully|non-zero code|exit code: [1-9]|copy failed|apt-get|npm err|returned a non-zero|executor failed|empty dockerfile|no such file or directory|unable to find image/i,
  },
];

/** Bucket a raw snapshot build error message into a category. */
export function classifySnapshotError(raw: string | null | undefined): SnapshotErrorCategory {
  const message = (raw ?? '').trim();
  if (!message) return 'unknown';
  for (const rule of RULES) {
    if (rule.test.test(message)) return rule.category;
  }
  return 'unknown';
}

const INFO: Record<SnapshotErrorCategory, Omit<SnapshotErrorInfo, 'category'>> = {
  quota: {
    title: 'Snapshot quota reached',
    hint: 'The Daytona organization hit its snapshot limit. Superseded snapshots are garbage-collected automatically by the maintenance sweep — retry in a few minutes, or delete unused sandbox templates.',
    fixableByAgent: false,
  },
  dockerfile: {
    title: 'Dockerfile build failed',
    hint: 'A step in the project Dockerfile failed. An agent can inspect the build error and fix the Dockerfile.',
    fixableByAgent: true,
  },
  layer: {
    title: 'Kortix runtime layer failed',
    hint: 'A step in the Kortix runtime layer that gets appended to every image (the Python package floor or the apt floor) failed against this base image — your Dockerfile is not the cause, and editing it will not help. This is a platform issue: retry the build, and report it if it persists.',
    fixableByAgent: false,
  },
  git: {
    title: 'Repository access failed',
    hint: 'Could not resolve the commit, clone the repo, or authenticate. Check the git connection; an agent can fix repo-side config.',
    fixableByAgent: true,
  },
  tunnel: {
    title: 'Sandbox callback unreachable',
    hint: 'The sandbox could not reach the Kortix API (KORTIX_URL). In local dev this usually means the tunnel is down — restart it and retry.',
    fixableByAgent: false,
  },
  provider: {
    title: 'Sandbox provider error',
    hint: 'Daytona returned a transport/gateway error while building. This is usually transient — retry the build.',
    fixableByAgent: false,
  },
  timeout: {
    title: 'Build timed out',
    hint: 'The build exceeded its deadline or was interrupted (e.g. an API restart). Retry the build.',
    fixableByAgent: false,
  },
  runtime: {
    title: 'Runtime artifact missing',
    hint: 'A Kortix runtime artifact was missing when the image was built. This is a platform/deploy issue, not your repo. Retry after the API is rebuilt.',
    fixableByAgent: false,
  },
  unknown: {
    title: 'Build failed',
    hint: 'The snapshot build failed for an unrecognized reason. Inspect the error and retry, or send it to an agent.',
    fixableByAgent: true,
  },
};

/** Static metadata (label, hint, agent-fixability) for a category. */
export function describeSnapshotError(category: SnapshotErrorCategory): SnapshotErrorInfo {
  return { category, ...INFO[category] };
}
