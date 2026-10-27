import { useCases } from '@/features/marketing/landing/content';

/**
 * The teams the landing's use-case ruler shows, and which library tags fall
 * under each. A use case belongs to the team of its FIRST tag
 * (content/use-cases/*.mdx); the rest of its tags are audience or format.
 *
 * Where the landing already has a card for the team (content.ts `useCases`),
 * the headline, body and result detail are that card's — one source of truth.
 * The prompts and result titles are written to the jobs the team's use cases
 * describe. Models are FAMILIES, never versions: nothing here would catch a
 * stale version number.
 */

export type TeamId =
  | 'sales'
  | 'marketing'
  | 'engineering'
  | 'finance'
  | 'support'
  | 'customer-success'
  | 'people'
  | 'operations'
  | 'security'
  | 'legal'
  | 'data'
  | 'product';

/** First tag → team. A tag not listed here leaves its use case off the ruler. */
export const TAG_TO_TEAM: Record<string, TeamId> = {
  Sales: 'sales',
  Marketing: 'marketing',
  Engineering: 'engineering',
  SRE: 'engineering',
  QA: 'engineering',
  Testing: 'engineering',
  Documentation: 'engineering',
  Finance: 'finance',
  Support: 'support',
  'Customer Support': 'support',
  'Customer Success': 'customer-success',
  People: 'people',
  HR: 'people',
  Recruiting: 'people',
  Operations: 'operations',
  Productivity: 'operations',
  Security: 'security',
  Legal: 'legal',
  Data: 'data',
  Product: 'product',
};

const card = (id: string) => {
  const found = useCases.cards.find((c) => c.id === id);
  if (!found) throw new Error(`landing use-case card "${id}" is missing`);
  return { headline: found.headline, body: found.body, detail: found.artifact.footer };
};

type Team = {
  id: TeamId;
  label: string;
  headline: string;
  body: string;
  prompt: string;
  result: string;
  detail: string;
  model: string;
};

/** Ruler order. Engineering opens selected. */
export const TEAMS: Team[] = [
  {
    id: 'sales',
    label: 'Sales',
    ...card('sales'),
    prompt: 'Pull this week’s leads from Apollo, enrich them and write a sequence for each.',
    result: 'Outbound drafted, sends held for you',
    model: 'Sonnet',
  },
  {
    id: 'marketing',
    label: 'Marketing',
    ...card('marketing'),
    prompt: 'Find the pages losing rank this week and rewrite them against the brief.',
    result: 'Rewrites opened for review',
    model: 'GPT',
  },
  {
    id: 'finance',
    label: 'Finance',
    ...card('finance'),
    prompt: 'Reconcile June against the bank and chase the receipts that are missing.',
    result: 'Month closed, variance explained',
    model: 'Sonnet',
  },
  {
    id: 'engineering',
    label: 'Engineering',
    ...card('engineering'),
    prompt: 'Sweep today’s errors, fix the worst one and open a change request.',
    result: 'Change request opened against main',
    model: 'Opus',
  },
  {
    id: 'support',
    label: 'Support',
    headline: 'Every ticket answered, the sensitive ones held for you.',
    body: 'It triages every inbound thread, resolves what your docs and codebase can answer, routes escalations to the right team and turns repeat questions into help articles.',
    prompt: 'Triage the support queue and route anything about to breach its SLA.',
    result: 'Queue triaged, escalations routed',
    detail: '38 threads · 31 resolved · 3 escalated with context',
    model: 'Sonnet',
  },
  {
    id: 'customer-success',
    label: 'Customer Success',
    headline: 'Churn risk flagged before the renewal call.',
    body: 'It scores every account on usage, support and billing signals, flags the ones at risk with a reason, and drafts the QBR deck and renewal packet for the owner.',
    prompt: 'Score our accounts for churn risk and draft outreach for the five most at risk.',
    result: 'At-risk list posted to #cs',
    detail: '41 accounts scored · 5 flagged with a next step',
    model: 'Opus',
  },
  {
    id: 'people',
    label: 'People',
    ...card('people'),
    prompt: 'Find staff infra engineers who clear our bar and draft a first note to each.',
    result: 'Shortlist scored and approached',
    model: 'Gemini',
  },
  {
    id: 'operations',
    label: 'Operations',
    headline: 'The routine done on schedule, without reminders.',
    body: 'It onboards new hires and vendors, posts the standup, and takes any task you ask for in Slack across every tool it is connected to.',
    prompt: 'Onboard our new designer: accounts, groups and a first-week checklist.',
    result: 'Accounts ready, held for your approval',
    detail: '6 accounts · 4 groups · checklist filed',
    model: 'Sonnet',
  },
  {
    id: 'security',
    label: 'Security',
    headline: 'Drift caught and the access queue cleared.',
    body: 'It sweeps resources against policy, triages reported phishing, prepares least-privilege grants and runs offboarding. Every change waits for a human.',
    prompt: 'Check today’s resources against policy and propose the fixes.',
    result: 'Findings filed, fixes in review',
    detail: '2 public buckets · 5 untagged · 1 role too broad',
    model: 'Opus',
  },
  {
    id: 'legal',
    label: 'Legal',
    headline: 'NDAs turned around in minutes, not days.',
    body: 'It reviews every inbound contract against your playbook, redlines the non-standard terms and works data-subject requests to their deadline. Counsel signs; it never does.',
    prompt: 'Review this NDA against our playbook and redline anything non-standard.',
    result: 'Redlines ready for counsel',
    detail: '3 clauses flagged · summary posted to #legal',
    model: 'Opus',
  },
  {
    id: 'data',
    label: 'Data',
    ...card('data-science'),
    prompt: 'Pull Monday’s win rate, chart it against last week and post it to #revenue.',
    result: 'Report posted to #revenue',
    model: 'Sonnet',
  },
  {
    id: 'product',
    label: 'Product',
    ...card('product'),
    prompt: 'Group this week’s feedback into themes and fix the top one.',
    result: 'Themes grouped, top fix in review',
    model: 'Opus',
  },
];
