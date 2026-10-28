/*
 * /multiplayer copy: the "Multiplayer AI" pillar as its own page.
 *
 * Facts, each checked in the source named (2026-10-28):
 * - docs/guide.mdx "Agents": a change to an agent reaches new and running
 *   sessions; access is deny-by-default; an agent acts as itself; personal
 *   accounts, secrets and the own computer reach only private sessions.
 * - docs/guide.mdx "Skills": one skill serves many agents; you choose which.
 * - docs/guide.mdx "Drive": Company folder, shared folders, Memory as
 *   Markdown, read with the folder's rights; /drives/me only in a private
 *   session you started.
 * - docs/guide.mdx "Connectors": account audience (Only you is the default),
 *   Allow / Ask / Block, held actions on Review → Needs you or in a Slack or
 *   Teams thread; automations use only accounts shared with the project.
 * - docs/guide.mdx "Channels": Slack, Microsoft Teams and Telegram; one
 *   Slack thread is one session; /kortix login and /login; join policies.
 *   Code: CHANNEL_PLATFORMS in packages/manifest-schema/src/constants.ts
 *   lists telegram. Email is not in the Guide, so it is left out.
 * - docs/guide.mdx "Everywhere": web, desktop, mobile, terminal, MCP.
 * - docs/guide.mdx "Teams": roles, groups (an Enterprise feature), agent
 *   assignment, session access (private / restricted / project in
 *   apps/api/src/projects/lib/session-visibility.ts), public link.
 * - docs/guide.mdx "Security" → "Secrets", "Audit log".
 * - kortix-brand claims.md "Price": members are unlimited and free, and the
 *   account shares one credit pool. "Audit": every action is recorded.
 */

export type Item = { id: string; k: string; v: string };

/** One project, shared by everyone in it. */
export const SHARED: readonly Item[] = [
  {
    id: 'agents',
    k: 'Agents',
    v: 'Everyone runs the same agents. A change to an agent reaches new sessions and running ones.',
  },
  {
    id: 'skills',
    k: 'Skills',
    v: 'Playbooks as Markdown files in the project. One skill serves many agents. You choose which agents may load it.',
  },
  {
    id: 'drive',
    k: 'Drive and memory',
    v: 'Company is one folder every project member can open. Memory is what the company knows, as Markdown files in Memory folders.',
  },
  {
    id: 'connectors',
    k: 'Connectors',
    v: 'Connect an app once. Share the account with everyone in the project, or with the people, groups or agents you pick.',
  },
];

/** Every surface reads the same projects and sessions. */
export const SURFACES: readonly Item[] = [
  {
    id: 'web',
    k: 'Web and desktop app',
    v: 'The main place to work. The desktop app is the web app in a native window. Quick Entry starts a session from any app.',
  },
  {
    id: 'mobile',
    k: 'Mobile app',
    v: 'Start and follow sessions, dictate a message and accept invites. Your phone gets a notification when your session finishes, fails or asks you something.',
  },
  {
    id: 'slack-teams',
    k: 'Slack and Microsoft Teams',
    v: 'Mention the bot with a task. The agent replies in the thread. Each person links their Kortix account once, so Kortix knows who asked and checks that this person may run the agent.',
  },
  {
    id: 'telegram',
    k: 'Telegram',
    v: 'Message the project’s bot. The allowed-user list decides who may talk to it.',
  },
  {
    id: 'terminal',
    k: 'Terminal',
    v: 'The kortix command line creates projects, runs sessions, reviews change requests and configures agents, connectors and secrets.',
  },
  {
    id: 'mcp',
    k: 'Other AI tools',
    v: 'Claude, ChatGPT, Cursor and other MCP clients start sessions and call your connectors through Kortix. The tool acts as you, with your permissions.',
  },
];

/** What people with access to a session can do. */
export const SESSION_FACTS: readonly Item[] = [
  {
    id: 'continue',
    k: 'Read it and continue it',
    v: 'Everyone with access can read the conversation and continue it. Only the owner can change who has access.',
  },
  {
    id: 'steer',
    k: 'Write while it works',
    v: 'Send a message while the agent works. It reads it at its next step.',
  },
  {
    id: 'threads',
    k: 'One thread, one session',
    v: 'In Slack, the people in a thread share one session. A join policy decides who may join: Open, Approval or Owner only.',
  },
  {
    id: 'public',
    k: 'Public link',
    v: 'A read-only view of the conversation for anyone with the link, without sign-in. Revoke it at any time.',
  },
];

/** Roles, assignments, review and the audit log. */
export const CONTROL: readonly Item[] = [
  {
    id: 'roles',
    k: 'Roles',
    v: 'Owner, admin or member in the account. Manager or member in each project. A project member starts sessions and sends work for review. A manager changes settings and merges.',
  },
  {
    id: 'groups',
    k: 'Groups',
    v: 'Give a group a project, and everyone in it gets it. Your identity provider can keep groups in sync. Creating groups is an Enterprise feature.',
  },
  {
    id: 'assign',
    k: 'Who may run which agent',
    v: 'A member starts sessions only with an agent assigned to them, their group or the whole project.',
  },
  {
    id: 'identity',
    k: 'The agent acts as itself',
    v: 'A session runs with the agent’s permissions, not your role. The agent does the same thing whoever runs it.',
  },
  {
    id: 'review',
    k: 'Review',
    v: 'An agent that changes a skill, its memory or another agent opens a change request. A person reviews it on the Review page.',
  },
  {
    id: 'ask',
    k: 'Ask before acting',
    v: 'You set Allow, Ask or Block for each connector action. Ask holds the action until a person approves it, on the Review page or in the Slack or Teams thread.',
  },
  {
    id: 'audit',
    k: 'Audit log',
    v: 'Every action is recorded, with the person an agent acted for. Reading, exporting and streaming the audit log depend on the plan.',
  },
];

/** Which session each resource reaches. Columns: private session you started, shared session, scheduled run. */
export const REACH_COLUMNS = ['Your private session', 'Shared session', 'Scheduled run'] as const;

export const REACH: readonly { id: string; k: string; personal: boolean }[] = [
  { id: 'my-folder', k: 'Your own Drive folder', personal: true },
  { id: 'my-account', k: 'A connector account set to Only you', personal: true },
  { id: 'my-secret', k: 'A secret set to Only you', personal: true },
  { id: 'company', k: 'The Company folder', personal: false },
  { id: 'shared-account', k: 'A connector account shared with the project', personal: false },
  { id: 'shared-secret', k: 'A secret for everyone in the project', personal: false },
];

/** The three access options of a session, in the order the Guide lists them. */
export const SHARE_OPTIONS = [
  { id: 'private', k: 'Only you', v: 'The owner. This is the default.' },
  { id: 'restricted', k: 'Specific people', v: 'The owner, plus the members and groups they pick.' },
  { id: 'project', k: 'Whole project', v: 'Every member of the project.' },
] as const;
