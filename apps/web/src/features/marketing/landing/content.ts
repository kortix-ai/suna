/**
 * Landing page copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill. Category = "AI Management System". Never name
 * a licence. Never claim a certification we do not hold.
 */

/**
 * Hero variants. The product pitch — what Kortix IS — not a use-case pitch.
 * Anchored on the README's opening: "The open-source AI Management System".
 *
 * Append `?hero=1` (or 2, 3, 4) to the URL to preview an alternative; the
 * selector is dev-only and renders nothing in production.
 */
export const hero = {
  title: 'The open-source AI Management System',
  sub: 'Your agents, their skills, your company memory and every integration in one platform. Any model, your keys, self-hosted or managed cloud.',
  ctaPrimary: 'Get started',
  ctaSecondary: 'Request demo',
  trust: 'Open source · Any model, your keys · Self-host, VPC, or on-prem',
} as const;

/** The eyebrow renders as a row with the two competitor marks, so its parts
 *  live separately. "leading" is the one superlative we use, and it rests on
 *  20,000+ GitHub stars — cite that number if the claim is ever challenged.
 *  Never add "better"; extensibility belongs in the sub, as a fact. */
export const heroEyebrow = {
  lead: 'The leading open-source alternative to',
  rivals: [
    { id: 'cowork', icon: 'Claude', label: 'Claude Cowork' },
    { id: 'chatgpt-work', icon: 'OpenAI', label: 'ChatGPT Work' },
  ],
} as const;



/** Closing CTA. Same block the page has always ended with. */
export const cta = {
  badge: 'Get started',
  title: 'Run your whole company from one repo you own.',
  // ACCURACY: the price is the one in `features/billing/pricing-plans.ts` —
  // Team is $40 / seat / mo. This line said $20 and was wrong by 2x.
  sub: 'Start with one job, connect the tools it needs, and let your team reach it from Slack, the web, or the CLI. Self-host for free, or managed cloud at $40 / seat / mo + usage.',
  trust: 'Open source · SSO, RBAC & on-prem · Any model, your keys · No lock-in',
  ctaPrimary: 'Get started',
  ctaSecondary: 'Request demo',
} as const;

/**
 * Trust / security block.
 *
 * ACCURACY GATE: SOC 2 Type I and Type II are NOT held — both badges render
 * de-emphasised and carry an explicit "In progress" state. GDPR is a compliance
 * posture the company does hold, so it carries no state and renders bare.
 * Never write "compliant", "certified", or "we are SOC 2" here — the `comms`
 * skill forbids claiming a certification we do not hold. Adding a badge without
 * holding it, or clearing a SOC 2 `state` before the report lands, is a copy bug.
 */
export const trust = {
  eyebrow: 'Security & trust',
  /**
   * ACCURACY: do NOT restore "the model never sees them". A granted runtime
   * secret is a real env value inside the session and is readable by any
   * command the agent runs — see docs/ENV_SECRET_EXPOSURE_BASELINE.md. The
   * true, narrower claim is the one below: CONNECTOR credentials are brokered
   * server-side and never enter the machine.
   * Do NOT restore "scoped per person and group" either — retired by migration
   * 20260706_secrets_v2_identifier_model.sql.
   */
  titleLines: [
    'Giving agents real access',
    'is the easy part. Trusting',
    'them with it is the work.',
  ],
  sub: 'Every session runs on its own isolated machine, with credentials it never sees, and lands nothing without a person approving it.',
  ctaLabel: 'How Kortix is secured',
  ctaHref: '/enterprise',
  /** Exactly three. No HIPAA, no ISO — we do not hold them. */
  badges: [
    { id: 'soc2-type-1', line1: 'SOC 2', line2: 'TYPE I', state: 'In progress' },
    { id: 'soc2-type-2', line1: 'SOC 2', line2: 'TYPE II', state: 'In progress' },
    { id: 'gdpr', line1: 'GDPR', line2: '', state: '' },
  ],
  columns: [
    {
      id: 'approve',
      title: 'Merging is a separate power',
      body: 'Agents open change requests. Merge is default-deny for an agent and granted explicitly in kortix.yaml — so an agent cannot widen its own reach without a change someone else approves.',
    },
    {
      id: 'keys',
      title: 'Connector keys never enter the machine',
      body: 'Third-party credentials stay server-side and are brokered through one scoped token, so the raw key never reaches the sandbox. Delivery is gated by role and by the agent grant.',
    },
    {
      id: 'deploy',
      title: 'Yours, down to the metal',
      // ACCURACY: never restore "air-gapped". `kortix self-host start` pulls
      // images from docker.io and reaches a sandbox provider over egress, so a
      // fully disconnected install is not a shipped capability.
      body: 'Kortix Cloud, your own VPC, or your own on-prem network. It is open source, so you can read every line of what you are trusting.',
    },
  ],
} as const;

/**
 * Semantic tone inside an artifact. It encodes something true about the work
 * product — a score band, a delta's direction, how late an invoice is — and is
 * the only place colour is allowed in this section. The card frame, borders,
 * type and spacing stay on the achromatic tokens.
 */
export type ArtifactTone = 'up' | 'down' | 'warn' | 'info';

export type SheetRow = {
  cells: readonly string[];
  /** Colours the cell at `toneColumn`. Omit for a plain row. */
  tone?: ArtifactTone;
  /** Renders as a totals row: heavier weight, top rule. */
  total?: boolean;
};

/**
 * The work product a card shows. It is rendered as markup, never as an image of
 * a screen — a card must never imply a Kortix UI that does not exist. What is
 * mocked is the ARTIFACT (a sheet, a diff, an outreach draft), which is a sample
 * of the agent's output, not a picture of the product. Each `kind` is formatted
 * like the file type it claims to be, not as prose in a box.
 */
export type UseCaseArtifact = {
  /** File name the work lands as. Rendered mono in the frame's title bar. */
  file: string;
  /** One line under the body: what the artifact adds up to. */
  footer: string;
} & (
  | {
      kind: 'sheet';
      columns: readonly string[];
      /** CSS percentages, one per column. Sized so no cell clips. */
      widths: readonly string[];
      /** Per-column alignment. Text reads left, figures read right. */
      aligns: readonly ('left' | 'right')[];
      rows: readonly SheetRow[];
      /** Index of the column a row's `tone` colours. Defaults to the last. */
      toneColumn?: number;
    }
  | {
      kind: 'diff';
      /** A leading `+` or `-` renders the line as an added / removed row. */
      lines: readonly string[];
      stat: string;
    }
  | {
      kind: 'thread';
      to: string;
      time: string;
      subject: string;
      lines: readonly string[];
      /** The hold state. Nothing sends until a person approves it. */
      status: string;
    }
  | {
      kind: 'checks';
      items: readonly { label: string; value: string; tone: ArtifactTone }[];
    }
  | {
      kind: 'chart';
      caption: string;
      /** `pct` is the bar length as a percentage of the track. */
      bars: readonly { label: string; value: string; pct: number; tone: ArtifactTone }[];
    }
);

export type UseCase = {
  id: string;
  /** The `/solutions/<role>` page this card belongs to. Keep spelling in step. */
  role: string;
  /**
   * Where the card navigates: `/solutions/<slug>`, taken verbatim from
   * `solutions/roles/*.ts`. Optional on purpose — a card whose role has no page
   * must not link anywhere.
   */
  href?: string;
  /** Department. Rendered mono + uppercase; it is the only differentiator. */
  tag: string;
  /** One line, bold. The job the agent does for that team. */
  headline: string;
  /** One sentence. How it does it. */
  body: string;
  /** What lands back, shown on the card. */
  artifact: UseCaseArtifact;
};

/**
 * The use-case wheel — seven roles, one per card, on a scroll-driven arc.
 *
 * ORGANISED BY ROLE, NOT BY INDUSTRY, and deliberately the same roles the
 * `/solutions/<role>` pages use, so the site speaks one vocabulary. The cards
 * are the highlights, not a directory: fewer cards than role pages is fine.
 *
 * THE BAR A CARD HAS TO CLEAR. A job a company already pays somebody to do,
 * that an agent with its own machine, a git repo, connectors and a schedule can
 * run end to end, whose output is one concrete artifact. If you cannot name the
 * artifact in three words, it is not a card. Judgement-bound, liability-heavy
 * work — contract review is the obvious one — fails on credibility however good
 * the demo looks, and stays off.
 *
 * ==========================================================================
 * ACCURACY GATE — this copy is bold, which is exactly where marketing starts
 * describing a product we do not ship. It mirrors the gate in
 * features/marketing/solutions/types.ts. Keep the two in step.
 * ==========================================================================
 *  - MERGE IS DEFAULT-DENY. Work lands as a CHANGE REQUEST. Never "pushes to
 *    main", never "the agent deploys", never "only a human can merge".
 *  - APPROVAL GATES ARE OFF BY DEFAULT (`policy.default_mode` falls back to
 *    `allow_all`). Never write "it waits for approval" as if that were the
 *    default. Say the operator sets Ask on the step that matters.
 *  - CONNECTORS ONLY. Name a third-party tool only if it is genuinely in the
 *    connector catalogue. Apollo is. If a role's obvious tool is not, describe
 *    the capability and drop the brand.
 *  - CHANNELS ARE A CLOSED ENUM. Slack is live. Do not name another.
 *  - COUNTERPARTIES ARE FICTIONAL: Acme, Northwind, Globex, Initech, Umbrella,
 *    Vandelay. People are numbers, never names.
 *  - NO CLAIM ABOUT KORTIX ITSELF. Numbers inside an artifact are a fictional
 *    company's sample data and are fine. A number that reads as a Kortix
 *    metric, ranking or certification is not. That is why the SEO artifact
 *    ranks a fictional company's pages, never ours.
 *  - NEVER A FAKE SCREENSHOT. Artifacts are markup. Do not swap one for an
 *    image of a product surface that does not exist.
 *
 * Two artifacts quote the demo project's committed workspace, read back from
 * its `main` branch rather than typed from memory:
 *   finance      -> finance/fy26-budget.xlsx     (variance = plan/2 − H1 actual)
 *   dataScience  -> sales/win-loss-analysis.xlsx (win rate = won / (won + lost))
 * The arithmetic is derived from the columns beside it. Edit one, re-derive it.
 */
export const useCases = {
  eyebrow: 'By role',
  title: 'It picks up work from every team and runs it start to finish.',
  sub: 'Outbound, error triage, the books, the Monday report — real jobs, on real machines, landing as changes you can read.',
  /** Micro-label in the corner of the artifact frame. */
  artifactLabel: 'Output',
  cards: [
    {
      id: 'sales',
      href: '/solutions/sales',
      /** `role` and `href` match `solutions/roles/*.ts` exactly — one vocabulary. */
      role: 'Sales',
      tag: 'Sales',
      headline: 'Builds the outbound campaign and runs it.',
      body: 'It pulls a lead list from Apollo, enriches every account, and writes a sequence per lead. Put Ask on the send step and it stops with you before anything goes out.',
      artifact: {
        kind: 'thread',
        file: 'outbound/northwind-01.eml',
        to: 'ops@northwind.example',
        time: '08:12',
        subject: 'Your four new platform hires',
        lines: [
          'Saw you are hiring four platform engineers.',
          'Teams at that stage lose about a week a month to',
          'manual reconciliation. We built an agent that closes',
          'that loop and shows its working. Worth twenty minutes?',
        ],
        status: 'Draft · Ask set on send',
        footer: '240 leads pulled · 24 enriched · 3 sequences written',
      },
    },
    {
      id: 'engineering',
      href: '/solutions/engineering',
      role: 'Engineering',
      tag: 'Engineering',
      headline: 'Reads the logs, ships the fix.',
      body: 'Every morning it sweeps the day’s errors, groups them, reproduces the worst one on its own machine, patches it and opens a change request against main.',
      artifact: {
        kind: 'diff',
        file: 'fix-checkout-expiry.diff',
        lines: [
          ' app/checkout/charge.ts',
          '-if (card.expMonth < now.getMonth()) {',
          '+if (isExpired(card, now)) {',
          '+  return fail(402, "card_expired");',
          ' }',
        ],
        stat: '+2 −1',
        footer: '9 error groups · top one fixed · 118 tests pass',
      },
    },
    {
      id: 'marketing',
      href: '/solutions/marketing',
      role: 'Marketing',
      tag: 'Marketing',
      headline: 'Runs the SEO programme week after week.',
      body: 'It tracks the queries you care about, finds the pages losing ground, rewrites them against the brief, and opens each rewrite as a change request.',
      artifact: {
        kind: 'sheet',
        file: 'marketing/seo-weekly.xlsx',
        columns: ['Query', 'Page', 'Pos', 'Change'],
        widths: ['34%', '32%', '12%', '22%'],
        aligns: ['left', 'left', 'right', 'right'],
        toneColumn: 3,
        rows: [
          { cells: ['payout reconciliation', '/guides/payouts', '4', '+7'], tone: 'up' },
          { cells: ['invoice chasing', '/features/ar', '9', '+3'], tone: 'up' },
          { cells: ['bank feed sync', '/guides/bank-feed', '14', '−2'], tone: 'down' },
          { cells: ['month end close', '/guides/close', '2', '+1'], tone: 'up' },
          { cells: ['receipt capture', '/features/receipts', '21', 'new'], tone: 'info' },
        ],
        footer: '5 briefs written · 2 rewrites in a change request',
      },
    },
    {
      id: 'finance',
      href: '/solutions/finance',
      role: 'Finance',
      tag: 'Finance',
      headline: 'Does the books, not just the summary.',
      body: 'It reconciles the ledger against the bank, chases the receipts that are missing, attaches them, and closes the month with the variance explained.',
      artifact: {
        kind: 'sheet',
        file: 'finance/fy26-budget.xlsx',
        columns: ['Cost centre', 'H1 plan', 'Actual', 'Variance'],
        widths: ['36%', '22%', '22%', '20%'],
        aligns: ['left', 'right', 'right', 'right'],
        rows: [
          { cells: ['R&D — platform', '1,225,000', '1,182,400', '+42,600'], tone: 'up' },
          { cells: ['Go-to-market', '810,000', '742,800', '+67,200'], tone: 'up' },
          { cells: ['Security & compliance', '180,000', '198,600', '−18,600'], tone: 'down' },
          { cells: ['Brand & content', '240,000', '219,400', '+20,600'], tone: 'up' },
          { cells: ['Total', '2,455,000', '2,343,200', '+111,800'], total: true },
        ],
        footer: '9 receipts chased and attached · 1 centre over plan',
      },
    },
    {
      id: 'people',
      href: '/solutions/people',
      role: 'People',
      tag: 'People',
      headline: 'Sources the pipeline, not just the inbox.',
      body: 'It searches the sources you connect for people matching the brief, scores each against the written bar, and drafts the first approach for every one worth it.',
      artifact: {
        kind: 'sheet',
        file: 'hiring/staff-infra-pipeline.xlsx',
        columns: ['Prospect', 'Signal', 'Score', 'Stage'],
        widths: ['22%', '36%', '16%', '26%'],
        aligns: ['left', 'left', 'right', 'right'],
        toneColumn: 3,
        rows: [
          { cells: ['#118', 'Ran platform at 200+', '91', 'replied'], tone: 'up' },
          { cells: ['#094', 'Infra lead, six years', '84', 'contacted'], tone: 'info' },
          { cells: ['#131', 'Strong, wrong stack', '67', 'sourced'], tone: 'warn' },
          { cells: ['#072', 'No systems depth', '38', 'passed'], tone: 'down' },
        ],
        footer: '340 profiles searched · 22 shortlisted · 9 approached',
      },
    },
    {
      id: 'product',
      href: '/solutions/product',
      role: 'Product',
      tag: 'Product',
      headline: 'Turns what users say into what ships.',
      body: 'It reads every piece of feedback that came in, groups it into themes you can act on, and takes the top one all the way to a change request.',
      artifact: {
        kind: 'checks',
        file: 'product/feedback-2026-w31.md',
        items: [
          { label: 'Export times out over 10k rows', value: '14', tone: 'down' },
          { label: 'Wants CSV as well as xlsx', value: '9', tone: 'warn' },
          { label: 'Filter state lost on reload', value: '7', tone: 'warn' },
          { label: 'Onboarding called out as good', value: '12', tone: 'up' },
        ],
        footer: '4 themes · top one fixed in a change request',
      },
    },
    {
      id: 'data-science',
      href: '/solutions/data-science',
      role: 'Data Science',
      tag: 'Data Science',
      headline: 'Has Monday’s numbers before Monday.',
      body: 'It queries the warehouse on a schedule, checks the result against last week, draws the chart and posts the whole thing to Slack while you are asleep.',
      artifact: {
        kind: 'chart',
        file: 'reports/win-rate-weekly.md',
        caption: 'Win rate by quarter',
        bars: [
          { label: 'Q3 25', value: '36.7%', pct: 37, tone: 'down' },
          { label: 'Q4 25', value: '44.7%', pct: 45, tone: 'warn' },
          { label: 'Q1 26', value: '54.2%', pct: 54, tone: 'info' },
          { label: 'Q2 26', value: '66.7%', pct: 67, tone: 'up' },
        ],
        footer: 'Posted to #revenue · top loss reason: price',
      },
    },
  ] satisfies readonly UseCase[],
} as const;

export type StackLayerId =
  | 'models'
  | 'harness'
  | 'computer'
  | 'context'
  | 'control'
  | 'security'
  | 'kortix';

export type StackLayer = {
  id: StackLayerId;
  name: string;
  body: string;
  /** Logo chips shown beside the layer. Keys map to `features/icon`. */
  logos?: readonly string[];
  /** Plain text chips where no logo exists. */
  chips?: readonly string[];
};

export const stack = {
  eyebrow: 'One platform',
  title: 'Every layer an AI workforce needs — unified.',
  sub: 'Most tools hand you one layer and rent you the rest. Kortix is all of them, open source, running wherever you put it.',
  layers: [
    {
      id: 'models',
      name: 'Large Language Models',
      body: 'Run any frontier model and switch between them as they improve. Bring your own API keys, the subscription you already pay for, or your own models running on your hardware. Kortix stays model-agnostic, so every agent uses the best model for the job.',
      logos: ['Claude', 'OpenAI', 'Gemini'],
      chips: ['Bedrock', 'OpenRouter', 'Your own, on-prem'],
    },
    {
      id: 'harness',
      name: 'Agentic Harness',
      body: 'The layer that turns a model into an agent: planning, tool use, and multi-step runs it actually finishes. Fully customizable and powered by OpenCode, so the way your agents think is yours to edit.',
      logos: ['OpenCode'],
    },
    {
      id: 'computer',
      name: 'Agent Computer',
      body: 'Every agent gets its own computer — its own isolated Linux machine, pre-set-up with your repo, tools and dependencies. It can install, run and break anything. Nothing to configure, no local machine required.',
      chips: ['One machine per session', 'Pre-configured', 'Thousands in parallel'],
    },
    {
      id: 'context',
      name: 'Context & Connections',
      body: 'Every tool your company runs on, connected once and shared across agents and people, so everyone works from the same picture. 3,000+ apps in a click, plus MCP, OpenAPI, GraphQL and raw HTTP.',
      logos: ['Slack', 'Notion', 'Linear', 'Github', 'MicrosoftTeams', 'Gmail'],
    },
    {
      id: 'control',
      name: 'Product / Control Plane',
      body: 'The control plane that ties every layer together: one place to configure, deploy, observe and operate every agent across your whole organization — from the web, Slack, mobile or the CLI.',
      chips: ['Web', 'Slack', 'Teams', 'Mobile', 'CLI', 'API'],
    },
    {
      id: 'security',
      name: 'Security & Governance',
      body: 'SSO, members, groups and role-based access come built in, with per-resource permissions for people and agents, encrypted secrets and a full audit trail. Self-host so the entire platform runs inside your own environment.',
      chips: ['SSO', 'RBAC', 'Secrets vault', 'Audit trail', 'SOC 2 Type II in progress'],
    },
    {
      id: 'kortix',
      name: 'Kortix',
      body: 'Every layer above brought together in one platform your team owns, deploys and scales end to end — from the model to the finished work. That’s Kortix.',
      chips: ['Open source', 'Self-hostable', 'Yours down to the metal'],
    },
  ] satisfies readonly StackLayer[],
} as const;
