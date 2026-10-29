import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { MANIFEST } from './content';

/**
 * `/framework` copy, laid out like the home page: hero with one walkthrough,
 * four pillars, one tab per part, the architecture, then the FAQ.
 *
 * Localized. Every line was checked on 2026-10-28 against the source named
 * above its block. Standing rules (kortix-brand `claims.md`, D24):
 *  - This surface may name pi. Name no license. Never name kortixd in copy.
 *  - Approval rules are off until you set them: an omitted `permission` is
 *    `allow`, and `policy.default_mode` defaults to `allow_all`.
 *  - Kortix does not filter a computer's outbound traffic
 *    (`network_egress` validates and is not enforced). Never claim it.
 *  - A channel is a connector, never a `channels:` block.
 *  - Sample data is the fictional Arcadia. No customers, no prices.
 */

/* Hero. Sources: guide.mdx "A backend for agents" (a project is a git repo,
   kortix.yaml declares agents, skills, tools, connectors and triggers, every
   session runs on its own computer, triggers run agents 24/7, the SDK and
   UI reach every project and session). */
export const hero = {
  title: 'Company as code.',
  titleMuted: 'A backend framework and server for agents.',
  sub: 'A project is a git repo. kortix.yaml declares its agents, connectors, triggers and rules. Kortix runs every session on its own cloud computer, and you build your own experience with @kortix/sdk and @kortix/ui.',
  caption: 'One file in one repo.',
  captionMuted: 'Kortix runs what it declares.',
} as const;

/** A contiguous MANIFEST excerpt: `from` and `to` are the first and last
 *  lines to show, `focus` the first and last lines to mark. Found by text, so
 *  an edit to MANIFEST cannot shift a range silently. */
export type Excerpt = {
  readonly start: number;
  readonly lines: readonly string[];
  readonly focus: readonly [number, number];
};

function excerpt(from: string, to: string, focus: readonly [string, string]): Excerpt {
  // `to` and `focus` are searched from `from` on: a line such as
  // `workspace: ...` repeats in MANIFEST.
  const at = (line: string, after = 0) => {
    const i = MANIFEST.indexOf(line as (typeof MANIFEST)[number], after);
    if (i < 0) throw new Error(`MANIFEST has no line "${line}" after line ${after}`);
    return i;
  };
  const start = at(from);
  const end = at(to, start);
  const focusFrom = at(focus[0], start);
  return {
    start,
    lines: MANIFEST.slice(start, end + 1),
    focus: [focusFrom - start, at(focus[1], focusFrom) - start],
  };
}

/* The hero walkthrough: a part of kortix.yaml, then what Kortix runs from it.
   Sources: developers.mdx "Agent keys" (description, prompt_file, tools,
   connectors, skills, workspace.project_repository), "Registries and grants"
   (omitted means none); "Connector rules and approvals" (require_approval
   holds the call); guide.mdx "Connectors" (Kortix holds the login, makes and
   records each call), "Approving a held action" (24 h default);
   developers.mdx "triggers keys" (6-field cron, seconds first; timezone),
   guide.mdx "What happens when a trigger fires" (new session, own computer);
   developers.mdx "Quickstart" (kortix ship validates, commits, pushes,
   connects declared connectors), "Config comes from the base branch".
   The ship output is the shape of apps/cli/src/commands/ship.ts:280,603. */
export type WalkStep = {
  readonly id: 'agents' | 'connectors' | 'triggers' | 'ship';
  readonly label: string;
  readonly line: string;
};

export const walk: readonly WalkStep[] = [
  {
    id: 'agents',
    label: 'Declare an agent',
    line: 'One block per agent. It gets the tools, connectors and skills the block lists, and nothing else.',
  },
  {
    id: 'connectors',
    label: 'Connect an app',
    line: 'Kortix holds the LinkedIn login. One rule holds every new post until a person approves it.',
  },
  {
    id: 'triggers',
    label: 'Add a trigger',
    line: 'Every Tuesday at 10:00 a new session starts, on its own computer, with nobody at the keyboard.',
  },
  {
    id: 'ship',
    label: 'Ship it',
    line: 'kortix ship checks the file, commits and pushes. New sessions run what it declares.',
  },
];

export const walkFiles = {
  agents: excerpt('  # Engineering', '    workspace: { project_repository: true }', [
    '  eng-triage:',
    '    workspace: { project_repository: true }',
  ]),
  connectors: excerpt('connectors:', '        action: require_approval', [
    '  - slug: linkedin',
    '        action: require_approval',
  ]),
  triggers: excerpt(
    '  - slug: weekly-post',
    `      prompt: "Draft this week's LinkedIn post from merged pull requests."`,
    [
      '  - slug: weekly-post',
      `      prompt: "Draft this week's LinkedIn post from merged pull requests."`,
    ],
  ),
} as const;

export const shipTerminal = [
  '$ kortix ship',
  '  ✓  kortix.yaml verified',
  '  ✓  Shipped arcadia',
] as const;

/* What the shipped MANIFEST holds, counted from it. */
export const shipped = [
  { k: 'Agents', v: 'kortix, eng-triage, marketing, sales-inbound' },
  { k: 'Connectors', v: 'github, linkedin, hubspot' },
  { k: 'Skills', v: 'triage-issue, write-post, qualify-lead' },
  { k: 'Triggers', v: 'new-issue, inbound-lead, weekly-post' },
] as const;

/* Pillars. Sources: guide.mdx "A backend for agents"; developers.mdx
   "Quickstart" (Kortix hosts the repository or links GitHub), "File and
   schema" (kortix validate; the merge runs the schema check, 422),
   "Registries and grants" (omitted means none); harness/README.md (every new
   session runs pi); developers.mdx "Permission rules", "SDK", "Kortix UI",
   "CLI", "REST API". */
export const pillars = {
  title: 'Four ideas.',
  titleMuted: 'The whole framework, in four parts.',
  items: [
    {
      id: 'repo',
      name: 'A project is a git repo',
      line: 'Your company, versioned.',
      facts: [
        'Kortix hosts it, or link GitHub',
        'Agents, skills and memory are files',
        'Every change is a commit',
      ],
    },
    {
      id: 'manifest',
      name: 'kortix.yaml declares it',
      line: 'One file, checked before it runs.',
      facts: [
        'Agents, connectors, triggers, rules',
        'Access is deny-by-default',
        'kortix validate on ship and merge',
      ],
    },
    {
      id: 'computer',
      name: 'A computer per session',
      line: 'Where the agent works and the rules hold.',
      facts: [
        'pi runs every new session',
        'Tool rules checked before each call',
        'Its own branch in /workspace',
      ],
    },
    {
      id: 'build',
      name: 'Your own experience',
      line: 'The same backend, from code.',
      facts: [
        '@kortix/sdk: one typed client',
        '@kortix/ui: the web app’s components',
        'A CLI and a REST API',
      ],
    },
  ],
} as const;

/* Tabs. Each tab cites its sources.
   agents: guide.mdx "What an agent is made of" (behavior and access,
     deny-by-default); developers.mdx "Agent keys" (prompt_file: the whole file
     is the system prompt); claims.md Frontmatter row (v3 prompts have none).
   rules: developers.mdx "Permission rules" (allow, ask, deny; omitted is
     allow), "Connector rules and approvals", "policy keys" (default_mode
     allow_all); guide.mdx "Connector credentials stay with Kortix".
   triggers: guide.mdx "Automations" (schedule, webhook, App event; a new
     session on its own computer; a schedule skips a run while the previous
     one runs), "Reminders".
   computer: harness/README.md (every new session runs pi; models only
     through the LLM gateway); guide.mdx "Computers" (terminal, browser,
     Python, Node.js; /workspace on its own branch; /drives; sleeps ~15–20
     min, a message wakes it), "Connector credentials stay with Kortix".
   review: developers.mdx "Session branches" (branch = session_id), "Review
     and merge" (kortix cr commands), "File and schema" (merge schema check);
     guide.mdx "Agents improve their own skills".
   build: developers.mdx "SDK" (one client; servers, browsers, React),
     "Kortix UI" (the web app's component library), "The thread alone". */
export const tabs = {
  title: 'How it works.',
  titleMuted: 'One part at a time.',
  items: [
    {
      id: 'agents',
      title: 'Agents',
      description: 'One block in kortix.yaml and one prompt file.',
      body: [
        'An agent is a block in kortix.yaml and a Markdown prompt. The block names its model, tools, connectors and skills.',
        'Access is deny-by-default. An agent gets no connector, secret or skill the block does not list.',
      ],
    },
    {
      id: 'rules',
      title: 'Rules',
      description: 'Allow, Ask or Block, per tool and per app call.',
      body: [
        'Tool rules decide which commands and edits run, wait for a person, or never run. The runtime checks them before every call.',
        'Connector rules do the same for app calls. Kortix holds the login and decides outside the computer. With no rule, a call runs.',
      ],
    },
    {
      id: 'triggers',
      title: 'Triggers, 24/7',
      description: 'A schedule or a webhook starts the agent.',
      body: [
        'A trigger starts a new session on a schedule, a signed webhook or an App event. Each run gets its own computer.',
        'A reminder wakes one existing session later, with its full history.',
      ],
    },
    {
      id: 'computer',
      title: 'A computer per session',
      description: 'pi runs the agent on its own cloud computer.',
      body: [
        'Every new session runs pi, an open-source agent harness, on its own isolated cloud computer. It has a terminal, a browser, Python and Node.js.',
        'It sleeps about 15 to 20 minutes after the last turn. The next message wakes it with its files and history.',
      ],
    },
    {
      id: 'review',
      title: 'Changes through review',
      description: 'Work reaches main through a change request.',
      body: [
        'A session pushes to its own branch, named after its session_id. A person merges its change request.',
        'An agent improves a skill or a prompt the same way. The merge checks kortix.yaml again.',
      ],
    },
    {
      id: 'build',
      title: 'Build your own experience',
      description: '@kortix/sdk and @kortix/ui on the same backend.',
      body: [
        '@kortix/sdk is one typed client for projects, sessions and the live event stream, on servers and in browsers.',
        '@kortix/ui is the component library of the Kortix web app. SessionThread renders one session’s chat.',
      ],
    },
  ],
} as const;

/* Tab visuals. */
export const agentFiles = {
  yaml: excerpt('  # Marketing', '    skills: [write-post]', [
    '  marketing:',
    '    skills: [write-post]',
  ]),
  promptPath: 'agents/marketing/content.md',
} as const;

/* developers.mdx "Permission rules" (the bash globs) and the MANIFEST
   linkedin rule. An excerpt, not a whole file. */
export const rulesYaml = [
  'agents:',
  '  eng-triage:',
  '    permission:',
  '      bash:',
  '        "*": allow',
  '        "git push *": ask',
  '        "rm -rf *": deny',
  '',
  'connectors:',
  '  - slug: linkedin',
  '    provider: composio',
  '    app: linkedin',
  '    policies:',
  '      - match: "linkedin.create_*"',
  '        action: require_approval',
] as const;

export const triggerFiles = excerpt(
  'triggers:',
  '      prompt: "Triage issue #{{ body.issue.number }}: label it, find the owner, post in #eng."',
  [
    '  - slug: new-issue',
    '      prompt: "Triage issue #{{ body.issue.number }}: label it, find the owner, post in #eng."',
  ],
);

export const computer = {
  inside: [
    { k: 'pi', v: 'The agent harness' },
    { k: '/workspace', v: 'The project, on the session’s branch' },
    { k: '/drives', v: 'The Drive folders it may open' },
    { k: 'Terminal, browser', v: 'Python, Node.js, document tools' },
  ],
  outside: [
    { k: 'App calls', v: 'Connector broker' },
    { k: 'Model calls', v: 'LLM gateway' },
    { k: 'Changes to main', v: 'Change request' },
  ],
} as const;

/* developers.mdx "Review and merge": the kortix cr commands. */
export const reviewTerminal = [
  '$ kortix cr ls',
  '$ kortix cr diff 12',
  '$ kortix cr merge 12',
  '$ git pull',
] as const;

/* developers.mdx "The thread alone", without the wrapper div. */
export const uiSample = [
  "import { useSession } from '@kortix/sdk/react';",
  "import { SessionThread } from '@kortix/ui/session';",
  '',
  'export function Chat({ projectId, sessionId }) {',
  '  const session = useSession(projectId, sessionId);',
  '  return <SessionThread session={session} />;',
  '}',
] as const;

/* Architecture. Sources: guide.mdx "A backend for agents", "Everywhere"
   (web, desktop, mobile, terminal), claims.md Channels row (Slack, Microsoft
   Teams); "How the pieces fit"; "Computers"; "Models" (every model request
   through the gateway); "Drive"; developers.mdx "Quickstart" (Kortix hosts
   the repository or links GitHub). */
export const architecture = {
  title: 'The architecture.',
  titleMuted: 'One API. A computer per session.',
  clients: {
    k: 'Clients',
    v: 'People and code reach Kortix the same way.',
    chips: ['Web app', 'Desktop', 'Mobile', 'CLI', 'Slack', 'Microsoft Teams', 'Your app'],
  },
  api: {
    k: 'Kortix API',
    v: 'Decides who may run which agent, starts sessions, holds connector logins and change requests.',
  },
  repo: {
    k: 'Project repository',
    v: 'kortix.yaml, agents, skills and memory. Kortix hosts it, or you link GitHub.',
  },
  computer: {
    k: 'Session computer',
    v: 'One per session. pi works here, on the session’s own branch.',
  },
  gateway: { k: 'LLM gateway', v: 'Every model call. Kortix-managed models or your own keys.' },
  drive: { k: 'Kortix Drive', v: 'Shared folders and company memory, open at /drives.' },
} as const;

/* FAQ. Sources per answer: guide.mdx "A workspace for people" (Customize),
   "Create your own agent" (Create in chat); claims.md Autonomy rule
   (dashboard config edits commit to the default branch); developers.mdx
   "Quickstart" (GitHub origin), "File and schema", "Config comes from the
   base branch"; harness/README.md; guide.mdx "Secrets: you choose who uses
   them"; developers.mdx "env keys"; claims.md Hosting and Source rows. */
export const faqItems = [
  {
    id: 'faq-yaml',
    question: 'Do I have to write YAML?',
    answer:
      'No. People manage agents, connectors and triggers under Customize in the web app, and Create in chat writes a new agent with you. Those edits land in the same kortix.yaml.',
  },
  {
    id: 'faq-github',
    question: 'Can I keep the repository on GitHub?',
    answer:
      'Yes. With a GitHub origin, kortix ship links that repository, and plain git push and git pull work. Without one, Kortix creates and hosts the repository.',
  },
  {
    id: 'faq-validate',
    question: 'What does kortix validate check?',
    answer:
      'Every key against the schema, then the files around it: prompt files that do not exist, skill folders without a SKILL.md, and connector or secret names the file does not declare. It exits 1 on an error. kortix ship runs the same checks, and a merge with an invalid kortix.yaml is refused.',
  },
  {
    id: 'faq-live',
    question: 'When does a change to kortix.yaml take effect?',
    answer:
      'When it lands on the base branch, through a merge or a push. New sessions start with it. A running session picks it up at the start of its next turn.',
  },
  {
    id: 'faq-pi',
    question: 'What runs inside a session?',
    answer:
      'pi, an open-source agent harness. Every new session runs it on its own cloud computer, and it calls models only through the Kortix LLM gateway.',
  },
  {
    id: 'faq-secrets',
    question: 'Where do secret values live?',
    answer:
      'In Kortix, encrypted. kortix.yaml lists only the names a project needs. No page, command or API shows a stored value again.',
  },
  {
    id: 'faq-host',
    question: 'Can I run it myself?',
    answer:
      'Yes. Kortix is open source. Run it on Kortix Cloud, in your VPC, or on your own on-prem network.',
  },
] as const;

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      walk,
      walkFiles,
      shipTerminal,
      shipped,
      pillars,
      tabs,
      agentFiles,
      rulesYaml,
      triggerFiles,
      computer,
      reviewTerminal,
      uiSample,
      architecture,
      faqItems,
    },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
}
