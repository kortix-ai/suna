/**
 * THE PROJECT'S AGENT, FOR A CELL.
 *
 * A microVM receives its compiled agent config once, in the create body
 * (`KORTIX_COMPILED_AGENT_CONFIG`, see session-runtime-env.ts) — the agents'
 * prompts, models and permissions, compiled from the manifest at the session's
 * ref. A cell never did: `buildPiWorkerSessionEnvVars` omits it, and on a
 * SHARED runner the create body belongs to whichever session created the box,
 * so even the env a cell is born with is another session's. Measured on dev
 * 2026-09-10: a live cell session held five keys — API url, gateway, project,
 * session, token — and nothing about which agent it was running. Its system
 * prompt was the worker's built-in three sentences whatever the project said.
 *
 * So the per-prompt cell env sync carries it (`repairCellSessionEnv`), which
 * means resolving it on a path that must never be slow. Two rules make that
 * safe: the compile is the SELECTED agent's alone (the manifest plus one `.md`
 * — the same call session-create makes for a workspace with no checkout), and
 * the result is cached per (project, ref, agent) because it can only change
 * with a commit. A failure is cached as null for a shorter window: a project
 * with no v2 manifest must not re-read git on every prompt to be told so again.
 */
import { eq } from 'drizzle-orm';
import { projects } from '@kortix/db';
import { db } from '../../shared/db';
import { loadGitProject } from './git';
import { resolveSelectedAgentConfigForSession } from './compile-agent-config';

/** How long a compiled config stays good without re-reading git. */
export const CELL_AGENT_CONFIG_TTL_MS = 5 * 60_000;
/** How long "this project has none" stays good. Shorter: it changes with a push. */
export const CELL_AGENT_CONFIG_MISS_TTL_MS = 60_000;

const cache = new Map<string, { value: string | null; expiresAt: number }>();

export function __resetCellAgentConfigCacheForTests(): void {
  cache.clear();
}

/** The cache key, exported so the claim about caching is about this expression. */
export function cellAgentConfigKey(projectId: string, agentName: string, ref: string): string {
  return `${projectId}|${ref}|${agentName}`;
}

/**
 * The compiled config for this session's agent, or null when the project has
 * none (v1 manifest, missing agent, unreadable git). Never throws.
 */
export async function cellCompiledAgentConfig(input: {
  projectId: string;
  agentName: string | null | undefined;
  baseRef: string | null | undefined;
}): Promise<string | null> {
  const agentName = input.agentName?.trim();
  if (!agentName) return null;
  const key = cellAgentConfigKey(input.projectId, agentName, input.baseRef?.trim() || '');
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  let value: string | null = null;
  try {
    const [row] = await db
      .select()
      .from(projects)
      .where(eq(projects.projectId, input.projectId))
      .limit(1);
    if (row) {
      const project = await loadGitProject({ row });
      value = await resolveSelectedAgentConfigForSession(project, agentName, input.baseRef ?? null);
    }
  } catch {
    value = null;
  }
  cache.set(key, {
    value,
    expiresAt: now + (value ? CELL_AGENT_CONFIG_TTL_MS : CELL_AGENT_CONFIG_MISS_TTL_MS),
  });
  return value;
}
