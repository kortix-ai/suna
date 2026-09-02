/**
 * The starter prompts on project home, under the composer
 * (`features/workspace/project-layout/home/starter-prompt-band.tsx`).
 *
 * One is PINNED and the rest ROTATE. The band shows six rows:
 * `PINNED_STARTER_PROMPT` always first, then five drawn for the day — see
 * `starter-prompt-rotation.ts` for how the day is decided and
 * `stores/starter-prompt-rotation-store.ts` for where the pick is kept.
 *
 * ## What earns a slot
 *
 * This band is the first thing a person reads on a brand-new project. It is not
 * a feature list — it is the answer to "what is this FOR", and every row is a
 * claim about what Kortix is.
 *
 * An earlier version of this file failed that test. It was written under the
 * rule "every prompt must map to a skill in the `general-knowledge-worker`
 * template", which produced rows like "Convert docs to markdown" — a real
 * capability nobody has ever wanted for its own sake. Jay's verdict, and it was
 * the right one: "why would someone convert a docx to markdown with this
 * powerful tool?" A prompt has to name a REASON, not a capability.
 *
 * Worse, that rule excluded the things that make this an AI Management System
 * rather than a chat box. The most valuable prompts here operate on Kortix's
 * OWN primitives — they are the first group below, and they are first on
 * purpose:
 *
 *   - **agents** live in `.kortix/opencode/agents/<name>.md` with a governance
 *     entry in `kortix.yaml`;
 *   - **skills** live in `.kortix/opencode/skills/` and are served live by
 *     `kortix skills get`;
 *   - **triggers** are cron and signed-webhook entries in `kortix.yaml`;
 *   - **memory** is `.kortix/memory/`;
 *   - work lands through a **change request**, never a direct merge.
 *
 * None of that is aspirational. The shipped `base` template already carries a
 * `harness-reflector` agent whose whole job is to read recent sessions, refine
 * other agents' prompts and skills, and open a CR — so "an agent that improves
 * the company" is a thing this product does today, not a thing we hope it will.
 *
 * ## Three rules every entry still follows
 *
 * 1. **It names a reason.** "Turn this CSV into a dashboard", not "use the xlsx
 *    skill". If the row would only make sense to someone who already read the
 *    docs, it does not belong here.
 * 2. **It starts producing.** No prompt opens with a questionnaire. Each tells
 *    the agent to take its best shot from project memory and report what it
 *    guessed. The pinned prompt is the one documented exception — asking IS its
 *    job.
 * 3. **It is written in the user's voice.** These are pasted into the composer
 *    as if the person typed them, so they read as requests.
 *
 * Labels are verb-first and sentence case, capped at 32 characters so the row
 * never truncates — `starter-prompts.test.ts` enforces both the cap and rule 2.
 *
 * Worth knowing: the onboarding wizard does NOT read this list. It carries its
 * own `STARTER_PROMPTS` in `components/projects/onboarding/onboarding-profile.ts`,
 * keyed by use case. Same name, different module, no relationship.
 */

import {
  AlarmIcon,
  AppWindowIcon,
  ArrowsClockwiseIcon,
  ArticleIcon,
  BankIcon,
  BinocularsIcon,
  BooksIcon,
  BrainIcon,
  BroadcastIcon,
  BrowserIcon,
  BugIcon,
  BuildingsIcon,
  CalculatorIcon,
  CalendarIcon,
  ChartBarIcon,
  ChartDonutIcon,
  ChartLineIcon,
  ChartPieSliceIcon,
  ChatsIcon,
  CircuitryIcon,
  ClipboardIcon,
  ClockIcon,
  CodeIcon,
  CoinsIcon,
  CompassIcon,
  CurrencyDollarIcon,
  DatabaseIcon,
  DownloadIcon,
  EnvelopeSimpleIcon,
  EyeIcon,
  FileDocIcon,
  FilePdfIcon,
  FileTextIcon,
  FilesIcon,
  FlaskIcon,
  FunnelIcon,
  GaugeIcon,
  GavelIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GlobeIcon,
  GraduationCapIcon,
  HandshakeIcon,
  HighlighterIcon,
  IdentificationCardIcon,
  KanbanIcon,
  LifebuoyIcon,
  LightbulbIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  MegaphoneIcon,
  MoneyIcon,
  NewspaperIcon,
  NotepadIcon,
  PackageIcon,
  PaintBrushIcon,
  PaletteIcon,
  PathIcon,
  PercentIcon,
  PlugsIcon,
  PresentationChartIcon,
  PresentationIcon,
  PuzzlePieceIcon,
  ReceiptIcon,
  RepeatIcon,
  RobotIcon,
  RocketIcon,
  ScalesIcon,
  ShieldCheckIcon,
  SignpostIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  StorefrontIcon,
  SuitcaseIcon,
  SwapIcon,
  TableIcon,
  TargetIcon,
  TerminalIcon,
  TicketIcon,
  TimerIcon,
  TreeIcon,
  TrendUpIcon,
  TrophyIcon,
  UsersIcon,
  WalletIcon,
  WarningIcon,
  WrenchIcon,
  type Icon,
} from '@phosphor-icons/react';

export interface StarterPrompt {
  /** Stable. The daily rotation persists it, so renaming one drops that prompt
   *  from anybody who had it stored — see `isRotationUsable`. */
  id: string;
  icon: Icon;
  /** The row face. Verb first, sentence case, <= 32 chars so it never truncates. */
  label: string;
  /** The full text pre-filled into the composer, in the user's own voice. */
  prompt: string;
}

/**
 * Always first, never rotated out.
 *
 * Everything else in this file is better once the agent knows the company, so
 * this keeps its slot. It is also the only prompt here that deliberately asks
 * questions.
 */
export const PINNED_STARTER_PROMPT: StarterPrompt = {
  id: 'company-memory',
  icon: BuildingsIcon,
  label: 'Onboard your agent',
  prompt:
    "Onboard me. Ask about my company — what we do, who our customers are, who's on the team, our products, our top priorities. Save what you learn into project memory so you remember it in every future session, and open a change request when you're done so I can review.",
};

/** Shared tail for prompts that would otherwise stall on a missing fact. */
const GUESS =
  'Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.';

/**
 * The rows that say what this product IS, kept as their own list.
 *
 * Not a stylistic split. The band shows five rotating rows, and one of them is
 * RESERVED for this group — see `stores/starter-prompt-rotation-store.ts`.
 * Without that reservation these 18 compete with 167 others for five slots, and
 * the maths is brutal: **60% of days would show none of them at all**, so the
 * band would read as generic knowledge work five days out of eight. Growing the
 * pool made that worse, not better, which is exactly when a uniform pick stops
 * being the right tool.
 *
 * Everything here operates on a Kortix primitive that exists in the shipped
 * `base` template: agents in `.kortix/opencode/agents/`, skills in
 * `.kortix/opencode/skills/`, cron and webhook triggers in `kortix.yaml`,
 * memory in `.kortix/memory/`, and work landing through `kortix cr`.
 */
export const WORKFORCE_STARTER_PROMPTS: StarterPrompt[] = [
  // ── Build the workforce ───────────────────────────────────────────────
  // Kortix's own primitives: agents, skills, triggers, connectors, memory,
  // change requests. These are the rows that say what this product IS, so they
  // lead the file.
  {
    id: 'agent-create',
    icon: RobotIcon,
    label: 'Create an agent',
    prompt:
      'Create a specialist agent for a job my company does often. Write its prompt into `.kortix/opencode/agents/`, give it only the grants it actually needs in `kortix.yaml`, and open a change request so I can read it before it goes live. Pick the job that would save me the most time and tell me why you picked it.',
  },
  {
    id: 'agent-team',
    icon: UsersIcon,
    label: 'Build me a team of agents',
    prompt:
      'Design a small team of agents for my company — three or four specialists, each with a narrow job and a narrow grant — and explain how they hand work to each other. Write them up and open one change request with the lot.',
  },
  {
    id: 'skill-write',
    icon: SparkleIcon,
    label: 'Write a skill',
    prompt:
      'Turn something my company does the same way every time into a skill under `.kortix/opencode/skills/`, so every future session already knows how. Pick the highest-value one, write it properly with the steps and the gotchas, and open a change request.',
  },
  {
    id: 'skill-from-runbook',
    icon: PuzzlePieceIcon,
    label: 'Turn a habit into a skill',
    prompt:
      'I keep explaining the same process to you. Write it down as a reusable skill with the steps, the inputs, and what good output looks like, then open a change request. Ask me which process in one line if you cannot tell from memory.',
  },
  {
    id: 'agent-review',
    icon: ShieldCheckIcon,
    label: 'Review my agents',
    prompt:
      'Read every agent in this project — its prompt and its grants — and tell me which ones are vague, which are over-permissioned, and which overlap. Propose the fixes as one change request.',
  },
  {
    id: 'grants-audit',
    icon: ShieldCheckIcon,
    label: 'Audit what agents can reach',
    prompt:
      'Audit `kortix.yaml`: for each agent, list the connectors, secrets and skills it can reach, and flag anything granted `all` that does not need it. Propose a tighter set as a change request.',
  },
  {
    id: 'trigger-daily',
    icon: ClockIcon,
    label: 'Schedule a daily briefing',
    prompt:
      'Set up a cron trigger that runs every weekday morning, gathers what changed in this project, and writes me a short briefing. Add it to `kortix.yaml`, keep it disabled, and tell me the one line to flip when I want it on.',
  },
  {
    id: 'trigger-weekly',
    icon: TimerIcon,
    label: 'Schedule a weekly report',
    prompt:
      'Set up a weekly cron trigger that produces the report I would otherwise write by hand on Friday. Add it to `kortix.yaml` disabled, and show me exactly what it would have produced this week.',
  },
  {
    id: 'trigger-webhook',
    icon: LightningIcon,
    label: 'Fire work from a webhook',
    prompt:
      'Set up a signed webhook trigger so another system can start work here. Add it to `kortix.yaml`, tell me the URL and which secret holds the signing key, and write the prompt it fires.',
  },
  {
    id: 'connector-setup',
    icon: PlugsIcon,
    label: 'Connect a tool I use',
    prompt:
      'Tell me which connector is worth setting up first for a company like mine, what it would let you actually do once it is connected, and what you would need me to approve.',
  },
  {
    id: 'memory-curate',
    icon: BrainIcon,
    label: 'Tidy up project memory',
    prompt:
      'Read project memory, find what is stale, duplicated or vague, and rewrite it so a fresh session gets the truth in one pass. Open a change request with the diff.',
  },
  {
    id: 'memory-gaps',
    icon: LightbulbIcon,
    label: 'Find your blind spots',
    prompt:
      'Look at project memory and tell me the ten things you would need to know to do my job well but currently do not. Ask them as one numbered list I can answer in a single reply.',
  },
  {
    id: 'harness-improve',
    icon: ArrowsClockwiseIcon,
    label: 'Improve yourself',
    prompt:
      'Look at what recent sessions in this project actually did, find where you got stuck or repeated work, and refine the prompts, skills and memory that caused it. Open one change request titled `harness: …`.',
  },
  {
    id: 'cr-open',
    icon: GitPullRequestIcon,
    label: 'Open your first change request',
    prompt:
      'Pick the most useful improvement you can make to this project right now, make it, and open a change request explaining what you changed and why. Keep it small enough that I can review it in two minutes.',
  },
  {
    id: 'repo-tour',
    icon: CompassIcon,
    label: 'Explain my own repo to me',
    prompt:
      'Walk me through this project as it stands — what is configured, which agents exist, what is connected, what is empty — and tell me the three things worth setting up next.',
  },
  {
    id: 'agent-onboarder',
    icon: UsersIcon,
    label: 'Make an onboarding agent',
    prompt:
      'Create an agent whose job is onboarding new people at my company: it answers their questions from memory, points them at the right docs, and flags what it could not answer. Open a change request.',
  },
  {
    id: 'agent-watcher',
    icon: BinocularsIcon,
    label: 'Make a competitor watcher',
    prompt:
      "Create an agent plus a weekly trigger that watches our competitors and tells me only what actually changed. Add both to the repo disabled, and show me a sample of this week's output.",
  },
  {
    id: 'agent-inbox',
    icon: EnvelopeSimpleIcon,
    label: 'Make an inbox triager',
    prompt:
      'Create an agent that triages an inbox — sorts what needs me, what needs a reply, and what can wait — and writes a short summary. Open a change request with the agent and its grants.',
  },
];

/** Everything else: real work, but work another tool could also describe. */
export const GENERAL_STARTER_PROMPTS: StarterPrompt[] = [
  // ── Data into something you can look at ──────────────────────────────
  // `xlsx` + `webapp`. The rows people picture when they hear "the agent works
  // on a real computer".
  {
    id: 'csv-dashboard',
    icon: ChartDonutIcon,
    label: 'Turn a CSV into a dashboard',
    prompt:
      'I am attaching a raw CSV. Build me a real dashboard from it — the charts that actually explain the data, on a page I can open — and send me the URL. If nothing is attached, tell me in one line instead of waiting.',
  },
  {
    id: 'csv-charts',
    icon: ChartBarIcon,
    label: 'Chart this CSV properly',
    prompt:
      'I am attaching a CSV. Pick the right chart for each question the data answers, build them, and caption each one with what it shows. No pie charts unless a pie chart is genuinely right.',
  },
  {
    id: 'spreadsheet-analysis',
    icon: TableIcon,
    label: 'Make sense of a spreadsheet',
    prompt:
      'Read the spreadsheet I have attached, find the patterns and the outliers, and write me a short summary of what I should actually do about them. If nothing is attached, tell me in one line instead of waiting.',
  },
  {
    id: 'metrics-dashboard',
    icon: ChartLineIcon,
    label: 'Build a metrics dashboard',
    prompt:
      'Build me a live dashboard of the numbers a company like mine watches weekly, as a working web app, and send me the URL. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'kpi-wall',
    icon: TargetIcon,
    label: 'Build a KPI wall',
    prompt:
      'Build me a single page that shows whether the company is on track — the five numbers that matter, each with its target and its trend. Working web app, send me the URL.',
  },
  {
    id: 'sheet-to-app',
    icon: AppWindowIcon,
    label: 'Turn a sheet into an app',
    prompt:
      'I am attaching a spreadsheet my team edits by hand. Turn it into a proper web app with a form and a table so nobody breaks it again, and send me the URL.',
  },
  {
    id: 'crm-lite',
    icon: HandshakeIcon,
    label: 'Build a lightweight CRM',
    prompt:
      'Build me a lightweight CRM as a working web app — companies, contacts, deal stage, next action — seeded with a few realistic rows so I can see it working. Send me the URL.',
  },
  {
    id: 'task-board',
    icon: KanbanIcon,
    label: 'Build a task board',
    prompt:
      'Build me a task board as a working web app — columns, drag between them, and it remembers what I did. Send me the URL.',
  },
  {
    id: 'intake-form',
    icon: FileTextIcon,
    label: 'Build an intake form',
    prompt:
      'Build me an intake form as a working web app — the questions a new client should answer before a first call — with the answers saved where I can read them. Send me the URL.',
  },
  {
    id: 'pricing-calculator',
    icon: CalculatorIcon,
    label: 'Build a pricing calculator',
    prompt:
      'Build me a pricing calculator as a working web app so a prospect can estimate what they would pay, and send me the URL. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'feedback-board',
    icon: MegaphoneIcon,
    label: 'Build a feedback board',
    prompt:
      'Build me a customer feedback board as a working web app — submit an idea, upvote, a status on each — and send me the URL.',
  },
  {
    id: 'inventory-tracker',
    icon: ClipboardIcon,
    label: 'Build an inventory tracker',
    prompt:
      'Build me an inventory tracker as a working web app — items, counts, low-stock warnings — and send me the URL.',
  },
  {
    id: 'status-page',
    icon: BroadcastIcon,
    label: 'Build a status page',
    prompt:
      'Build me a status page as a working web app — components, current state, an incident history — and send me the URL.',
  },
  {
    id: 'clean-data',
    icon: ArrowsClockwiseIcon,
    label: 'Clean up my data',
    prompt:
      'I am attaching a messy spreadsheet. Clean it — consistent columns, fixed dates, trimmed text, no duplicates — and give me a change log of everything you altered.',
  },

  // ── Money ────────────────────────────────────────────────────────────
  // Deliberately no market-data prompts: this project has no market feed, and a
  // row that promises live prices is a promise the first run cannot keep.
  {
    id: 'runway',
    icon: WalletIcon,
    label: 'Work out my runway',
    prompt:
      'I am attaching our numbers. Work out our burn rate and how many months of runway we have, show the working so I can argue with it, and tell me the two levers that move it most.',
  },
  {
    id: 'budget-variance',
    icon: ChartPieSliceIcon,
    label: 'Compare budget to actual',
    prompt:
      'I am attaching our budget and our actuals. Show me where we are over and under, rank the gaps by size, and tell me which ones are worth acting on.',
  },
  {
    id: 'cashflow-forecast',
    icon: CurrencyDollarIcon,
    label: 'Forecast our cash',
    prompt:
      'I am attaching our transactions. Build a cash-flow forecast for the next six months, be explicit about what it assumes, and flag the month we get tight.',
  },
  {
    id: 'unit-economics',
    icon: PercentIcon,
    label: 'Work out unit economics',
    prompt:
      'Work out what one customer actually costs us and what they are worth — acquisition, delivery, support, retention — and tell me which number to fix first. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'pricing-model',
    icon: MoneyIcon,
    label: 'Model a price change',
    prompt:
      'Model what happens if we change our pricing — the packaging, the per-seat maths, and the revenue effect at three adoption levels. Give me the spreadsheet and a one-paragraph recommendation.',
  },
  {
    id: 'invoice-reconcile',
    icon: ReceiptIcon,
    label: 'Reconcile my invoices',
    prompt:
      'I am attaching invoices and a bank export. Match them up, list what is unmatched in both directions, and tell me what looks like a duplicate charge.',
  },
  {
    id: 'expense-categorise',
    icon: CoinsIcon,
    label: 'Categorise our spend',
    prompt:
      'I am attaching our expenses. Categorise them, break the spend down by category and by month, find what is growing fastest, and name the three I should cut first.',
  },
  {
    id: 'subscription-audit',
    icon: BankIcon,
    label: 'Find wasted spend',
    prompt:
      'I am attaching our card statements. Find every recurring charge, flag the ones that look unused or duplicated, and total what cancelling them would save per year.',
  },
  {
    id: 'ar-chase',
    icon: EnvelopeSimpleIcon,
    label: 'Chase unpaid invoices',
    prompt:
      'I am attaching our receivables. Work out who owes what and how late, then draft the chase email for each one — firm, not rude — ordered by how much is at stake.',
  },
  {
    id: 'financial-model',
    icon: TrendUpIcon,
    label: 'Build a financial model',
    prompt:
      'Build me a simple financial model — revenue, costs, cash, runway — driven off an assumptions tab I can change, with a chart of cash over time. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'cohort-revenue',
    icon: ChartLineIcon,
    label: 'Analyse revenue cohorts',
    prompt:
      'I am attaching customer revenue data. Build a cohort analysis, tell me in one paragraph whether retention is improving, and show which cohort changed.',
  },
  {
    id: 'headcount-cost',
    icon: UsersIcon,
    label: 'Plan hiring costs',
    prompt:
      'Build me a hiring plan as a spreadsheet — role, when, fully loaded cost, and what it unlocks — totalled by month against our runway.',
  },
  {
    id: 'margin-analysis',
    icon: ChartPieSliceIcon,
    label: 'Find my best margins',
    prompt:
      'I am attaching sales data. Work out margin by product, customer and channel, and tell me what we should be selling more of and what is quietly losing money.',
  },
  {
    id: 'board-metrics',
    icon: PresentationChartIcon,
    label: 'Build the board metrics pack',
    prompt:
      'Build the numbers pack a board expects — growth, burn, runway, retention, pipeline — as charts with a one-line read on each. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },

  // ── Presentations and documents ──────────────────────────────────────
  {
    id: 'pitch-deck',
    icon: PresentationIcon,
    label: 'Build a deck',
    prompt:
      'Build me a 10-slide deck introducing my company: what we do, who it is for, the problem, how it works, and why now. Write the words and design the slides — do not hand me an outline. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'deck-from-doc',
    icon: PresentationIcon,
    label: 'Turn a doc into a deck',
    prompt:
      'I am attaching a document. Turn it into a deck that stands up in a meeting — one idea per slide, speaker notes underneath — rather than pasting the paragraphs onto slides.',
  },
  {
    id: 'investor-update',
    icon: TrendUpIcon,
    label: 'Build an investor update',
    prompt:
      "Build me this month's investor update — highlights, metrics, lowlights, and what I need help with. Pull the numbers rather than asking me for them. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.",
  },
  {
    id: 'board-deck',
    icon: PresentationChartIcon,
    label: 'Build a board deck',
    prompt:
      'Build me a board deck — where we are against plan, the three decisions I need from the board, and the risks I am not going to hide. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'sales-deck',
    icon: HandshakeIcon,
    label: 'Build a sales deck',
    prompt:
      'Build me a sales deck for a first call — their problem, our answer, proof, and the next step — with speaker notes. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'data-slide',
    icon: ChartBarIcon,
    label: 'Turn numbers into slides',
    prompt:
      'I am attaching data. Build the three slides that tell its story — one chart each, one sentence of takeaway each — ready to present.',
  },
  {
    id: 'pdf-report',
    icon: FilePdfIcon,
    label: 'Make a proper PDF report',
    prompt:
      'Take what we have been working on and lay it out as a real PDF report — cover, contents, page numbers, charts — that I can send to a client without editing it.',
  },
  {
    id: 'proposal',
    icon: FileDocIcon,
    label: 'Write a proposal',
    prompt:
      'Write a client proposal — the problem as they described it, what we would do, the plan, and the price with the number left as a placeholder. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'one-pager',
    icon: FileDocIcon,
    label: 'Write a one-pager',
    prompt:
      'Write a one-pager on my company I can send before a meeting — what we do, who for, why it matters, what to do next. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'contract-explain',
    icon: GavelIcon,
    label: 'Explain a contract',
    prompt:
      'I am attaching a contract. Explain it in plain language — the obligations, the money, the termination terms, the dates — then list the questions I should take to a lawyer. Do not tell me whether to sign.',
  },
  {
    id: 'meeting-actions',
    icon: ClipboardIcon,
    label: 'Turn notes into actions',
    prompt:
      'I am pasting my meeting notes next. Turn them into decisions, owners and dates, and tell me plainly what was left unresolved.',
  },
  {
    id: 'weekly-report',
    icon: ArticleIcon,
    label: 'Write the weekly report',
    prompt:
      "Write this week's company report — what moved, what did not, and what I should worry about — pulling from the repo and memory rather than asking me.",
  },
  {
    id: 'case-study',
    icon: TrophyIcon,
    label: 'Write a case study',
    prompt:
      'Write a customer case study — the situation, what changed, the result — using a codename if I have not given you a real customer. Publish it as a page and send me the URL.',
  },
  {
    id: 'hard-email',
    icon: EnvelopeSimpleIcon,
    label: 'Write the hard email',
    prompt:
      'Help me write the email I have been putting off — a price rise, a delay, or bad news. Ask which one in a single line, then give me three versions from blunt to gentle.',
  },

  // ── Research on the live web ─────────────────────────────────────────
  // The `agent-browser` skill plus the `web_search` / `scrape_webpage` tools in
  // `.kortix/opencode/tools/`.
  {
    id: 'competitor-teardown',
    icon: MagnifyingGlassIcon,
    label: 'Tear down a competitor',
    prompt:
      'Pick our closest competitor and take them apart: positioning, pricing, what they ship, what customers praise and complain about, and the two places we can beat them. Cite every source.',
  },
  {
    id: 'pricing-benchmark',
    icon: ScalesIcon,
    label: 'Benchmark our pricing',
    prompt:
      'Research what comparable products charge, put it in one table with the packaging and the per-seat maths, and tell me where we sit and whether that is deliberate.',
  },
  {
    id: 'lead-list',
    icon: TargetIcon,
    label: 'Build me a lead list',
    prompt:
      'Build a list of 25 companies that fit our customer profile, with why each fits and the best person to reach. Spreadsheet, with sources.',
  },
  {
    id: 'investor-list',
    icon: BankIcon,
    label: 'Build an investor list',
    prompt:
      'Build a list of investors who back companies like mine at our stage — fund, partner, a recent relevant cheque, and the warmest path in. Spreadsheet, with sources.',
  },
  {
    id: 'market-sizing',
    icon: ChartPieSliceIcon,
    label: 'Size my market',
    prompt:
      'Size the market I am selling into, top down and bottom up, and show the working and the sources so I can argue with the numbers.',
  },
  {
    id: 'review-mining',
    icon: BinocularsIcon,
    label: 'Mine competitor reviews',
    prompt:
      'Read the public reviews of our competitors, pull out what people repeatedly praise and complain about, and turn it into the three things we should say on our site.',
  },
  {
    id: 'industry-catchup',
    icon: NewspaperIcon,
    label: 'Catch me up on my industry',
    prompt:
      'Catch me up on my industry over the last month — what shipped, who raised, what changed — then tell me which two items actually matter to us and why.',
  },
  {
    id: 'keyword-research',
    icon: MagnifyingGlassIcon,
    label: 'Find what buyers search',
    prompt:
      'Research what our buyers actually search for, group it by intent, and tell me the five pages worth writing first. Spreadsheet, with sources.',
  },
  {
    id: 'buyer-research',
    icon: UsersIcon,
    label: 'Research my buyers',
    prompt:
      'Research the people who buy products like mine — where they gather, what they complain about, and the words they use for the problem. Cite sources.',
  },
  {
    id: 'regulation-scan',
    icon: GavelIcon,
    label: 'Scan the rules that apply',
    prompt:
      'Research the rules and standards that apply to a company like mine, summarise what each asks for in plain language, and flag what I should take to a lawyer rather than act on.',
  },
  {
    id: 'events-list',
    icon: CalendarIcon,
    label: 'Find events worth attending',
    prompt:
      'Find the conferences and meetups where our buyers actually are this year — date, place, cost, and whether it is worth it. Spreadsheet.',
  },

  // ── Web presence ─────────────────────────────────────────────────────
  {
    id: 'landing-page',
    icon: GlobeIcon,
    label: 'Ship a landing page',
    prompt:
      'Build a landing page for my product and publish it. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me. Send me the live URL when it is up.',
  },
  {
    id: 'pricing-page',
    icon: MoneyIcon,
    label: 'Ship a pricing page',
    prompt:
      'Write and publish a pricing page — the tiers, what is in each, and the objections the page has to answer. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'docs-site',
    icon: BooksIcon,
    label: 'Publish a docs site',
    prompt:
      'Build and publish a small docs site for my product — getting started, the core concepts, and one how-to. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'changelog-page',
    icon: NewspaperIcon,
    label: 'Publish a changelog',
    prompt:
      'Build and publish a changelog page, and write the recent entries from the history in this repo rather than asking me what shipped.',
  },
  {
    id: 'comparison-page',
    icon: ScalesIcon,
    label: 'Ship a comparison page',
    prompt:
      'Build and publish an honest comparison between us and our closest alternative — where each one wins. Research the other side rather than inventing it.',
  },
  {
    id: 'seo-pass',
    icon: MagnifyingGlassIcon,
    label: 'Do an SEO pass',
    prompt:
      'Audit my site for SEO — titles, descriptions, headings, alt text, internal links, sitemap — fix what you can, and list what needs a decision from me.',
  },
  {
    id: 'homepage-rewrite',
    icon: BrowserIcon,
    label: 'Rewrite my homepage',
    prompt:
      'Rewrite my homepage so the first screen says what we do, who it is for, and what to do next. Publish it and show me the before and after side by side.',
  },
  {
    id: 'waitlist-page',
    icon: RocketIcon,
    label: 'Put up a waitlist page',
    prompt:
      'Build and publish a waitlist page for something I am about to launch — a headline, the promise, one email capture. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'blog-post',
    icon: ArticleIcon,
    label: 'Write and publish a post',
    prompt:
      'Write a post about something my company actually knows, publish it to our site, and send me the URL. Pick the topic that would be most useful to our buyers and say why.',
  },
  {
    id: 'faq-page',
    icon: LightbulbIcon,
    label: 'Write an FAQ page',
    prompt:
      'Write and publish an FAQ answering the ten questions a first-time buyer actually asks. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'careers-page',
    icon: UsersIcon,
    label: 'Put up a careers page',
    prompt:
      'Build and publish a careers page — how we work, what we are hiring for, how to apply. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'storefront-copy',
    icon: StorefrontIcon,
    label: 'Write our listing copy',
    prompt:
      'Write our listing copy for a marketplace or app store — the title, the short pitch, the long description, and the screenshots I should take.',
  },

  // ── Growth and positioning ───────────────────────────────────────────
  {
    id: 'cold-email',
    icon: EnvelopeSimpleIcon,
    label: 'Write a cold email sequence',
    prompt:
      'Write a four-email cold sequence to our ideal customer — short, specific, no flattery — and say what each one is meant to do.',
  },
  {
    id: 'launch-announcement',
    icon: RocketIcon,
    label: 'Write a launch announcement',
    prompt:
      'Write the launch announcement for our next release in three lengths — a post, an email, and one line — all saying the same thing.',
  },
  {
    id: 'newsletter',
    icon: NewspaperIcon,
    label: 'Draft the newsletter',
    prompt:
      "Draft this month's customer newsletter — what shipped, what we learned, and one useful thing they can act on.",
  },
  {
    id: 'social-calendar',
    icon: CalendarIcon,
    label: 'Plan a content calendar',
    prompt:
      'Plan a month of content — theme, piece, channel, date — as a spreadsheet I can hand to someone.',
  },
  {
    id: 'linkedin-posts',
    icon: MegaphoneIcon,
    label: 'Write a week of posts',
    prompt:
      'Write a week of posts about what we are building — one idea each, written like a person, no engagement bait.',
  },
  {
    id: 'positioning',
    icon: CompassIcon,
    label: 'Sharpen our positioning',
    prompt:
      'Write our positioning: the category, who it is for, the alternative, and the one thing we do better. Give me three options, recommend one, and say why.',
  },
  {
    id: 'icp-definition',
    icon: TargetIcon,
    label: 'Define our ideal customer',
    prompt:
      'Write down who we are actually for — the company, the person, the trigger that makes them look — and who we should say no to.',
  },
  {
    id: 'objection-handling',
    icon: ShieldCheckIcon,
    label: 'Answer our objections',
    prompt:
      'List the objections we get in sales and write the honest answer to each — not a deflection.',
  },
  {
    id: 'win-loss',
    icon: ScalesIcon,
    label: 'Analyse wins and losses',
    prompt:
      'I am attaching our recent deals. Find the patterns in what we win and lose, and tell me the one change that would move the rate most.',
  },
  {
    id: 'interview-guide',
    icon: MagnifyingGlassIcon,
    label: 'Write customer questions',
    prompt:
      'Write the questions for a customer interview that would actually teach us something — open, not leading — plus what I am listening for in each answer.',
  },
  {
    id: 'referral-program',
    icon: TrophyIcon,
    label: 'Design a referral program',
    prompt:
      'Design a referral program for my product — the incentive, the mechanics, the wording — and tell me how it could be abused.',
  },
  {
    id: 'brand-voice',
    icon: MegaphoneIcon,
    label: 'Write our voice guide',
    prompt:
      'Write our brand voice guide — how we sound, how we do not — with before-and-after rewrites of real copy from our site.',
  },
  // ── Engineering, on the repo this session cloned ─────────────────────
  // The biggest gap in the first pass, and the least defensible one:
  // developers are Kortix's primary audience (comms skill, §9) and the sandbox
  // is a real Linux machine with the repo already checked out. Every row here
  // is work the agent does in `/workspace`, landing through a change request.
  {
    id: 'code-review',
    icon: CodeIcon,
    label: 'Review my code',
    prompt:
      'Review the code in this repo the way a senior engineer would — correctness first, then clarity. Give me a prioritised list, worst first, and open a change request for the fixes you are confident about.',
  },
  {
    id: 'write-tests',
    icon: FlaskIcon,
    label: 'Write the missing tests',
    prompt:
      'Find the code in this repo that would hurt most if it broke and has no test, write the tests, and open a change request. Tell me what you deliberately did not cover and why.',
  },
  {
    id: 'fix-bug',
    icon: BugIcon,
    label: 'Fix a bug I describe',
    prompt:
      'I am going to describe a bug. Reproduce it in this repo first, then fix the cause rather than the symptom, add a test that would have caught it, and open a change request.',
  },
  {
    id: 'explain-codebase',
    icon: SignpostIcon,
    label: 'Explain this codebase',
    prompt:
      'Walk me through this codebase — what it does, how it is laid out, where the important logic lives, and the three things that would confuse a new engineer.',
  },
  {
    id: 'refactor-file',
    icon: WrenchIcon,
    label: 'Clean up a messy file',
    prompt:
      'Find the file in this repo that is doing too much, split it along its real seams without changing behaviour, and open a change request. Prove behaviour is unchanged with the tests.',
  },
  {
    id: 'deps-upgrade',
    icon: PackageIcon,
    label: 'Upgrade my dependencies',
    prompt:
      "Check this repo's dependencies for outdated and vulnerable versions, upgrade what is safe, run the tests, and open a change request listing anything that needs a human decision.",
  },
  {
    id: 'readme',
    icon: NotepadIcon,
    label: 'Write the README',
    prompt:
      'Write the README this repo should have — what it is, how to run it, how to work on it — from the code rather than from guesses. Open a change request.',
  },
  {
    id: 'ci-setup',
    icon: RepeatIcon,
    label: 'Set up CI',
    prompt:
      'Set up continuous integration for this repo — install, typecheck, lint, test — so a change request tells me whether it is safe before I read it. Open it as a change request.',
  },
  {
    id: 'api-client',
    icon: CircuitryIcon,
    label: 'Write an API client',
    prompt:
      'Write a typed client for an API I need to call, with the error handling and retries already in it, plus a test against a recorded response. Ask which API in one line.',
  },
  {
    id: 'security-review',
    icon: WarningIcon,
    label: 'Review my code for risks',
    prompt:
      'Review this repo for the security mistakes that actually happen — secrets in source, unvalidated input, missing authorisation checks — and open a change request for what you can fix safely.',
  },
  {
    id: 'perf-audit',
    icon: GaugeIcon,
    label: 'Find what is slow',
    prompt:
      'Find the slowest paths in this project, measure rather than guess, and tell me the one change that would help most. Show me the numbers before and after.',
  },
  {
    id: 'error-handling',
    icon: LifebuoyIcon,
    label: 'Add proper error handling',
    prompt:
      'Find where this code fails silently or throws something a person cannot act on, fix it so every failure says what happened and what to do, and open a change request.',
  },
  {
    id: 'db-migration',
    icon: DatabaseIcon,
    label: 'Write a database migration',
    prompt:
      "Write the migration I need against this project's schema, with the rollback, and tell me what would happen to existing rows. Open a change request rather than running it.",
  },
  {
    id: 'api-docs',
    icon: BooksIcon,
    label: 'Document my API',
    prompt:
      "Document this project's API from the code — every route, its inputs, its responses, its errors — and publish it as a page I can send to someone.",
  },
  {
    id: 'dead-code',
    icon: TreeIcon,
    label: 'Find dead code',
    prompt:
      'Find the code in this repo nothing reaches any more, prove it with the import graph rather than by eye, and open a change request that deletes it.',
  },
  {
    id: 'branch-explain',
    icon: GitBranchIcon,
    label: 'Explain what changed',
    prompt:
      'Read the recent history of this repo and tell me what actually changed and why, in the order that makes sense to a person who was away.',
  },

  // ── Automation and integrations ──────────────────────────────────────
  // Distinct from "build the workforce" above: that group configures WHO does
  // the work, this one is the plumbing the work runs on.
  {
    id: 'api-to-sheet',
    icon: SwapIcon,
    label: 'Pull an API into a sheet',
    prompt:
      'Pull the data I need out of an API and keep it in a spreadsheet I can actually read. Ask which API in one line, then build it and show me the first pull.',
  },
  {
    id: 'recurring-export',
    icon: DownloadIcon,
    label: 'Set up a recurring export',
    prompt:
      "Set up an export that runs on a schedule and drops the data where I need it, as a trigger in `kortix.yaml`. Show me one run's output before you leave it enabled.",
  },
  {
    id: 'page-monitor',
    icon: EyeIcon,
    label: 'Watch a page for changes',
    prompt:
      "Watch a page that matters to me and tell me only when something meaningful changes — not every whitespace edit. Set it up as a scheduled trigger and show me today's diff.",
  },
  {
    id: 'scraper',
    icon: TerminalIcon,
    label: 'Build me a scraper',
    prompt:
      'Build a scraper for a site I name, put the results somewhere I can query, and be explicit about what it will do when the page structure changes.',
  },
  {
    id: 'reconcile-systems',
    icon: SwapIcon,
    label: 'Reconcile two systems',
    prompt:
      'I am attaching exports from two systems that should agree. Find every row where they do not, tell me which side looks wrong, and give me the list to fix.',
  },
  {
    id: 'alert-threshold',
    icon: AlarmIcon,
    label: 'Alert me when a number moves',
    prompt:
      'Set up a check that watches a number I care about and tells me when it crosses a line I set — not a daily report I will stop reading. Add it as a trigger.',
  },
  {
    id: 'form-to-sheet',
    icon: FilesIcon,
    label: 'Pipe form replies into a sheet',
    prompt:
      'Take the replies from a form we already use and get them into a spreadsheet automatically, deduplicated and typed properly.',
  },
  {
    id: 'digest-sources',
    icon: NewspaperIcon,
    label: 'Digest my sources daily',
    prompt:
      'Pick the handful of sources I actually need to follow, and set up a daily trigger that reads them and sends me only what changed and why it matters.',
  },

  // ── Hiring and people ────────────────────────────────────────────────
  {
    id: 'job-description',
    icon: SuitcaseIcon,
    label: 'Write a job description',
    prompt:
      'Write the job description for the role I most need to fill — what they will actually do in the first 90 days, not a wishlist of skills. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'cv-screen',
    icon: IdentificationCardIcon,
    label: 'Screen CVs for me',
    prompt:
      'I am attaching CVs and the role. Score each against what the job actually needs, rank them, and tell me plainly which two I should talk to and why.',
  },
  {
    id: 'interview-plan',
    icon: ChatsIcon,
    label: 'Plan an interview loop',
    prompt:
      'Design the interview loop for a role — who asks what, in what order, and what each stage is trying to find out. Include the questions.',
  },
  {
    id: 'role-scorecard',
    icon: TargetIcon,
    label: 'Write a role scorecard',
    prompt:
      'Write a scorecard for a role — the outcomes it owns, how we would know it is going well, and what failure looks like at 90 days. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'onboarding-plan',
    icon: PathIcon,
    label: 'Write a 30-60-90 plan',
    prompt:
      'Write a 30-60-90 day plan for someone joining my company — what they read, who they meet, and what they own by the end of each stage. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'team-handbook',
    icon: BooksIcon,
    label: 'Write our team handbook',
    prompt:
      'Write the handbook a new person reads in week one — how we work, where things live, who to ask, what good looks like — from what is already in this repo and memory.',
  },
  {
    id: 'reference-questions',
    icon: ChatsIcon,
    label: 'Write reference questions',
    prompt:
      'Write the reference-check questions that would actually tell me something — specific, hard to answer with a platitude — plus what a bad answer sounds like.',
  },
  {
    id: 'comp-bands',
    icon: CoinsIcon,
    label: 'Draft compensation bands',
    prompt:
      'Research what people in our roles are paid in our market and draft honest salary bands with the reasoning. Cite your sources.',
  },
  {
    id: 'review-template',
    icon: NotepadIcon,
    label: 'Write a review template',
    prompt:
      'Write the performance review template for my company — short, specific, about outcomes rather than personality — plus how to run the conversation.',
  },
  {
    id: 'offer-letter',
    icon: FileDocIcon,
    label: 'Draft an offer letter',
    prompt:
      'Draft an offer letter for a role, leaving the numbers as placeholders, and flag which clauses a lawyer should look at rather than deciding them yourself.',
  },

  // ── Support and customers ────────────────────────────────────────────
  {
    id: 'help-centre',
    icon: LifebuoyIcon,
    label: 'Build a help centre',
    prompt:
      'Build and publish a help centre for my product — the articles people actually need, written from what is in this repo — and send me the URL.',
  },
  {
    id: 'canned-replies',
    icon: ChatsIcon,
    label: 'Write our canned replies',
    prompt:
      'Write the saved replies for the questions we answer over and over — helpful, human, and short enough that someone will actually use them.',
  },
  {
    id: 'support-triage',
    icon: TicketIcon,
    label: 'Triage my support backlog',
    prompt:
      'I am attaching our open tickets. Sort them into what needs me, what needs a reply, and what can be closed, and draft the replies for the second group.',
  },
  {
    id: 'incident-note',
    icon: WarningIcon,
    label: 'Write a customer incident note',
    prompt:
      'Something broke and I need to tell customers. Write the note — what happened, who it affected, what we are doing — honest, no hedging, no blame-shifting.',
  },
  {
    id: 'faq-from-tickets',
    icon: LightbulbIcon,
    label: 'Turn tickets into an FAQ',
    prompt:
      'I am attaching our support tickets. Find the questions that keep coming back, write the answers once, and publish them as an FAQ page.',
  },
  {
    id: 'churn-analysis',
    icon: FunnelIcon,
    label: 'Work out why people leave',
    prompt:
      'I am attaching our churn data and any cancellation reasons. Find the real patterns, separate them from the noise, and tell me the one thing worth fixing first.',
  },
  {
    id: 'nps-analysis',
    icon: HighlighterIcon,
    label: 'Read our customer feedback',
    prompt:
      'I am attaching customer feedback. Group it by theme, tell me what people love and what they keep asking for, and quote the lines worth putting on the wall.',
  },
  {
    id: 'onboarding-emails',
    icon: EnvelopeSimpleIcon,
    label: 'Write onboarding emails',
    prompt:
      'Write the emails a new customer gets in their first two weeks — each one earning its place by teaching something, not by checking in. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'refund-policy',
    icon: ScalesIcon,
    label: 'Draft a refund policy',
    prompt:
      'Draft a refund policy that is fair and unambiguous, publish it, and flag anything a lawyer should review before it goes live.',
  },

  // ── Running the company ──────────────────────────────────────────────
  {
    id: 'vendor-list',
    icon: ReceiptIcon,
    label: 'List our vendors and renewals',
    prompt:
      'Work out every tool and vendor we pay for, what each costs, and when it renews. Put it in a spreadsheet and flag the renewals in the next 60 days.',
  },
  {
    id: 'meeting-agenda',
    icon: NotepadIcon,
    label: 'Write the meeting agenda',
    prompt:
      'Write the agenda for a meeting I have coming up — the decisions to make, the material to read first, and a time budget per item.',
  },
  {
    id: 'ops-review',
    icon: ClipboardIcon,
    label: 'Run my weekly review',
    prompt:
      'Run my weekly review: pull what changed in this repo and in memory, tell me what moved, what slipped, and the three things worth my attention on Monday.',
  },
  {
    id: 'process-map',
    icon: PathIcon,
    label: 'Map how our work flows',
    prompt:
      'Map how work actually flows through my company from request to delivered, name where it gets stuck, and propose the one change that would help most. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'okr-draft',
    icon: TargetIcon,
    label: 'Draft this quarter goals',
    prompt:
      "Draft this quarter's goals — three objectives, measurable results under each, and what we are explicitly not doing. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.",
  },
  {
    id: 'decision-log',
    icon: NotepadIcon,
    label: 'Start a decision log',
    prompt:
      "Read this repo's history and memory, reconstruct the decisions that were actually made and why, and write them into a decision log I can keep adding to.",
  },
  {
    id: 'risk-register',
    icon: WarningIcon,
    label: 'Build a risk register',
    prompt:
      'List what could realistically go wrong for a company like mine, rank by likelihood and damage, and name the cheapest thing that reduces each. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'asset-inventory',
    icon: ShieldCheckIcon,
    label: 'Inventory our accounts',
    prompt:
      'Work out every account, domain and service this company depends on, who controls each, and what breaks if we lose access. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'sop-library',
    icon: BooksIcon,
    label: 'Build our SOP library',
    prompt:
      'Turn the things my company does repeatedly into written procedures, organised so someone can find the right one in ten seconds. Start with the three highest-value ones.',
  },
  {
    id: 'calendar-audit',
    icon: ClockIcon,
    label: 'Audit where my time goes',
    prompt:
      'I am attaching my calendar export. Tell me where my time actually goes, which meetings have no clear output, and what I should cut or shorten.',
  },

  // ── Analytics and experiments ────────────────────────────────────────
  {
    id: 'north-star',
    icon: TargetIcon,
    label: 'Define our north-star metric',
    prompt:
      'Work out the one number that best tells us whether this company is working, argue for it against the two runners-up, and say how we would measure it. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'tracking-plan',
    icon: SlidersHorizontalIcon,
    label: 'Write an event tracking plan',
    prompt:
      'Write the event tracking plan for my product — the events worth capturing, their properties, and the questions each one answers. Skip the ones nobody will query.',
  },
  {
    id: 'ab-test-design',
    icon: FlaskIcon,
    label: 'Design an A/B test',
    prompt:
      'Design an experiment for a change I am considering — the hypothesis, the metric, the sample size, and how long it has to run to mean anything.',
  },
  {
    id: 'experiment-analysis',
    icon: ChartLineIcon,
    label: 'Analyse an experiment',
    prompt:
      'I am attaching experiment results. Tell me whether the difference is real, what it would be worth if we shipped it, and be honest if the answer is inconclusive.',
  },
  {
    id: 'funnel-analysis',
    icon: FunnelIcon,
    label: 'Find where the funnel leaks',
    prompt:
      'I am attaching funnel data. Find the step where we lose the most people, quantify what fixing it is worth, and suggest what to try.',
  },
  {
    id: 'retention-curve',
    icon: ChartLineIcon,
    label: 'Chart our retention',
    prompt:
      'I am attaching usage data. Chart retention over time, tell me whether the curve flattens, and what that says about whether we have found product-market fit.',
  },
  {
    id: 'segment-analysis',
    icon: ChartPieSliceIcon,
    label: 'Find our best customers',
    prompt:
      'I am attaching customer data. Work out which segment retains and pays best, and tell me what they have in common that we could target deliberately.',
  },
  {
    id: 'dashboard-spec',
    icon: ChartDonutIcon,
    label: 'Decide what to measure',
    prompt:
      'Tell me which numbers this company should actually watch weekly and which are vanity, then build the dashboard for the survivors.',
  },

  // ── Design ───────────────────────────────────────────────────────────
  // The `design-foundations` skill.
  {
    id: 'brand-palette',
    icon: PaletteIcon,
    label: 'Pick a brand palette',
    prompt:
      'Put together a brand palette and type scale for my company — the colours, where each is used, and the contrast ratios — as a one-page reference I can hand to anyone.',
  },
  {
    id: 'design-review',
    icon: PaintBrushIcon,
    label: 'Review my design',
    prompt:
      'Look at my site or product and review the design — hierarchy, spacing, type, colour, contrast. Give me a prioritised list, worst first, with what to change.',
  },
  {
    id: 'logo-brief',
    icon: PaintBrushIcon,
    label: 'Write a logo brief',
    prompt:
      'Write the brief I would hand a designer for our logo — what the company is, the feeling, what to avoid, and three directions worth exploring. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'slide-template',
    icon: PresentationIcon,
    label: 'Design a slide template',
    prompt:
      'Design a reusable slide template for my company — title, section, content, metric and quote layouts — and save it so future decks start from it.',
  },
  {
    id: 'social-templates',
    icon: MegaphoneIcon,
    label: 'Design social templates',
    prompt:
      'Design the image templates we reuse for social posts, in our own colours and type, and save them so they are one edit away from ready.',
  },
  {
    id: 'email-template',
    icon: EnvelopeSimpleIcon,
    label: 'Design an email template',
    prompt:
      'Design the HTML email template we send from — readable on a phone, degrades gracefully, no images required to make sense — and save it in the repo.',
  },
  {
    id: 'ui-audit',
    icon: HighlighterIcon,
    label: 'Audit our UI consistency',
    prompt:
      'Go through our product and find where the same thing looks different in two places — buttons, spacing, wording, states — and list the fixes worst first.',
  },
  {
    id: 'icon-set',
    icon: SparkleIcon,
    label: 'Pick an icon set',
    prompt:
      'Pick an icon set that fits our brand, explain why it fits, and show it applied to the ten places we most use icons.',
  },

  // ── Legal and policy documents ───────────────────────────────────────
  // Every one of these produces a draft and names what a lawyer must see. None
  // of them gives advice — see `contract-explain` for the same boundary.
  {
    id: 'privacy-policy',
    icon: ShieldCheckIcon,
    label: 'Draft a privacy policy',
    prompt:
      'Draft a privacy policy that describes what we actually do with data rather than boilerplate, and list every claim a lawyer needs to confirm before it goes live.',
  },
  {
    id: 'terms-of-service',
    icon: GavelIcon,
    label: 'Draft terms of service',
    prompt:
      'Draft terms of service for my product in plain language, and flag every clause that needs a lawyer rather than deciding it yourself.',
  },
  {
    id: 'security-questionnaire',
    icon: ShieldCheckIcon,
    label: 'Answer a security questionnaire',
    prompt:
      'I am attaching a security questionnaire from a customer. Draft honest answers from what is actually true of this project, and mark clearly every one I have to verify myself.',
  },
  {
    id: 'dpa-checklist',
    icon: ScalesIcon,
    label: 'Check our data agreements',
    prompt:
      'List the data-processing agreements a company like mine typically needs, what each one covers, and which ones we appear to be missing. Flag what to take to a lawyer.',
  },
  {
    id: 'sow-draft',
    icon: FileTextIcon,
    label: 'Draft a scope of work',
    prompt:
      'Draft a scope of work — deliverables, milestones, what is out of scope, and what I need from the client. Flag anything a lawyer should look at. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
  {
    id: 'nda-explain',
    icon: GavelIcon,
    label: 'Explain an NDA',
    prompt:
      'I am attaching an NDA. Tell me in plain language what I would be agreeing to, what is unusual about it, and the questions to ask before signing. Do not tell me whether to sign.',
  },

  // ── My own week ──────────────────────────────────────────────────────
  // Personal rather than company-wide. Short, high-frequency, and the reason
  // someone opens Kortix on a Monday morning rather than on a launch day.
  {
    id: 'plan-week',
    icon: CalendarIcon,
    label: 'Plan my week',
    prompt:
      'Look at what is actually going on in this project and plan my week — what matters, what can wait, and what I should say no to. Be opinionated.',
  },
  {
    id: 'meeting-prep',
    icon: BinocularsIcon,
    label: 'Prep me for a meeting',
    prompt:
      'I have a meeting coming up. Research who I am meeting, pull what we already know about them from memory, and give me a one-page brief with the three questions to ask.',
  },
  {
    id: 'catch-up',
    icon: ArrowsClockwiseIcon,
    label: 'Tell me what I missed',
    prompt:
      'I have been away. Tell me what happened in this project while I was gone, what needs a decision from me, and what is on fire — in that order.',
  },
  {
    id: 'draft-replies',
    icon: EnvelopeSimpleIcon,
    label: 'Draft my replies',
    prompt:
      'I am attaching messages I owe replies to. Draft each one in my voice, shortest acceptable version first, and flag the two I should handle personally.',
  },
  {
    id: 'summarise-thread',
    icon: ChatsIcon,
    label: 'Summarise a long thread',
    prompt:
      'I am attaching a long thread. Tell me what was actually agreed, what is still open, and what I owe someone — and skip the small talk.',
  },
  {
    id: 'daily-standup',
    icon: ClipboardIcon,
    label: 'Write my standup',
    prompt:
      'Read what actually changed in this project since yesterday and write my standup from the evidence — done, doing, blocked — rather than asking me.',
  },
  {
    id: 'follow-ups',
    icon: AlarmIcon,
    label: 'Chase my follow-ups',
    prompt:
      'Go through recent sessions and memory, find everything I said I would do and have not, and give me the list in the order I should clear it.',
  },
  {
    id: 'reading-digest',
    icon: BooksIcon,
    label: 'Digest what I saved',
    prompt:
      'I am attaching links and documents I saved and never read. Read them for me, tell me which two were worth it, and summarise those properly.',
  },

  // ── Explaining and teaching ──────────────────────────────────────────
  {
    id: 'explain-concept',
    icon: GraduationCapIcon,
    label: 'Explain this to my team',
    prompt:
      'Explain something technical to my team in language they will actually follow — no jargon, one worked example, and the two things people usually get wrong. Ask me the topic in one line.',
  },
  {
    id: 'training-course',
    icon: BooksIcon,
    label: 'Build a training course',
    prompt:
      'Build a short course that teaches someone to do one job at my company end to end — the lessons, the exercises, and how they know they have got it. Pick the job that would help most.',
  },
  {
    id: 'glossary',
    icon: NotepadIcon,
    label: 'Write our glossary',
    prompt:
      'Write the glossary of terms my company uses — including the ones we use differently from everyone else — from what is already in this repo and memory.',
  },
  {
    id: 'how-to-guide',
    icon: SignpostIcon,
    label: 'Write a how-to guide',
    prompt:
      'Write the how-to guide for the thing people keep asking me to explain, with screenshots or commands where they help. Publish it and send me the URL.',
  },
  {
    id: 'runbook',
    icon: ClipboardIcon,
    label: 'Write a runbook',
    prompt:
      'Write a runbook for a job my company does over and over, step by step, so someone else could run it without asking me. Pick the highest-value one and say why.',
  },
  {
    id: 'onboarding-doc',
    icon: PathIcon,
    label: 'Write the onboarding doc',
    prompt:
      'Write the document a new hire reads in their first week — how we work, where things live, who to ask, what good looks like. Take what you can from project memory, and list anything you had to guess at the end rather than stopping to ask me.',
  },
];

/** The whole rotating pool, workforce first. */
export const ROTATING_STARTER_PROMPTS: StarterPrompt[] = [
  ...WORKFORCE_STARTER_PROMPTS,
  ...GENERAL_STARTER_PROMPTS,
];

/** The two halves the reserved-slot pick draws from, as ids. */
export const WORKFORCE_STARTER_PROMPT_IDS: readonly string[] = WORKFORCE_STARTER_PROMPTS.map(
  (prompt) => prompt.id,
);
export const GENERAL_STARTER_PROMPT_IDS: readonly string[] = GENERAL_STARTER_PROMPTS.map(
  (prompt) => prompt.id,
);

/** The rotation persists ids, so this is the set it validates against. */
export const ROTATING_STARTER_PROMPT_IDS: readonly string[] = ROTATING_STARTER_PROMPTS.map(
  (prompt) => prompt.id,
);

/** Every prompt, pinned first. The pinned one is not rotatable. */
export const STARTER_PROMPTS: readonly StarterPrompt[] = [
  PINNED_STARTER_PROMPT,
  ...ROTATING_STARTER_PROMPTS,
];

/** Id -> prompt, for turning a stored rotation back into rows. */
export const STARTER_PROMPTS_BY_ID: ReadonlyMap<string, StarterPrompt> = new Map(
  STARTER_PROMPTS.map((prompt) => [prompt.id, prompt]),
);
