/**
 * Non-escalation: a governed agent writes into any agent's grant only what it
 * holds itself.
 *
 * `kortix_permissions` is the real limit of a governed agent (its default
 * ceiling is every grantable action, see agent-principal.ts). A principal that
 * may rewrite a grant without this bound may hand itself `all`: an agent with
 * `project.agent.write` + `project.gitops.merge` merged a CR raising itself to
 * `all`, and one with a narrow `secrets:` list granted itself another secret
 * (Strix, staging promotion #9016, 2026-10-03). People are bounded the same way
 * by `assertWriterMayAssign` in IAM.
 *
 * Every path that writes an agent grant calls `assertNoGrantEscalation` with
 * the grants before and after the write. Only ADDED items are checked:
 * narrowing or removing an agent is always allowed. Humans and sessions that
 * borrow a human's authority are not affected.
 */
import type { AgentGrant } from '@kortix/db';
import { AGENT_DEFAULT_CEILING } from './agent-principal';
import { authorize } from './authorize';
import { buildDenialError } from './denial-message';
import type { Actor } from './actor';

// The request readers `isGovernedAgentWriter` and `assertNoGrantEscalation`
// read the Hono context, so they live in `middleware/agent-grant-ceiling.ts`.
// Re-exported here so every importer keeps working.
export { assertNoGrantEscalation } from '../middleware/agent-grant-ceiling';

/**
 * `policy_sets` is not a list of things held: rule sets are not ordered by
 * privilege, so ANY change to any agent's `policy_sets` (add, change, remove)
 * needs the writer to hold `project.connector.write` — the trust that edits
 * the rules themselves. Without it an agent with only `project.agent.write`
 * could move itself to a looser set.
 */
export type GrantDimension = 'permissions' | 'connectors' | 'secrets' | 'apps' | 'policy_sets';
export interface GrantEscalation {
  target: string;
  dimension: GrantDimension;
  item: string;
}
type Items = string[] | 'all';

type ListDimension = Exclude<GrantDimension, 'policy_sets'>;
const DIMENSIONS: ListDimension[] = ['permissions', 'connectors', 'secrets', 'apps'];
/** The action that may change `policy_sets` (see `GrantDimension`). */
export const POLICY_SET_WRITE_ACTION = 'project.connector.write';
// Secret identifiers match case-insensitively (agentMayUseEnv), App slugs lowercase (agentMayOpenApp).
const KEY: Record<ListDimension, (item: string) => string> = {
  permissions: (s) => s,
  connectors: (s) => s,
  secrets: (s) => s.toUpperCase(),
  apps: (s) => s.toLowerCase(),
};

function dimensionsOf(grant: AgentGrant | undefined): Record<ListDimension, Items> {
  if (!grant) return { permissions: [], connectors: [], secrets: [], apps: [] };
  // An omitted `env` is `all` and an omitted `apps` is none: the same reading
  // as agentMayUseEnv / agentMayOpenApp at use time.
  const raw = { permissions: grant.permissions, connectors: grant.connectors, secrets: grant.env ?? 'all', apps: grant.apps ?? [] };
  const out = {} as Record<ListDimension, Items>;
  for (const d of DIMENSIONS) out[d] = raw[d] === 'all' || raw[d].includes('*') ? 'all' : raw[d];
  return out;
}

/** What `after` holds that `before` did not, per dimension (`all` when it widens to all). */
export function grantAdditions(before: AgentGrant | undefined, after: AgentGrant): Record<ListDimension, Items> {
  const was = dimensionsOf(before);
  const now = dimensionsOf(after);
  const added = {} as Record<ListDimension, Items>;
  for (const d of DIMENSIONS) {
    const a = now[d];
    const b = was[d];
    if (a === 'all') added[d] = b === 'all' ? [] : 'all';
    else if (b === 'all') added[d] = [];
    else {
      const had = new Set(b.map(KEY[d]));
      added[d] = a.filter((item) => !had.has(KEY[d](item)));
    }
  }
  return added;
}

/** The first item some agent's grant gains that the writer does not hold, or null. */
export async function findGrantEscalation(input: {
  writer: AgentGrant;
  writerMayPerform: (action: string) => Promise<boolean>;
  /** What a permissions grant of `all` confers. */
  allPermissions: Iterable<string>;
  before: Map<string, AgentGrant>;
  after: Map<string, AgentGrant>;
}): Promise<GrantEscalation | null> {
  const mine = dimensionsOf(input.writer);
  for (const [target, grant] of input.after) {
    const added = grantAdditions(input.before.get(target), grant);
    const actions = added.permissions === 'all' ? [...input.allPermissions] : added.permissions;
    for (const action of actions) {
      if (!(await input.writerMayPerform(action))) return { target, dimension: 'permissions', item: action };
    }
    for (const d of ['connectors', 'secrets', 'apps'] as const) {
      const held = mine[d];
      if (held === 'all') continue;
      if (added[d] === 'all') return { target, dimension: d, item: 'all' };
      const keys = new Set(held.map(KEY[d]));
      const missing = (added[d] as string[]).find((item) => !keys.has(KEY[d](item)));
      if (missing !== undefined) return { target, dimension: d, item: missing };
    }
    const changed = changedPolicySet(input.before.get(target), grant);
    if (changed !== null && !(await input.writerMayPerform(POLICY_SET_WRITE_ACTION))) {
      return { target, dimension: 'policy_sets', item: changed };
    }
  }
  // Removing an agent that runs under a set removes that set: without this,
  // delete-then-declare-again moves the agent onto the base rules.
  for (const [target, grant] of input.before) {
    if (input.after.has(target)) continue;
    const slug = Object.keys(grant.policySets ?? {}).sort()[0];
    if (slug !== undefined && !(await input.writerMayPerform(POLICY_SET_WRITE_ACTION))) {
      return { target, dimension: 'policy_sets', item: slug };
    }
  }
  return null;
}

/** The first connector slug whose policy set differs between two grants, or null. */
export function changedPolicySet(before: AgentGrant | undefined, after: AgentGrant): string | null {
  const was = before?.policySets ?? {};
  const now = after.policySets ?? {};
  const slugs = new Set([...Object.keys(was), ...Object.keys(now)]);
  for (const slug of [...slugs].sort()) {
    // Every entry counts, also one on a connector the agent does not hold now:
    // an un-grant keeps the entry, and it applies again on re-grant. Skipping
    // un-granted slugs let un-grant, drop the entry, re-grant reach the base rules.
    const a = Object.hasOwn(was, slug) ? was[slug] : undefined;
    const b = Object.hasOwn(now, slug) ? now[slug] : undefined;
    if (a !== b) return slug;
  }
  return null;
}

/**
 * True when the writer holds everything a grant can confer, so nothing it
 * writes can exceed it. Used where the written grant cannot be read before it
 * lands (a push straight to the default branch).
 */
export async function holdsEveryGrant(
  writer: AgentGrant,
  writerMayPerform: (action: string) => Promise<boolean>,
): Promise<boolean> {
  // A writer bound by a policy set could push a commit that moves it off that
  // set: it never holds everything.
  if (writer.policySets && Object.keys(writer.policySets).length > 0) return false;
  // `policySets` on the target makes the check ask for POLICY_SET_WRITE_ACTION.
  const everything: AgentGrant = {
    agent: '*',
    permissions: 'all',
    connectors: 'all',
    env: 'all',
    apps: 'all',
    policySets: { '*': '*' },
  };
  const escalation = await findGrantEscalation({
    writer,
    writerMayPerform,
    allPermissions: AGENT_DEFAULT_CEILING,
    before: new Map(),
    after: new Map([['*', everything]]),
  });
  return escalation === null;
}

/** A governed agent principal that writes a grant: the request's actor and its own agent grant. */
export interface GovernedAgentWriter {
  actor: Actor;
  grant: AgentGrant;
}

/**
 * 403 `agent_grant_escalation` when a governed agent's write would give any
 * agent a permission, connector, secret or App the writer does not hold. A
 * no-op when `governed` is null (every other caller).
 */
export async function assertNoGrantEscalationBy(
  governed: GovernedAgentWriter | null,
  projectId: string,
  before: Map<string, AgentGrant>,
  after: Map<string, AgentGrant>,
): Promise<void> {
  if (!governed) return;
  const { actor } = governed;
  const writer = governed.grant;
  const escalation = await findGrantEscalation({
    writer,
    writerMayPerform: async (action) => (await authorize(actor, action, { type: 'project', id: projectId })).allowed,
    allPermissions: AGENT_DEFAULT_CEILING,
    before,
    after,
  });
  if (!escalation) return;
  if (escalation.dimension === 'policy_sets') {
    throw buildDenialError(
      POLICY_SET_WRITE_ACTION,
      'agent_grant_escalation',
      `Agent "${writer.agent}" cannot change the policy set of agent "${escalation.target}" on connector "${escalation.item}": changing policy_sets needs ${POLICY_SET_WRITE_ACTION}.`,
    );
  }
  const what = escalation.dimension === 'permissions' ? `"${escalation.item}"` : `${escalation.dimension} "${escalation.item}"`;
  throw buildDenialError(
    escalation.dimension === 'permissions' ? escalation.item : 'project.agent.write',
    'agent_grant_escalation',
    `Agent "${writer.agent}" cannot grant ${what} to agent "${escalation.target}": it does not hold it. An agent grants only what it holds.`,
  );
}
