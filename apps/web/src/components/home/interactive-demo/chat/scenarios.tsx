import {
  Blocks,
  Database,
  Download,
  FileText,
  GitPullRequest,
  Mail,
  MessageSquare,
  Users,
} from 'lucide-react';
import type { DemoScenario, DemoStep } from '../types';
import { matchSkillsFromPrompt } from './match-skills';
import { FileResult, ListResult, SentResult } from './result-card';

export const SCENARIOS: DemoScenario[] = [
  {
    id: 'deck',
    prompt: 'Build the Q3 board deck from our latest financials.',
    sessionName: 'q3-board-deck',
    thinkingLabel: 'Reading the latest financials…',
    skills: ['sql-queries', 'financial-statements', 'visualization', 'pptx'],
    steps: [
      {
        id: 'deck-sql',
        kind: 'tool',
        tool: 'query_warehouse',
        icon: Database,
        title: 'Querying metrics.q3',
        durationMs: 1600,
      },
      {
        id: 'deck-text',
        kind: 'text',
        markdown:
          'Pulled **312 rows** from `metrics.q3`. Revenue is up **18% QoQ**, burn down **9%**. Drafting the board narrative and charts now.',
      },
      {
        id: 'deck-result',
        kind: 'result',
        render: () => (
          <FileResult
            name="Q3-board-deck.pptx"
            meta="12 slides · ready in 4 min"
            icon={FileText}
            action={Download}
          />
        ),
      },
    ],
  },
  {
    id: 'pipeline',
    prompt: "Summarize this week's pipeline updates…",
    sessionName: 'pipeline-weekly',
    thinkingLabel: 'Reading CRM activity…',
    skills: ['customer-research', 'daily-briefing', 'stakeholder-comms'],
    steps: [
      {
        id: 'pipe-crm',
        kind: 'tool',
        tool: 'hubspot.search',
        icon: Users,
        title: 'Fetching deals updated ≤ 7d',
        durationMs: 1400,
      },
      {
        id: 'pipe-text',
        kind: 'text',
        markdown:
          '**This week:** 7 deals advanced, 2 slipped.\n\n- **Acme** → Proposal ($120k)\n- **Globex** → Negotiation ($90k)\n- At risk: **Initech**, **Umbrella** — no activity in 14 days',
      },
    ],
  },
  {
    id: 'repos',
    prompt: 'What changed in our repos since Monday?',
    sessionName: 'repo-changes',
    thinkingLabel: 'Scanning commits since Monday…',
    skills: ['coding-and-data', 'validation'],
    steps: [
      {
        id: 'repo-gh',
        kind: 'tool',
        tool: 'github.list_commits',
        icon: GitPullRequest,
        title: 'kortix-ai/kortix · since Mon',
        durationMs: 1500,
      },
      {
        id: 'repo-result',
        kind: 'result',
        render: () => (
          <ListResult
            title="34 commits across 5 repos"
            items={[
              'feat(api): streaming tool results',
              'fix(web): hydration noise on demo',
              'chore: bump opencode to 0.4.2',
            ]}
          />
        ),
      },
    ],
  },
  {
    id: 'finance',
    prompt: 'Run the weekly finance report and email the team…',
    sessionName: 'finance-weekly',
    thinkingLabel: 'Compiling the weekly numbers…',
    skills: ['sql-queries', 'financial-statements', 'xlsx', 'stakeholder-comms'],
    steps: [
      {
        id: 'fin-sql',
        kind: 'tool',
        tool: 'query_warehouse',
        icon: Database,
        title: 'Aggregating finance.weekly',
        durationMs: 1400,
      },
      {
        id: 'fin-mail',
        kind: 'tool',
        tool: 'gmail.send',
        icon: Mail,
        title: 'Emailing finance@acme.ai',
        durationMs: 1100,
      },
      {
        id: 'fin-result',
        kind: 'result',
        render: () => (
          <SentResult title="Weekly finance report sent" meta="to finance@acme.ai · 6 recipients" />
        ),
      },
    ],
  },
];

/** The prompt the demo auto-types on first view — must match a scenario. */
export const AUTO_DEMO_PROMPT = SCENARIOS[0].prompt;

export const GENERIC_ID = 'generic';

function genericToolStep(skills: string[]): DemoStep {
  const lead = skills[0];
  const bySkill: Record<string, DemoStep> = {
    'sql-queries': {
      id: 'gen-sql',
      kind: 'tool',
      tool: 'query_warehouse',
      icon: Database,
      title: 'Pulling warehouse context',
      durationMs: 1400,
    },
    'coding-and-data': {
      id: 'gen-gh',
      kind: 'tool',
      tool: 'github.list_commits',
      icon: GitPullRequest,
      title: 'Scanning recent repo activity',
      durationMs: 1400,
    },
    'kortix-slack': {
      id: 'gen-slack',
      kind: 'tool',
      tool: 'slack.conversations_history',
      icon: MessageSquare,
      title: 'Reading the Slack thread',
      durationMs: 1300,
    },
    'customer-research': {
      id: 'gen-crm',
      kind: 'tool',
      tool: 'hubspot.search',
      icon: Users,
      title: 'Fetching account context',
      durationMs: 1400,
    },
    'financial-statements': {
      id: 'gen-fin',
      kind: 'tool',
      tool: 'query_warehouse',
      icon: Database,
      title: 'Loading finance.weekly',
      durationMs: 1400,
    },
  };
  return (
    bySkill[lead] ?? {
      id: 'gen-route',
      kind: 'tool',
      tool: 'kortix.route',
      icon: Blocks,
      title: 'Routing across connected tools',
      durationMs: 1200,
    }
  );
}

function genericThinkingLabel(skills: string[]): string {
  if (skills.length === 1) return `Reading ${skills[0]}…`;
  return `Reading ${skills.slice(0, 2).join(', ')}…`;
}

export function matchScenario(text: string): DemoScenario {
  const found = SCENARIOS.find((s) => s.prompt.trim().toLowerCase() === text.trim().toLowerCase());
  if (found) return found;

  const skills = matchSkillsFromPrompt(text);
  return {
    id: GENERIC_ID,
    prompt: text,
    sessionName: 'new-session',
    thinkingLabel: genericThinkingLabel(skills),
    skills,
    steps: [
      genericToolStep(skills),
      {
        id: 'gen-text',
        kind: 'text',
        markdown: `Here's how I'd approach **"${text.slice(0, 80)}"**:\n\n1. Gather the relevant context across your tools\n2. Draft a plan and confirm the details\n3. Execute end-to-end and report back\n\nWant me to start?`,
      },
    ],
  };
}
