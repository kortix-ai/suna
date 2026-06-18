/**
 * Scroll-synced "How it works" section.
 *
 * Marketing order:
 *   01 Connect → wire company tools once
 *   02 Ask     → teams request outcomes in plain language
 *   03 Work    → each task runs in a secure workspace
 *   04 Review  → finished output returns for human approval
 *   05 Skills  → good workflows become reusable skills
 *   06 Memory  → company context compounds over time
 */

export type Step = {
  id: string;
  step: string;
  label: string;
  title: string;
  description: string;
  bullets: string[];
};

export const STEPS: Step[] = [
  {
    id: 'connect',
    step: '01',
    label: 'Connect',
    title: 'Connect your tools once.',
    description:
      'Connect Slack, docs, tickets, CRM, databases, code, and internal systems with scoped access.',
    bullets: [
      '3,000+ app connections, plus MCP, OpenAPI, GraphQL, and HTTP',
      'Credentials stay brokered by Kortix instead of copied into a session',
      'Connect tools per project so every coworker has the right reach',
      'Admins keep control over what can run, ask first, or stay blocked',
    ],
  },
  {
    id: 'ask',
    step: '02',
    label: 'Ask',
    title: 'Ask for the outcome.',
    description:
      'Your team describes what they need in plain language from Slack, the web workspace, or the CLI.',
    bullets: [
      'No prompt engineering course before the first useful task',
      'Ask for a report, brief, dashboard, reply, app, or reviewable change',
      'Slack, web, and CLI all start the same underlying kind of work',
      'Follow-up messages keep the context instead of starting over',
    ],
  },
  {
    id: 'work',
    step: '03',
    label: 'Work',
    title: 'Kortix works safely.',
    description:
      'Each task runs in a secure workspace with its own permissions, files, and audit trail.',
    bullets: [
      'A session gets its own isolated sandbox and branch',
      'The coworker can use connected tools without holding raw credentials',
      'Long-running work continues after you leave the tab',
      'Every important action stays logged, reviewable, or approval-gated',
    ],
  },
  {
    id: 'review',
    step: '04',
    label: 'Review',
    title: 'Review what comes back.',
    description:
      'Kortix returns the finished output: a report, deck, dashboard, app, reply, or change request.',
    bullets: [
      'People stay in control before important work ships',
      'Files, diffs, and results open in the workspace instead of getting lost',
      'Change requests make builder work auditable before it reaches main',
      'Approved work becomes part of the company system',
    ],
  },
  {
    id: 'skills',
    step: '05',
    label: 'Skills',
    title: 'Save the workflow as a skill.',
    description:
      'The best way to do the task becomes reusable, so the next person starts from a stronger place.',
    bullets: [
      'Capture repeatable know-how in simple skill files',
      'Attach skills to the coworkers that need them',
      'Improve skills through the same reviewable change flow',
      'One person levels up the whole team overnight',
    ],
  },
  {
    id: 'memory',
    step: '06',
    label: 'Memory',
    title: 'It remembers useful context.',
    description:
      'Future work starts with the company knowledge Kortix has already learned from tools, files, and previous sessions.',
    bullets: [
      'Relevant projects, people, docs, and decisions carry forward',
      'Memory helps coworkers avoid asking the same setup questions',
      'Context remains part of the system your team can inspect and improve',
      'Your company gets sharper as workflows compound',
    ],
  },
];
