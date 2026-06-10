/**
 * Per-project Platinum warm seeds — the sub-second session path.
 *
 * A "seed" is a Platinum STATEFUL template derived from the org's default
 * template with this project's runtime env baked in (KORTIX_PROJECT_AUTO_CLONE
 * + repo URL + tokens). Platinum's maintain loop boots it once, waits for the
 * kortix runtime to report ready (repo cloned, opencode up), snapshots the
 * RUNNING VM, and every session created from it CoW-forks that warm image
 * (~0.4s create, ~0.9s to runtimeReady) instead of cold-booting + cloning
 * (~6-8s).
 *
 * Freshness is content-addressed in the NAME: `proj-seed-<projectId>-<sha12>`
 * where sha is the default branch HEAD at derive time. The in-guest daemon's
 * baked-repo path does NO network fetch (local `checkout -B` only), so a seed
 * is only valid for the base it was captured at — when main moves, the name
 * stops matching, sessions fall back to the default template (correct, just
 * slower), and a new seed is derived in the background. Stale seeds are
 * deleted lazily on the next derive.
 *
 * Window worth knowing about: the capture happens ~2-4 min AFTER derive (the
 * maintain loop boots + clones + snapshots). If main moves inside that window
 * the baked repo can be one commit ahead of the sha in the name. Sessions in
 * that state branch from a slightly NEWER base — never an older one.
 */

import { isPlatinumConfigured, platinumJson } from '../../shared/platinum';
import { resolveCommitSha, type GitBackedProject } from '../../projects/git';

/** Env keys that are per-session, never baked into a seed. The daemon adopts
 *  the real session's values from /etc/dnah-env after the fork. */
const SESSION_ONLY_ENV = new Set([
  'KORTIX_SESSION_ID',
  'KORTIX_BRANCH_NAME',
  'KORTIX_BOOTSTRAP_OPENCODE_SESSION',
  'KORTIX_INITIAL_PROMPT',
  'KORTIX_OPENCODE_MODEL',
]);

interface PlatinumTemplateRow {
  id: string;
  name: string;
  state: string;
}

function seedName(projectId: string, sha: string, parentTemplate: string): string {
  // The parent template name ends in the runtime content hash
  // (kortix-default-<hash>); folding its tail into the seed name makes a
  // runtime upgrade invalidate every seed automatically — a seed is only
  // fresh for (repo HEAD × runtime image) it was captured from.
  const parentTail = parentTemplate.split('-').pop() ?? 'x';
  return `proj-seed-${projectId}-${sha.slice(0, 12)}-${parentTail.slice(0, 12)}`.toLowerCase();
}

async function templateByName(name: string): Promise<PlatinumTemplateRow | null> {
  const rows = await platinumJson<PlatinumTemplateRow[]>(
    `/v1/templates?name=${encodeURIComponent(name)}`,
  );
  return rows[0] ?? null;
}

// One in-flight derive per project — concurrent session creates for the same
// project must not race N identical derives (Platinum would 409 all but one,
// but there's no reason to even send them).
const deriveInFlight = new Map<string, Promise<void>>();

/**
 * Resolve the warm seed template for `(project, defaultBranch HEAD)`.
 * Returns the seed's template name to boot from, or null when no fresh seed
 * exists yet — in which case a background derive is kicked so the NEXT
 * session gets the fast path. Never throws; null means "use the default".
 */
export async function resolveProjectSeed(opts: {
  project: GitBackedProject;
  projectId: string;
  /** Full provider env for THIS session — the seed recipe is this minus the
   *  session-only keys. */
  envVars: Record<string, string>;
  /** Platinum template name the session would otherwise boot from (the
   *  derive parent). */
  defaultTemplate: string;
}): Promise<string | null> {
  if (!isPlatinumConfigured()) return null;
  try {
    const sha = await resolveCommitSha(opts.project, opts.project.defaultBranch);
    const name = seedName(opts.projectId, sha, opts.defaultTemplate);
    const existing = await templateByName(name);
    if (existing && existing.state === 'ready') return name;
    if (!existing && !deriveInFlight.has(opts.projectId)) {
      const p = deriveSeed(opts, name)
        .catch((err) => {
          console.warn(`[platinum-seed] derive ${name} failed:`, err instanceof Error ? err.message : err);
        })
        .finally(() => deriveInFlight.delete(opts.projectId));
      deriveInFlight.set(opts.projectId, p);
    }
    return null;
  } catch (err) {
    console.warn('[platinum-seed] resolve failed (falling back to default template):',
      err instanceof Error ? err.message : err);
    return null;
  }
}

async function deriveSeed(
  opts: { projectId: string; envVars: Record<string, string>; defaultTemplate: string },
  name: string,
): Promise<void> {
  const parent = await templateByName(opts.defaultTemplate);
  if (!parent || parent.state !== 'ready') {
    throw new Error(`parent template ${opts.defaultTemplate} not ready on Platinum`);
  }
  const captureEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.envVars)) {
    if (!SESSION_ONLY_ENV.has(k)) captureEnv[k] = v;
  }
  await platinumJson(`/v1/templates/${parent.id}/derive`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      capture_env: captureEnv,
      // Snapshot the moment the in-guest kortix runtime is fully up: repo
      // cloned + opencode serving. Same probe the frontend polls.
      capture_condition: {
        cmd: `curl -s -m 3 http://127.0.0.1:8000/kortix/health | grep -q '"runtimeReady":true'`,
        timeoutSec: 240,
      },
    }),
  });
  console.log(`[platinum-seed] derived ${name} (parent ${opts.defaultTemplate}); capture runs in background`);
  // Lazy cleanup: previous-sha seeds for this project are now unreachable
  // (name lookup is exact) — delete them to free quota + warm snapshots.
  // Best-effort; 409 (sandboxes still alive on the old seed) just defers
  // cleanup to a later derive.
  try {
    const prefix = `proj-seed-${opts.projectId}-`.toLowerCase();
    const all = await platinumJson<PlatinumTemplateRow[]>('/v1/templates?limit=200');
    for (const t of all) {
      if (t.name.startsWith(prefix) && t.name !== name && t.state === 'ready') {
        await platinumJson(`/v1/templates/${t.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  } catch {
    /* cleanup is opportunistic */
  }
}
