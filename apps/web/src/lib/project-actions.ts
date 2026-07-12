/**
 * Client-side mirror of the backend per-project leaf actions (apps/api/src/iam/
 * actions.ts `PROJECT_ACTIONS`) plus the customize-section → capability map that
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
 * (role-perms.ts `PROJECT_MEMBER_BASELINE`) are visible to every project role;
 * `secrets` gates on project.secret.read, which is DELIBERATELY editor-tier
 * (the sensitive file/secret reads moved off the floor `member` role), so that
 * section — like the standalone Files page — hides for plain members by design.
 */

import type { CustomizeSection } from '@/lib/customize-sections';

export const PROJECT_ACTIONS = {
  PROJECT_READ: 'project.read',
  PROJECT_WRITE: 'project.write',

  PROJECT_CR_OPEN: 'project.cr.open',
  PROJECT_CR_MERGE: 'project.cr.merge',

  PROJECT_MEMBERS_READ: 'project.members.read',
  PROJECT_MEMBERS_MANAGE: 'project.members.manage',

  PROJECT_AGENT_READ: 'project.agent.read',
  PROJECT_AGENT_WRITE: 'project.agent.write',
  PROJECT_SKILL_READ: 'project.skill.read',
  PROJECT_SKILL_WRITE: 'project.skill.write',
  PROJECT_COMMAND_READ: 'project.command.read',
  PROJECT_COMMAND_WRITE: 'project.command.write',
  PROJECT_TRIGGER_READ: 'project.trigger.read',
  PROJECT_TRIGGER_CREATE: 'project.trigger.create',
  PROJECT_FILE_READ: 'project.file.read',
  PROJECT_FILE_WRITE: 'project.file.write',
  PROJECT_CUSTOMIZE_READ: 'project.customize.read',
  PROJECT_CUSTOMIZE_WRITE: 'project.customize.write',
  PROJECT_GITOPS_READ: 'project.gitops.read',
  PROJECT_GITOPS_PUSH: 'project.gitops.push',
  PROJECT_GITOPS_MERGE: 'project.gitops.merge',
  PROJECT_SECRET_READ: 'project.secret.read',
  PROJECT_SECRET_WRITE: 'project.secret.write',
  PROJECT_CONNECTOR_READ: 'project.connector.read',
  PROJECT_CONNECTOR_WRITE: 'project.connector.write',

  PROJECT_REVIEW_READ: 'project.review.read',
  PROJECT_REVIEW_SUBMIT: 'project.review.submit',
  PROJECT_REVIEW_ACT: 'project.review.act',
} as const;

export type ProjectAction = (typeof PROJECT_ACTIONS)[keyof typeof PROJECT_ACTIONS];

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
 * - `changes` write = cr.open (opening a CR); the destructive MERGE is gated
 *   separately on project.cr.merge inside the view, never collapsed to one leaf.
 * - sandbox/dev/settings/marketplace/computers have no dedicated read leaf, so
 *   they stay visible on project.read and gate writes on the closest real leaf
 *   the backend asserts (e.g. sandbox rebuild → customize.write, marketplace
 *   install → gitops.push).
 */
export const CUSTOMIZE_SECTION_ACCESS: Record<
  CustomizeSection,
  { read: ProjectAction; write?: ProjectAction }
> = {
  agents: { read: PROJECT_ACTIONS.PROJECT_AGENT_READ, write: PROJECT_ACTIONS.PROJECT_AGENT_WRITE },
  skills: { read: PROJECT_ACTIONS.PROJECT_SKILL_READ, write: PROJECT_ACTIONS.PROJECT_SKILL_WRITE },
  commands: {
    read: PROJECT_ACTIONS.PROJECT_COMMAND_READ,
    write: PROJECT_ACTIONS.PROJECT_COMMAND_WRITE,
  },
  connectors: {
    read: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
    write: PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
  },
  secrets: {
    read: PROJECT_ACTIONS.PROJECT_SECRET_READ,
    write: PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
  },
  channels: {
    read: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
    write: PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
  },
  // `schedules` and `webhooks` are two views over the SAME backend resource
  // (project triggers, filtered client-side by `type`) — there is no
  // dedicated schedule.*/webhook.* leaf server-side (those were removed from
  // the catalog as dead/unwired; see iam/actions.ts). Gate both on the real
  // enforcement point: project.trigger.read/create. Update/delete stay gated
  // on their own leaves inside the view, same precedent as `changes` below.
  schedules: {
    read: PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
    write: PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
  },
  webhooks: {
    read: PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
    write: PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
  },
  changes: { read: PROJECT_ACTIONS.PROJECT_GITOPS_READ, write: PROJECT_ACTIONS.PROJECT_CR_OPEN },
  review: { read: PROJECT_ACTIONS.PROJECT_REVIEW_READ, write: PROJECT_ACTIONS.PROJECT_REVIEW_ACT },
  members: {
    read: PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
    write: PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
  },
  marketplace: { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_GITOPS_PUSH },
  // LLM gateway sections — visible to any project member; the backend enforces
  // the specific gateway capability (logs/spend.read, budget.set, keys.manage)
  // on each mutation route, so visibility gates on project.read.
  'llm-management': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  'llm-overview': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  'llm-providers': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  'llm-logs': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  'llm-budgets': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  'llm-keys': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  sandbox: { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE },
  dev: { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  settings: { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  // `upgrade` (migrate the manifest to v2) starts an agent session that edits the
  // repo and opens a CR — the session itself asserts the real leaves; visibility
  // follows settings (editor+ via customize.write in isCustomizeSectionVisible).
  upgrade: { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  computers: { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE },
  // Meetings (notetaker bot) — connector-backed (materializes kortix_meet), so
  // it follows the connector leaves like channels does.
  meet: {
    read: PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
    write: PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
  },
};

/** The distinct read leaves used to gate section visibility — handy for a single
 *  batched probe over every section the rail might show. */
export const CUSTOMIZE_SECTION_READ_ACTIONS: readonly ProjectAction[] = Array.from(
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
 * here — it's the standalone /projects/[id]/files page, gated on project.file.read.
 */
export function isCustomizeSectionVisible(
  s: CustomizeSection,
  can: (action: ProjectAction) => boolean,
): boolean {
  return can(CUSTOMIZE_SECTION_ACCESS[s].read);
}

/** Distinct READ leaves to probe for section visibility — one batched capability
 *  call over every section the rail might show. (Edit controls inside each
 *  section gate separately on can_manage / the section's own write leaf.) */
export const CUSTOMIZE_SECTION_GATE_ACTIONS: readonly ProjectAction[] = Array.from(
  new Set<ProjectAction>(Object.values(CUSTOMIZE_SECTION_ACCESS).map((a) => a.read)),
);
