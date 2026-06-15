/**
 * marketing-pages.ts — data for the programmatic SEO pages.
 *
 *   COMPETITORS   → /compare/[slug]
 *   SOLUTION_HERO → /solutions/[slug]  (personas live in narrative.ts USE_CASES)
 *   INTEGRATIONS  → /integrations/[slug]
 *
 * Copy is original to Kortix. Competitor descriptions are neutral and factual —
 * "different, not worse" — and trace back to POSITIONING.md.
 */

export type CompareRow = { dimension: string; them: string; kortix: string };

export type Competitor = {
  slug: string;
  name: string;
  /** hero sub: "From X to Y" framing */
  headline: string;
  sub: string;
  theirOneLiner: string;
  kortixOneLiner: string;
  rows: CompareRow[];
  chooseThem: string[];
  chooseUs: string[];
};

const OWNERSHIP_ROW: CompareRow = {
  dimension: 'Ownership',
  them: 'Closed and hosted by the vendor',
  kortix: 'Open-source — self-host on your own infra, no lock-in',
};
const MODELS_ROW: CompareRow = {
  dimension: 'Models',
  them: 'The provider’s own models',
  kortix: 'Any model — bring your own keys or subscriptions',
};
const SKILLS_ROW: CompareRow = {
  dimension: 'Shared learning',
  them: 'Stays with the individual',
  kortix: 'Packaged as skills the whole company inherits',
};

export const COMPETITORS: Competitor[] = [
  {
    slug: 'kortix-vs-chatgpt',
    name: 'ChatGPT',
    headline: 'Kortix vs ChatGPT',
    sub: 'ChatGPT is a brilliant assistant for answers. Kortix is a workforce that does the work.',
    theirOneLiner: 'A best-in-class chat assistant for answers, drafts and ideas.',
    kortixOneLiner: 'A team of AI coworkers that connect to your tools and ship finished work.',
    rows: [
      { dimension: 'What it is', them: 'A chat assistant', kortix: 'A team of AI coworkers' },
      {
        dimension: 'What you get back',
        them: 'Text, drafts and snippets you finish',
        kortix: 'Finished artifacts — PDFs, dashboards, apps, PRs',
      },
      {
        dimension: 'Your tools',
        them: 'A handful of connectors; mostly copy-paste',
        kortix: '3,000+ integrations, used together in one run',
      },
      {
        dimension: 'Runs work on its own',
        them: 'You drive every step',
        kortix: 'Delegates end-to-end — and on a schedule',
      },
      {
        dimension: 'Memory',
        them: 'Per-chat, limited',
        kortix: 'Company-wide, synthesized from your tools',
      },
      SKILLS_ROW,
      MODELS_ROW,
      OWNERSHIP_ROW,
    ],
    chooseThem: ['Quick answers and brainstorming', 'A single-person assistant', 'Drafting from scratch'],
    chooseUs: [
      'You want the work delivered, not described',
      'A whole team needs to run and share it',
      'You want to own and self-host it',
    ],
  },
  {
    slug: 'kortix-vs-claude-in-slack',
    name: 'Claude in Slack',
    headline: 'Kortix vs Claude in Slack',
    sub: 'A chat assistant in Slack is handy. A coworker in Slack that ships real work is another thing entirely.',
    theirOneLiner: 'A capable AI assistant you can chat with inside Slack.',
    kortixOneLiner: 'AI coworkers that live in Slack, connect to your tools and deliver finished work.',
    rows: [
      { dimension: 'In Slack', them: 'Chat and answers in-channel', kortix: 'Coworkers that do the work in-channel' },
      {
        dimension: 'Your tools',
        them: 'Conversation only',
        kortix: 'Pulls from Stripe, CRM, Notion, GitHub and 3,000+ more',
      },
      {
        dimension: 'Deliverables',
        them: 'Messages and text',
        kortix: 'PDFs, dashboards, web apps, code',
      },
      { dimension: 'Scheduled work', them: 'Not really', kortix: 'Daily/weekly automations posted to Slack' },
      { dimension: 'Memory', them: 'Thread-scoped', kortix: 'Company-wide and persistent' },
      SKILLS_ROW,
      OWNERSHIP_ROW,
    ],
    chooseThem: ['Q&A and summarizing in Slack', 'Light, conversational help'],
    chooseUs: [
      'You want Slack to actually ship work',
      'Tool-connected, scheduled, team-shared',
      'Self-hosted and yours to own',
    ],
  },
  {
    slug: 'kortix-vs-zapier',
    name: 'Zapier',
    headline: 'Kortix vs Zapier',
    sub: 'Zapier runs the rules you write. Kortix figures out what to do — and does it.',
    theirOneLiner: 'A no-code automation tool that connects apps with predefined triggers and actions.',
    kortixOneLiner: 'AI coworkers that reason over your tools and complete open-ended work.',
    rows: [
      {
        dimension: 'How it works',
        them: 'Rigid trigger → action rules you build and maintain',
        kortix: 'Describe the outcome; the agent reasons and acts',
      },
      {
        dimension: 'Handles ambiguity',
        them: 'No — every branch must be defined',
        kortix: 'Yes — it decides what needs doing',
      },
      {
        dimension: 'Deliverables',
        them: 'Data moved between apps',
        kortix: 'Finished work — reports, dashboards, apps, code',
      },
      { dimension: 'Maintenance', them: 'You own every broken Zap', kortix: 'It adapts; no brittle wiring' },
      SKILLS_ROW,
      OWNERSHIP_ROW,
    ],
    chooseThem: ['Simple, deterministic app-to-app syncs', 'Fixed, repeatable plumbing'],
    chooseUs: [
      'Open-ended work that needs judgment',
      'Real deliverables, not just moved data',
      'Own it and bring your own models',
    ],
  },
  {
    slug: 'kortix-vs-viktor',
    name: 'Viktor',
    headline: 'Kortix vs Viktor',
    sub: 'Viktor rents you one AI hire. Kortix is a whole workforce your company owns and levels up.',
    theirOneLiner: 'A managed, closed-source AI employee that lives in Slack.',
    kortixOneLiner: 'An open-source AI workforce you own — every employee gets coworkers, sharpened by shared skills.',
    rows: [
      { dimension: 'Scope', them: 'A single managed AI employee', kortix: 'A workforce, company-wide' },
      {
        dimension: 'Ownership',
        them: 'Closed-source, vendor-hosted',
        kortix: 'Open-source, self-hostable on your infra',
      },
      SKILLS_ROW,
      MODELS_ROW,
      {
        dimension: 'Surfaces',
        them: 'Mainly Slack/Teams',
        kortix: 'Slack, web workspace, mobile, API and CLI',
      },
      {
        dimension: 'Extensibility',
        them: 'What the vendor ships',
        kortix: 'Everything is code — extend it freely',
      },
    ],
    chooseThem: ['You want a fully-managed single assistant', 'No interest in owning the stack'],
    chooseUs: [
      'You want to own your AI infrastructure',
      'Composable skills shared across the company',
      'Any model, any surface, fully extensible',
    ],
  },
  {
    slug: 'kortix-vs-openclaw',
    name: 'OpenClaw',
    headline: 'Kortix vs OpenClaw',
    sub: 'A local DIY agent proves the idea. Kortix is the production-ready, team-wide version you still own.',
    theirOneLiner: 'An open-source local agent for technical users who want full control.',
    kortixOneLiner: 'An open-source platform that’s production-ready and team-wide — without the maintenance treadmill.',
    rows: [
      { dimension: 'Who it’s for', them: 'Individual technical tinkerers', kortix: 'Whole teams, technical and not' },
      {
        dimension: 'Setup',
        them: 'Configure, test and maintain it yourself',
        kortix: 'Sign in once; managed or self-hosted',
      },
      {
        dimension: 'Integrations',
        them: 'Wire up each one yourself',
        kortix: '3,000+ connected, shared across the org',
      },
      { dimension: 'Team features', them: 'Single-user', kortix: 'Roles, audit, shared skills, SSO' },
      OWNERSHIP_ROW,
    ],
    chooseThem: ['You want maximum local control', 'You enjoy running your own ops'],
    chooseUs: [
      'Production-ready for a whole team',
      'Still open-source and self-hostable',
      'No maintenance treadmill',
    ],
  },
];

/** Hero copy per persona for /solutions/[slug]. Personas + features live in narrative USE_CASES. */
export const SOLUTION_HERO: Record<string, { headline: string; sub: string }> = {
  founders: {
    headline: 'An AI workforce for founders & CEOs',
    sub: 'The analyst, the assistant and the ops hire you haven’t made yet — connected to your whole stack.',
  },
  marketing: {
    headline: 'An AI workforce for marketing & growth',
    sub: 'Manage the ad accounts, write the content, build the pipeline — and report on all of it.',
  },
  engineering: {
    headline: 'An AI workforce for engineering',
    sub: 'Triage bugs, open PRs and build internal tools — so your team works on what matters.',
  },
  ops: {
    headline: 'An AI workforce for ops & finance',
    sub: 'Kill the spreadsheet wrangling, vendor chasing and report building that eats your team alive.',
  },
};

export type Integration = {
  slug: string;
  name: string;
  domain: string;
  category: string;
  blurb: string;
};

export const INTEGRATION_CATEGORIES = [
  'Communication',
  'CRM & Sales',
  'Developer',
  'Finance',
  'Productivity',
  'Data & Analytics',
  'Marketing',
  'Support',
] as const;

export const INTEGRATIONS: Integration[] = [
  { slug: 'slack', name: 'Slack', domain: 'slack.com', category: 'Communication', blurb: 'Run coworkers from any channel — @mention to spin up work, get results in-thread.' },
  { slug: 'gmail', name: 'Gmail', domain: 'gmail.com', category: 'Communication', blurb: 'Triage, draft and send email — and turn threads into actions.' },
  { slug: 'salesforce', name: 'Salesforce', domain: 'salesforce.com', category: 'CRM & Sales', blurb: 'Enrich records, update opportunities and pull pipeline into any report.' },
  { slug: 'hubspot', name: 'HubSpot', domain: 'hubspot.com', category: 'CRM & Sales', blurb: 'Sync contacts, log activity and build pipeline reports automatically.' },
  { slug: 'github', name: 'GitHub', domain: 'github.com', category: 'Developer', blurb: 'Open PRs, triage issues, review code and ship release notes.' },
  { slug: 'linear', name: 'Linear', domain: 'linear.app', category: 'Developer', blurb: 'Create scoped issues from support signal and keep projects in sync.' },
  { slug: 'stripe', name: 'Stripe', domain: 'stripe.com', category: 'Finance', blurb: 'Pull MRR, churn and revenue into daily reports and board decks.' },
  { slug: 'quickbooks', name: 'QuickBooks', domain: 'quickbooks.intuit.com', category: 'Finance', blurb: 'Reconcile invoices, match line items and surface anomalies.' },
  { slug: 'notion', name: 'Notion', domain: 'notion.so', category: 'Productivity', blurb: 'Read and write docs, build wikis and keep knowledge current.' },
  { slug: 'google-drive', name: 'Google Drive', domain: 'drive.google.com', category: 'Productivity', blurb: 'Read, create and organize files across your workspace.' },
  { slug: 'snowflake', name: 'Snowflake', domain: 'snowflake.com', category: 'Data & Analytics', blurb: 'Query the warehouse in plain English and chart the answer.' },
  { slug: 'posthog', name: 'PostHog', domain: 'posthog.com', category: 'Data & Analytics', blurb: 'Pull product metrics and build live usage dashboards.' },
  { slug: 'google-ads', name: 'Google Ads', domain: 'ads.google.com', category: 'Marketing', blurb: 'Audit spend, flag underperformers and draft new ad copy.' },
  { slug: 'meta-ads', name: 'Meta Ads', domain: 'facebook.com', category: 'Marketing', blurb: 'Track ROAS and CAC and recommend budget shifts.' },
  { slug: 'zendesk', name: 'Zendesk', domain: 'zendesk.com', category: 'Support', blurb: 'Triage tickets, draft replies and turn resolutions into KB articles.' },
  { slug: 'intercom', name: 'Intercom', domain: 'intercom.com', category: 'Support', blurb: 'Route conversations and surface account context for every reply.' },
];
