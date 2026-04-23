/**
 * Session categorisation for the Project Sessions tab + sidebar filtering.
 *
 * OpenCode sessions in a Kortix project come from three very different
 * sources and the sidebar/tabs should treat them differently:
 *
 *   - `human`       — user created this in the general chat, or any other
 *                     interactive session. Shows in the sidebar.
 *   - `onboarding`  — PM's onboarding chat spawned by `project_create` with
 *                     a `user_handle`. User needs to answer questions here,
 *                     so it stays in the sidebar.
 *   - `agent_bound` — ticket-work session owned by a team agent (engineer /
 *                     qa / tech-lead / …). Created by `fireAgentTrigger`.
 *                     Hidden from sidebar; shown grouped under the agent
 *                     in the project Sessions tab.
 *   - `trigger_fire`— spawned by a cron or webhook trigger fire (board
 *                     sweep, recurring monitor run). Hidden from sidebar;
 *                     shown under its trigger in the project Sessions tab.
 *
 * Detection is currently title-based — that's what's reliably available
 * on every opencode session record. Exact string formats are set by the
 * callers that create the session:
 *
 *   ticket-triggers.ts  → `${agent.name} · #${number} ${title}`
 *                         (Engineer · #3 Project scaffold)
 *   ticket-triggers.ts  → `${agent.name} · ${project.name}`
 *                         (Engineer · status-page-service) — project-level
 *                          wake without a ticket
 *   project_create      → `Onboarding · ${project.name}`
 *                         (Onboarding · status-page-service)
 *   trigger fire        → `${trigger.name}`
 *                         (status-page-service-board-sweep, etc.)
 *
 * If a session record carries richer metadata (directly-linked trigger id,
 * agent id, ticket id), we layer that on top — but the title heuristic
 * works standalone.
 */

export type SessionCategory = 'human' | 'onboarding' | 'agent_bound' | 'trigger_fire';

export interface SessionLike {
  id: string;
  title?: string | null;
  parentID?: string | null;
}

export interface ClassifyContext {
  /** Known agent display names for this project, e.g. ["Engineer", "QA", "Tech Lead"]. */
  agentNames?: string[];
  /** Known trigger names for this project, e.g. ["status-page-service-board-sweep"]. */
  triggerNames?: string[];
}

const ONBOARDING_TITLE_RE = /^Onboarding\s*·/i;
// Captures the agent display name (Group 1) from titles like:
//   "Engineer · #3 Build X"
//   "QA · #4 Review …"
//   "Tech Lead · #2 …"
//   "Engineer · my-project"   (project-level wake, no ticket)
const AGENT_BOUND_TITLE_RE = /^([A-Za-z][\w\s-]*?)\s*·\s*(#\d+|[\w-]+)/;

export interface Classification {
  category: SessionCategory;
  /** For agent_bound: the agent's display name (e.g. "Engineer"). */
  agentName?: string;
  /** For agent_bound: the ticket number if the title encodes one. */
  ticketNumber?: number;
  /** For trigger_fire: the trigger name. */
  triggerName?: string;
}

export function classifySession(
  session: SessionLike,
  ctx: ClassifyContext = {},
): Classification {
  const title = (session.title ?? '').trim();

  if (!title) return { category: 'human' };

  if (ONBOARDING_TITLE_RE.test(title)) return { category: 'onboarding' };

  const triggerNames = ctx.triggerNames ?? [];
  if (triggerNames.includes(title)) {
    return { category: 'trigger_fire', triggerName: title };
  }

  const match = AGENT_BOUND_TITLE_RE.exec(title);
  if (match) {
    const agentName = match[1].trim();
    const agentNames = (ctx.agentNames ?? []).map((n) => n.toLowerCase());
    // If caller passed known agent names, require a match. Otherwise
    // trust the title shape — it's only used in places where we know
    // the domain.
    if (agentNames.length && !agentNames.includes(agentName.toLowerCase())) {
      return { category: 'human' };
    }
    const tnMatch = /^#(\d+)/.exec(match[2]);
    return {
      category: 'agent_bound',
      agentName,
      ticketNumber: tnMatch ? parseInt(tnMatch[1], 10) : undefined,
    };
  }

  return { category: 'human' };
}

/** Category predicate that returns true for sessions the sidebar should HIDE. */
export function isSidebarHidden(cls: Classification): boolean {
  return cls.category === 'agent_bound' || cls.category === 'trigger_fire';
}
