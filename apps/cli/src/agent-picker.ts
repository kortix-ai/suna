/**
 * Bare `kortix` — the agent picker (R-40, docs/specs/2026-07-26-agi-autonomous-operations.md).
 *
 * Typing `kortix` with no arguments is the shortest path to "get something
 * done", so it offers the workspace's agents with the Kortix AGI elevated and
 * preselected, and starts a session with whatever you pick. The landing banner
 * moved to `kortix --help`.
 *
 * Two invariants drive the shape of this module:
 *
 *   1. It NEVER blocks a non-interactive caller. CI, shell scripts, and agents
 *      all invoke bare `kortix`; a prompt they cannot answer would wedge them
 *      forever. Every non-TTY invocation short-circuits to the banner before a
 *      single byte of I/O happens.
 *   2. It NEVER dead-ends. No login, no linked project, an unreachable API, a
 *      403 that blanks the roster — each of those degrades to the same banner
 *      the CLI printed before, which already carries the "run `kortix login` /
 *      `kortix projects use`" guidance. No stack trace, no empty picker.
 *
 * Elevation branches on `platform_owned === true` and nothing else — never the
 * agent's name, never `source`. Workspace agents omit the field entirely
 * (absent, not `false`), which is why the comparison is strict rather than
 * truthy.
 */

import { clientFromAuth } from './api/client.ts';
import { loadAuth, loadAuthForHost } from './api/auth.ts';
import { hasEnvTokenHost } from './api/config.ts';
import { startSessionAndChat } from './commands/chat-tui.ts';
import { loadLink, resolveProjectId } from './project-link.ts';
import { C, status } from './style.ts';
import { selectFromList, type SelectItem } from './tui-select.ts';

/**
 * The slice of `GET /v1/projects/{id}/detail` → `config.agents[]` the picker
 * reads. Deliberately narrower than the SDK's `ProjectConfigSummary`: the
 * picker renders a name, a description, and an elevation marker, so widening
 * this is the signal that it started depending on something new.
 */
export interface PickableAgent {
  name: string;
  description?: string | null;
  mode?: string | null;
  enabled?: boolean;
  /** True only on platform-owned agents (today: the Kortix AGI). */
  platform_owned?: boolean;
}

interface ProjectDetailAgents {
  project?: { name?: string | null } | null;
  config?: { agents?: PickableAgent[] | null } | null;
}

/** What the picker found to choose from, once auth + project resolved. */
export interface AgentPickerContext {
  projectName: string | null;
  agents: PickableAgent[];
}

/** `'banner'` = nothing to pick from; the caller prints the landing screen. */
export type BareInvocationOutcome = number | 'banner';

export interface AgentPickerSelectOpts {
  title: string;
  items: SelectItem<string>[];
  initialIndex: number;
}

export interface AgentPickerDeps {
  /** Both ends must be a TTY, or we degrade to the banner without prompting. */
  isInteractive: () => boolean;
  /** The roster to offer, or null when there is nothing (or no way) to list. */
  loadContext: () => Promise<AgentPickerContext | null>;
  /** Resolves to the chosen agent's name, or null when the user cancels. */
  select: (opts: AgentPickerSelectOpts) => Promise<string | null>;
  /** Starts a session with the chosen agent; resolves to a process exit code. */
  startSession: (agentName: string) => Promise<number>;
  write: (text: string) => void;
}

const ELEVATED_MARKER = '★';
/** Keeps workspace names column-aligned under the elevated marker. */
const WORKSPACE_MARKER = ' ';
const DESCRIPTION_WIDTH = 72;

function isPlatformOwned(agent: PickableAgent): boolean {
  return agent.platform_owned === true;
}

/**
 * The agents worth offering, platform-owned ones first (R-37).
 *
 * The visibility rules mirror the web's `useVisibleAgents` so both surfaces
 * offer the same set: subagents are not directly startable, and an explicitly
 * disabled agent is not offerable. A missing `mode`/`enabled` means "no opinion",
 * which stays offerable.
 */
export function offerableAgents(agents: readonly PickableAgent[]): PickableAgent[] {
  const offerable = agents.filter((a) => a.enabled !== false && a.mode !== 'subagent');
  return [...offerable.filter(isPlatformOwned), ...offerable.filter((a) => !isPlatformOwned(a))];
}

/**
 * Which row starts highlighted. Driven by `platform_owned`, NOT by position and
 * NOT by the project's `open_code_default_agent` — the AGI is preselected
 * wherever it lands in the list, and a project without one falls back to the
 * first row.
 */
export function preselectedIndex(agents: readonly PickableAgent[]): number {
  const elevated = agents.findIndex(isPlatformOwned);
  return elevated >= 0 ? elevated : 0;
}

function trimTo(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

export function agentPickerItems(agents: readonly PickableAgent[]): SelectItem<string>[] {
  return agents.map((agent) => ({
    value: agent.name,
    label: `${isPlatformOwned(agent) ? ELEVATED_MARKER : WORKSPACE_MARKER} ${agent.name}`,
    sublabel: agent.description ? trimTo(agent.description, DESCRIPTION_WIDTH) : undefined,
  }));
}

export function pickerTitle(projectName: string | null): string {
  return projectName
    ? `Start a session in ${projectName} — pick an agent`
    : 'Start a session — pick an agent';
}

/**
 * Read the roster from the one endpoint that serves it. Returns null (→ banner)
 * for every "can't pick" case, so a missing login, an unlinked directory, and a
 * dead API all land on the same guidance instead of an error the user can do
 * nothing with.
 */
async function loadProjectAgentContext(): Promise<AgentPickerContext | null> {
  // Same host precedence as `resolveProjectContext`: a sandbox-injected token
  // wins over a committed link, which wins over the globally active host.
  const hostFromLink = hasEnvTokenHost() ? undefined : loadLink()?.host;
  const auth = hostFromLink ? loadAuthForHost(hostFromLink) : loadAuth();
  if (!auth?.token) return null;

  const projectId = resolveProjectId();
  if (!projectId) return null;

  try {
    const detail = await clientFromAuth(auth).get<ProjectDetailAgents>(
      `/projects/${projectId}/detail`,
    );
    const agents = detail?.config?.agents;
    if (!Array.isArray(agents)) return null;
    return { projectName: detail?.project?.name ?? null, agents };
  } catch {
    return null;
  }
}

export function defaultAgentPickerDeps(): AgentPickerDeps {
  return {
    isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    loadContext: loadProjectAgentContext,
    select: (opts) =>
      selectFromList<string>({
        title: opts.title,
        items: opts.items,
        initialIndex: opts.initialIndex,
      }),
    // Picking an agent used to POST a session, print four lines, and hand you
    // back to your shell — usually while the sandbox was still provisioning.
    // The pick is the START of a conversation, so wait for readiness and drop
    // into it. Still a seam, so the tests drive a fake.
    startSession: (agentName) => startSessionAndChat(agentName),
    write: (text) => process.stderr.write(text),
  };
}

export async function runAgentPicker(
  deps: AgentPickerDeps = defaultAgentPickerDeps(),
): Promise<BareInvocationOutcome> {
  // Checked before any network call so a piped/CI invocation costs nothing and
  // cannot be left waiting on a selection it has no way to make.
  if (!deps.isInteractive()) return 'banner';

  const context = await deps.loadContext();
  if (!context) return 'banner';

  const agents = offerableAgents(context.agents);
  if (agents.length === 0) return 'banner';

  const chosen = await deps.select({
    title: pickerTitle(context.projectName),
    items: agentPickerItems(agents),
    initialIndex: preselectedIndex(agents),
  });
  if (!chosen) {
    deps.write(
      `  ${C.dim}Nothing started. Run ${C.reset}${C.cyan}kortix --help${C.reset}${C.dim} for the full command list.${C.reset}\n`,
    );
    return 0;
  }

  // The picker wipes its own frame on exit, so echo the choice — otherwise the
  // session output appears with no record of which agent it belongs to.
  deps.write(`${status.info(`Starting a session with ${C.bold}${chosen}${C.reset}`)}\n`);
  return deps.startSession(chosen);
}
