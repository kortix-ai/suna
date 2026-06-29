/**
 * Scroll-synced "How it works" section.
 *
 *   01 Connect → wire company tools once
 *   02 Ask     → anyone requests an outcome in plain language
 *   03 Work    → each task runs in its own secure sandbox
 *   04 Review  → finished work returns for human approval
 *   05 Skills  → good workflows become reusable skill files
 *   06 Memory  → the company learns and compounds on its own
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
      'Wire up Slack, docs, tickets, CRM, databases, and code with scoped access — once, for the whole company.',
    bullets: [
      '3,000+ apps, plus MCP, OpenAPI, GraphQL, and HTTP',
      'Credentials stay brokered by Kortix, never copied into a session',
      'Scope each tool per project, per agent, per person',
      'Admins set what can run, what asks first, and what stays blocked',
    ],
  },
  {
    id: 'ask',
    step: '02',
    label: 'Ask',
    title: 'Ask for the outcome.',
    description:
      'Anyone on the team describes what they need in plain language — from Slack, Teams, the web, or their phone.',
    bullets: [
      'No prompt-engineering course before the first useful task',
      'Ask for a report, brief, dashboard, reply, app, or change',
      'Every surface starts the same underlying kind of work',
      'Follow-up messages keep the context instead of starting over',
    ],
  },
  {
    id: 'work',
    step: '03',
    label: 'Work',
    title: 'It works in a safe sandbox.',
    description:
      'Each task runs in its own isolated machine with scoped permissions, its own files, and a full audit trail.',
    bullets: [
      'Every session gets its own isolated sandbox and branch',
      'Agents use connected tools without ever holding raw keys',
      'Long-running work keeps going after you close the tab',
      'Every important action stays logged, reviewable, or approval-gated',
    ],
  },
  {
    id: 'review',
    step: '04',
    label: 'Review',
    title: 'Review what comes back.',
    description:
      'Kortix returns finished work — a report, deck, dashboard, app, reply, or a change request you approve.',
    bullets: [
      'People stay in control before anything important ships',
      'Files, diffs, and results open right in the workspace',
      'Change requests make every edit auditable before it reaches main',
      'Approved work becomes part of the company',
    ],
  },
  {
    id: 'skills',
    step: '05',
    label: 'Skills',
    title: 'Save the workflow as a skill.',
    description:
      'The best way to do a job becomes a reusable skill file — so the next person, and every agent, starts from a stronger place.',
    bullets: [
      'Capture repeatable know-how in simple files',
      'Attach skills to the agents that need them',
      'Improve them through the same reviewable change flow',
      'One person levels up the whole company overnight',
    ],
  },
  {
    id: 'memory',
    step: '06',
    label: 'Memory',
    title: 'It learns by itself.',
    description:
      'Every session adds to a shared memory — people, docs, decisions, context — so the next one starts smarter. The company gets sharper on its own.',
    bullets: [
      'Relevant projects, people, and decisions carry forward',
      'Agents stop asking the same setup questions twice',
      'Memory is shared by everyone and inspectable as files',
      'Your company compounds what it learns, every run',
    ],
  },
];
