/**
 * Client-side mirror of the backend per-workspace leaf actions (apps/api/src/iam/
 * actions.ts `WORKSPACE_ACTIONS`) plus the customize-section → capability map that
 * drives UI gating.
 *
 * Why a mirror and not a shared import: the API package isn't importable from
 * the web bundle. These strings MUST stay byte-identical to the backend catalog
 * — `VALID_ACTIONS` rejects anything else, so a typo here means the IAM probe
 * 400s. Keep this list in sync when actions.ts changes.
 *
 * Gating rule (IAM v1): a capability is DEACTIVATED for a group by giving
 * its custom role a permission set that OMITS the capability's leaf. The UI
 * reflects that by hiding/disabling the section whose `read`/`write` leaf the
 * role no longer grants. Sections whose read leaf is in the Member baseline
 * (role-perms.ts member baseline) are visible to every workspace role;
 * `secrets` gates on project.secret.read, which is DELIBERATELY editor-tier
 * (the sensitive file/secret reads moved off the floor `member` role), so that
 * section — like the standalone Files page — hides for plain members by design.
 */

import type { CustomizeSection } from '@/lib/customize-sections';

export const WORKSPACE_ACTIONS = {
  WORKSPACE_READ: 'project.read',
  WORKSPACE_WRITE: 'project.write',

  WORKSPACE_CR_OPEN: 'project.cr.open',
  WORKSPACE_CR_MERGE: 'project.cr.merge',

  WORKSPACE_MEMBERS_READ: 'project.members.read',
  WORKSPACE_MEMBERS_MANAGE: 'project.members.manage',

  WORKSPACE_AGENT_READ: 'project.agent.read',
  WORKSPACE_AGENT_WRITE: 'project.agent.write',
  WORKSPACE_SKILL_READ: 'project.skill.read',
  WORKSPACE_SKILL_WRITE: 'project.skill.write',
  WORKSPACE_COMMAND_READ: 'project.command.read',
  WORKSPACE_COMMAND_WRITE: 'project.command.write',
  WORKSPACE_TRIGGER_READ: 'project.trigger.read',
  WORKSPACE_TRIGGER_CREATE: 'project.trigger.create',
  WORKSPACE_FILE_READ: 'project.file.read',
  WORKSPACE_FILE_WRITE: 'project.file.write',
  WORKSPACE_CUSTOMIZE_READ: 'project.customize.read',
  WORKSPACE_CUSTOMIZE_WRITE: 'project.customize.write',
  WORKSPACE_GITOPS_READ: 'project.gitops.read',
  WORKSPACE_GITOPS_PUSH: 'project.gitops.push',
  WORKSPACE_GITOPS_MERGE: 'project.gitops.merge',
  WORKSPACE_SECRET_READ: 'project.secret.read',
  WORKSPACE_SECRET_WRITE: 'project.secret.write',
  WORKSPACE_CONNECTOR_READ: 'project.connector.read',
  WORKSPACE_CONNECTOR_WRITE: 'project.connector.write',
  WORKSPACE_CONNECTOR_CONNECTIONS_MANAGE: 'project.connector.connections.manage',

  WORKSPACE_REVIEW_READ: 'project.review.read',
  WORKSPACE_REVIEW_SUBMIT: 'project.review.submit',
  WORKSPACE_REVIEW_ACT: 'project.review.act',
} as const;

export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[keyof typeof WORKSPACE_ACTIONS];

/**
 * Per-section gating leaves.
 *
 * `read`  — gates whether the section is VISIBLE (rail item + deep-link). Must
 *           be a Member-seeded leaf so a member never loses a section.
 * `write` — gates the mutating controls INSIDE the section (create/edit/delete).
 *           A user with `read` but not `write` sees the section read-only.
 *
 * Notes:
 * - `channels` maps to connector.* (NOT the unseeded channel.* namespace) — the
 *   actual Slack connect/disconnect routes assert project.connector.write.
 * - `git` surfaces repository metadata and clone instructions; pushes remain
 *   separately gated by project.gitops.push.
 * - sandbox/settings/marketplace have no dedicated read leaf, so
 *   they stay visible on project.read and gate writes on the closest real leaf
 *   the backend asserts (e.g. sandbox rebuild → customize.write, marketplace
 *   install → gitops.push).
 */
export const CUSTOMIZE_SECTION_ACCESS: Record<
  CustomizeSection,
  { read: WorkspaceAction; write?: WorkspaceAction }
> = {
  // No `agents` entry: Agents graduated to /workspaces/<id>/agent, which gates
  // itself on WORKSPACE_AGENT_READ/WRITE directly (workspace-settings-nav's
  // TAB_PREFERENCE and the page's own useWorkspaceCan). This map only covers
  // sections the Customize rail renders — Commands is one of them again, since
  // its standalone page was deleted (#6169).
  commands: {
    read: WORKSPACE_ACTIONS.WORKSPACE_COMMAND_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_COMMAND_WRITE,
  },
  secrets: {
    read: WORKSPACE_ACTIONS.WORKSPACE_SECRET_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_SECRET_WRITE,
  },
  channels: {
    read: WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE,
  },
  // `schedules` and `webhooks` are two views over the SAME backend resource
  // (project triggers, filtered client-side by `type`) — there is no
  // dedicated schedule.*/webhook.* leaf server-side (those were removed from
  // the catalog as dead/unwired; see iam/actions.ts). Gate both on the real
  // enforcement point: project.trigger.read/create. Update/delete stay gated
  // on their own leaves inside the view, same precedent as `changes` below.
  schedules: {
    read: WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE,
  },
  webhooks: {
    read: WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_TRIGGER_CREATE,
  },
  git: {
    read: WORKSPACE_ACTIONS.WORKSPACE_GITOPS_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH,
  },
  review: {
    read: WORKSPACE_ACTIONS.WORKSPACE_REVIEW_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_REVIEW_ACT,
  },
  members: {
    read: WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_MEMBERS_MANAGE,
  },
  marketplace: {
    read: WORKSPACE_ACTIONS.WORKSPACE_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_GITOPS_PUSH,
  },
  // LLM gateway sections — visible to any workspace member; the backend enforces
  // the specific gateway capability (logs/spend.read, budget.set, keys.manage)
  // on each mutation route, so visibility gates on project.read.
  'llm-management': {
    read: WORKSPACE_ACTIONS.WORKSPACE_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_WRITE,
  },
  'llm-overview': {
    read: WORKSPACE_ACTIONS.WORKSPACE_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_WRITE,
  },
  'llm-providers': {
    read: WORKSPACE_ACTIONS.WORKSPACE_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_WRITE,
  },
  'llm-logs': { read: WORKSPACE_ACTIONS.WORKSPACE_READ, write: WORKSPACE_ACTIONS.WORKSPACE_WRITE },
  'llm-budgets': {
    read: WORKSPACE_ACTIONS.WORKSPACE_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_WRITE,
  },
  'llm-keys': { read: WORKSPACE_ACTIONS.WORKSPACE_READ, write: WORKSPACE_ACTIONS.WORKSPACE_WRITE },
  'llm-api': { read: WORKSPACE_ACTIONS.WORKSPACE_READ, write: WORKSPACE_ACTIONS.WORKSPACE_WRITE },
  sandbox: {
    read: WORKSPACE_ACTIONS.WORKSPACE_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE,
  },
  settings: { read: WORKSPACE_ACTIONS.WORKSPACE_READ, write: WORKSPACE_ACTIONS.WORKSPACE_WRITE },
  // Feature flags — any member SEES which flags this workspace runs; only
  // project.customize.write may flip one. That is the leaf the API asserts on
  // `PATCH /workspaces/:id/features`, so the toggle gates on exactly it.
  'feature-flags': {
    read: WORKSPACE_ACTIONS.WORKSPACE_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE,
  },
  // `upgrade` (migrate the manifest to v2) starts an agent session that edits the
  // repo and opens a CR — the session itself asserts the real leaves; visibility
  // follows settings (editor+ via customize.write in isCustomizeSectionVisible).
  upgrade: { read: WORKSPACE_ACTIONS.WORKSPACE_READ, write: WORKSPACE_ACTIONS.WORKSPACE_WRITE },
  // Voice — a workspace-level setting (the bot's display name), not a connector;
  // follows the same gate as the sibling channel name route (r4.ts's
  // channels/meet/name uses WORKSPACE_CUSTOMIZE_WRITE, not a connector leaf).
  voice: {
    read: WORKSPACE_ACTIONS.WORKSPACE_READ,
    write: WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE,
  },
};

/** The distinct read leaves used to gate section visibility — handy for a single
 *  batched probe over every section the rail might show. */
export const CUSTOMIZE_SECTION_READ_ACTIONS: readonly WorkspaceAction[] = Array.from(
  new Set(Object.values(CUSTOMIZE_SECTION_ACCESS).map((a) => a.read)),
);

/**
 * Whether a section is visible in the rail, given the current user's resolved
 * capabilities (`caps[action].allowed`). Visibility gates on the section's own
 * READ leaf: a role that can READ a section SEES it — read-only if it lacks the
 * section's WRITE leaf (the mutating controls inside each view gate on
 * write / can_manage SEPARATELY). This mirrors the read/write split declared in
 * CUSTOMIZE_SECTION_ACCESS above and the backend's granular capability model —
 * so a custom role granted e.g. `secret.read` sees the Secrets section
 * read-only, and a role that omits a read leaf hides just that one section.
 * (Previously this ALSO required `project.customize.write`, which blanked the
 * whole panel for every read-only / granular role — the bug this fixes.) This
 * is a VISIBILITY layer only; the API re-checks every mutation. Files is NOT
 * here — it's the standalone /workspaces/[id]/files page, gated on project.file.read.
 */
export function isCustomizeSectionVisible(
  s: CustomizeSection,
  can: (action: WorkspaceAction) => boolean,
): boolean {
  return can(CUSTOMIZE_SECTION_ACCESS[s].read);
}

/** Distinct READ leaves to probe for section visibility — one batched capability
 *  call over every section the rail might show. (Edit controls inside each
 *  section gate separately on can_manage / the section's own write leaf.) */
export const CUSTOMIZE_SECTION_GATE_ACTIONS: readonly WorkspaceAction[] = Array.from(
  new Set<WorkspaceAction>(Object.values(CUSTOMIZE_SECTION_ACCESS).map((a) => a.read)),
);
