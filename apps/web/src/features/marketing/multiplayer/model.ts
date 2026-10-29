import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
/**
 * `/multiplayer` copy, laid out like the home page and /security: a hero with
 * one shared-session walkthrough, four pillars, one tab per topic, the places
 * people work from, then the FAQ. Localized.
 *
 * Every line was checked on 2026-10-28 against the source named above its
 * block. Standing rules (kortix-brand `claims.md`): approval rules are off
 * until you set them; merge is default-deny for agents; no price, no metric,
 * no customer. Sample data is the fictional Arcadia; people are "Member N".
 * Channels on this page are Slack and Microsoft Teams only (claims.md
 * "Channels" rows; the menu's "Use it from" group).
 */

/* Hero. Sources: guide.mdx "Teams" → "Share a session" (private by default,
   Only you / Specific people / Whole project; everyone with access reads and
   continues it); "Everywhere" → "The web app" (send a message while the agent
   works, it reads it at its next step); "Connectors" → "Approving a held
   action" (a project manager or the person who started the session decides);
   packages/ui/src/session/participants/session-participants.tsx (a shared
   session shows each message's author and the participant stack). */
export const hero = {
  title: 'Multiplayer AI.',
  titleMuted: 'One AI for the whole team.',
  sub: 'Everyone works with the same agents, skills, memory and connectors. Share a session, write in it together, and approve what the agent does.',
  caption: 'One session, many people.',
  captionMuted: 'Everyone with access reads it and continues it.',
} as const;

export type WalkStep = { readonly id: string; readonly label: string; readonly line: string };

export const walk: readonly WalkStep[] = [
  {
    id: 'start',
    label: 'Start',
    line: 'Member 1 starts a session. The agent loads the team’s skill and reads the company’s memory.',
  },
  {
    id: 'share',
    label: 'Share',
    line: 'A session is private until its owner shares it. Here, with the Finance group.',
  },
  {
    id: 'together',
    label: 'Write together',
    line: 'Member 2 writes while the agent works. The agent reads it at its next step.',
  },
  {
    id: 'approve',
    label: 'Approve',
    line: 'The email rule is Ask, so the agent waits. A project manager approves the one exact call.',
  },
];

/* Pillars. Sources: guide.mdx "Agents" (a change reaches new and running
   sessions; assign on the People page; acts as itself), "Skills" (Markdown,
   one skill serves many agents, edits land through a change request),
   "Drive" (Company folder, Memory as Markdown, read with the folder's
   rights), "Connectors" (Who can use an account; Only you is the default;
   Allow, Ask, Block). */
export const pillars = {
  title: 'Set it up once.',
  titleMuted: 'The whole team works from it.',
  items: [
    {
      id: 'agents',
      name: 'Agents',
      line: 'The same agents for everyone.',
      facts: [
        'A change reaches running sessions',
        'You choose who may run each one',
        'It acts as itself, not as you',
      ],
    },
    {
      id: 'skills',
      name: 'Skills',
      line: 'Your playbooks, written once.',
      facts: [
        'Markdown files in the project',
        'One skill serves many agents',
        'Edits land through review',
      ],
    },
    {
      id: 'memory',
      name: 'Drive and memory',
      line: 'What the company knows.',
      facts: [
        'A Company folder for every member',
        'Memory as Markdown files',
        'Read with the folder’s rights',
      ],
    },
    {
      id: 'connectors',
      name: 'Connectors',
      line: 'Connect an app once.',
      facts: [
        'Share an account with the project',
        'Or keep it to Only you',
        'Allow, Ask or Block per action',
      ],
    },
  ],
} as const;

/* Tabs. Each cites its sources.
   share: guide.mdx "Teams" → "Share a session".
   together: guide.mdx "Teams" → "Share a session"; "Everywhere" → "The web
     app"; session-participants.tsx (author above each message).
   channels: guide.mdx "Channels" (one Slack thread is one session; only a
     mention reaches the agent; /kortix login, /login; join policies; approval
     cards in the thread).
   access: guide.mdx "Teams" (account and project roles; Grant access →
     Agents: All agents / Only these…; groups are an Enterprise feature;
     identity provider sync), "Invite your team".
   approve: guide.mdx "Connectors" → "Allow, Ask, Block", "Approving a held
     action"; "Agents" → "How an agent asks before risky actions" (change
     requests on Review). claims.md: approval gates are off until you set them.
   personal: guide.mdx "Agents" → "What an agent can access" (personal
     accounts reach only a private session), "Drive" → "Folders"
     (/drives/me), "Connectors" → "Who can use an account" (automations never
     use a private account), "Security" → secret audience table. */
export const tabs = {
  title: 'How it works.',
  titleMuted: 'From one person to the whole team.',
  items: [
    {
      id: 'share',
      title: 'Share a session',
      description: 'Private by default. The owner opens it up.',
      body: [
        'A session is private to the person who started it. The owner can open it to chosen people and groups, or to the whole project.',
        'A public link shows it read-only to anyone with the link. Revoke it at any time.',
      ],
    },
    {
      id: 'together',
      title: 'Work in it together',
      description: 'Everyone with access reads it and continues it.',
      body: [
        'Each message shows who sent it. Anyone with access can pick up where the last person stopped.',
        'Send a message while the agent works. It reads it at its next step.',
      ],
    },
    {
      id: 'channels',
      title: 'Slack and Microsoft Teams',
      description: 'Mention the bot. The agent replies in the thread.',
      body: [
        'In Slack, one thread is one session, and everyone in the thread works in it. Each person links their Kortix account once, so Kortix knows who asked.',
        'A join policy decides who may join a session that started in a channel.',
      ],
    },
    {
      id: 'access',
      title: 'Who may run which agent',
      description: 'Roles per account and project, agents per person.',
      body: [
        'Each person has an account role and a role in each project. A group gives a project to everyone in it.',
        'A member starts sessions only with an agent assigned to them, their group or the whole project.',
      ],
    },
    {
      id: 'approve',
      title: 'People approve',
      description: 'You decide what an agent does without a person.',
      body: [
        'Set each connector action to Allow, Ask or Block. Ask holds the action until a project manager or the person who started the session decides.',
        'When an agent changes a skill, its memory or another agent, it opens a change request. A person reviews it.',
      ],
    },
    {
      id: 'personal',
      title: 'Personal stays personal',
      description: 'Your own accounts reach only your private sessions.',
      body: [
        'Your own folder, and accounts and secrets set to Only you, reach a session only when it is private and runs for you.',
        'A shared session or a scheduled run acts for nobody. It gets only what is shared with the project.',
      ],
    },
  ],
} as const;

/* Tab visuals. Sample data: Arcadia, Member N. */
export const shareOptions = [
  { id: 'private', k: 'Only you', v: 'The owner. This is the default.' },
  {
    id: 'restricted',
    k: 'Specific people',
    v: 'The owner, plus the members and groups they pick.',
  },
  { id: 'project', k: 'Whole project', v: 'Every member of the project.' },
] as const;

export const joinPolicies = [
  { k: 'Open', v: 'Any linked project member. The default.' },
  { k: 'Approval', v: 'The session owner approves each new person.' },
  { k: 'Owner only', v: 'Only the person who started it.' },
] as const;

export const roles = {
  account: ['Owner', 'Admin', 'Member'],
  project: ['Manager', 'Member'],
} as const;

export const agentPick = [
  { k: 'kortix', on: true },
  { k: 'finance-analyst', on: true },
  { k: 'support', on: false },
] as const;

export const reach = {
  private: {
    title: 'Your private session',
    items: [
      'Your own Drive folder',
      'Accounts set to Only you',
      'Secrets set to Only you',
      'Everything shared with the project',
    ],
  },
  shared: {
    title: 'Shared session or scheduled run',
    items: [
      'The Company folder',
      'Accounts shared with the project',
      'Secrets for everyone in the project',
    ],
  },
  note: 'In every case, the agent also needs access to the connector or secret.',
} as const;

/* Where people work. Sources: guide.mdx "Everywhere" (web, desktop, mobile,
   terminal, MCP; all read the same projects and sessions), "Channels".
   Each links to its page in the menu's "Use it from" group. */
export const surfaces = {
  title: 'Work where you already are.',
  titleMuted: 'Every surface reads the same projects and sessions.',
  items: [
    { id: 'web', k: 'Web app', v: 'The main place to work.', href: '/docs/guide#everywhere' },
    {
      id: 'desktop',
      k: 'Desktop',
      v: 'Quick Entry starts a session from any app.',
      href: '/desktop',
    },
    {
      id: 'mobile',
      k: 'Mobile',
      v: 'Follow sessions and get notified when one needs you.',
      href: '/mobile',
    },
    {
      id: 'cli',
      k: 'CLI',
      v: 'Run sessions and review change requests from a terminal.',
      href: '/cli',
    },
    { id: 'slack', k: 'Slack', v: 'Mention the bot. One thread is one session.', href: '/slack' },
    {
      id: 'teams',
      k: 'Microsoft Teams',
      v: 'Mention the app in a chat or a channel.',
      href: '/teams',
    },
  ],
} as const;

/* FAQ. Sources per answer: guide.mdx "Teams" (share, roles, groups,
   members are unlimited), "Agents" (acts as itself), "Connectors"
   (approving), "Channels" (account link: once, 10 minutes), "Security" →
   "Audit log", "Single sign-on and directory sync"; claims.md "Price"
   (members are unlimited and free, one credit pool) and "Audit". */
export const faqItems = [
  {
    id: 'faq-members',
    question: 'Is there a limit on members?',
    answer: 'No. Members are unlimited and free, and the account shares one credit pool.',
  },
  {
    id: 'faq-who-sees',
    question: 'Who can see my sessions?',
    answer:
      'Only you, until you share one. Share it with specific people and groups, or with the whole project. Only the owner can change who has access.',
  },
  {
    id: 'faq-continue',
    question: 'Can a teammate continue my session?',
    answer:
      'Yes. Everyone with access can read the session and send the next message. Each message shows who sent it.',
  },
  {
    id: 'faq-permissions',
    question: 'Does the agent get my permissions when I run it?',
    answer:
      'No. An agent acts as itself, with only the access it was granted. It does the same thing whoever runs it. Your role does not lend it extra power.',
  },
  {
    id: 'faq-approve',
    question: 'Who approves a held action?',
    answer:
      'A project manager, or the person who started the session. They decide on the Review page or on the approval card in the Slack or Teams thread. An approval covers one exact action.',
  },
  {
    id: 'faq-slack',
    question: 'How does Kortix know who wrote in Slack or Teams?',
    answer:
      'Each person links their Kortix account once, with /kortix login in Slack or /login in Teams. Kortix then checks that the sender is a project member who may start sessions.',
  },
  {
    id: 'faq-groups',
    question: 'Can our identity provider manage the teams?',
    answer:
      'Yes. Directory sync (SCIM) lets your identity provider add, update and remove members and groups. When someone leaves your company, they lose access in Kortix too. It is an Enterprise feature.',
  },
  {
    id: 'faq-audit',
    question: 'Can we see who did what?',
    answer:
      'Every action is recorded. When an agent acts, the row names the person it acted for. Reading, exporting and streaming the audit log depend on the plan.',
  },
] as const;

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      walk,
      pillars,
      tabs,
      shareOptions,
      joinPolicies,
      roles,
      agentPick,
      reach,
      surfaces,
      faqItems,
    },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
}
