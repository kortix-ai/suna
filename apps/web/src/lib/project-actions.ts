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
 * Gating rule (IAM v1): a capability is DEACTIVATED for a department by giving
 * its custom role a permission set that OMITS the capability's leaf. The UI
 * reflects that by hiding/disabling the section whose `read`/`write` leaf the
 * role no longer grants. Therefore every `read` leaf used below MUST be one the
 * built-in Viewer role is seeded with (role-perms.ts `VIEWER_BASELINE`) and
 * every `write` leaf one Editor is seeded with — otherwise a normal
 * viewer/editor would be stranded out of a section they should still see.
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
  PROJECT_SCHEDULE_READ: 'project.schedule.read',
  PROJECT_SCHEDULE_WRITE: 'project.schedule.write',
  PROJECT_WEBHOOK_READ: 'project.webhook.read',
  PROJECT_WEBHOOK_WRITE: 'project.webhook.write',
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
 *           be a Viewer-seeded leaf so a viewer never loses a section.
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
  schedules: {
    read: PROJECT_ACTIONS.PROJECT_SCHEDULE_READ,
    write: PROJECT_ACTIONS.PROJECT_SCHEDULE_WRITE,
  },
  webhooks: {
    read: PROJECT_ACTIONS.PROJECT_WEBHOOK_READ,
    write: PROJECT_ACTIONS.PROJECT_WEBHOOK_WRITE,
  },
  changes: { read: PROJECT_ACTIONS.PROJECT_GITOPS_READ, write: PROJECT_ACTIONS.PROJECT_CR_OPEN },
  review: { read: PROJECT_ACTIONS.PROJECT_REVIEW_READ, write: PROJECT_ACTIONS.PROJECT_REVIEW_ACT },
  files: { read: PROJECT_ACTIONS.PROJECT_FILE_READ, write: PROJECT_ACTIONS.PROJECT_FILE_WRITE },
  members: {
    read: PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
    write: PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
  },
  marketplace: { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_GITOPS_PUSH },
  // LLM gateway sections — visible to any project member; the backend enforces
  // the specific gateway capability (logs/spend.read, routing.edit, budget.set,
  // keys.manage) on each mutation route, so visibility gates on project.read.
  'llm-management': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  'llm-overview': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  'llm-providers': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  'llm-logs': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  'llm-budgets': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  'llm-keys': { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  sandbox: { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE },
  dev: { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
  settings: { read: PROJECT_ACTIONS.PROJECT_READ, write: PROJECT_ACTIONS.PROJECT_WRITE },
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
 * capabilities (`caps[action].allowed`). The rule:
 *   • `files` — visible to any member who can READ files. Files live OUTSIDE
 *     customization, so they're reachable all the time.
 *   • every other section — customization is an editor+ capability, so it shows
 *     only when the user can customize (`project.customize.write`, i.e. editor
 *     or manager) AND still holds that section's own read leaf (so a custom role
 *     that omits a read leaf keeps hiding just that section). A plain `member`
 *     (read-only floor) lacks customize.write → sees Files only.
 */
export function isCustomizeSectionVisible(
  s: CustomizeSection,
  can: (action: ProjectAction) => boolean,
): boolean {
  const a = CUSTOMIZE_SECTION_ACCESS[s];
  if (s === 'files') return can(a.read);
  return can(PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE) && can(a.read);
}

/** Distinct actions to probe for section visibility — every read leaf plus the
 *  editor+ `customize.write` gate — in one batched capability call. */
export const CUSTOMIZE_SECTION_GATE_ACTIONS: readonly ProjectAction[] = Array.from(
  new Set<ProjectAction>([
    ...Object.values(CUSTOMIZE_SECTION_ACCESS).map((a) => a.read),
    PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
  ]),
);
