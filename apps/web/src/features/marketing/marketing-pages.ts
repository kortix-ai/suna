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

/** Which side a comparison row favors. The Kortix column stays brand-tinted either
 *  way — the icon communicates the honest lean, never a blanket "Kortix wins". */
export type RowLean = 'kortix' | 'them' | 'both';

export type CompareRow = {
  dimension: string;
  them: string;
  kortix: string;
  lean?: RowLean; // defaults to 'kortix'
};

export type Differentiator = { title: string; body: string };
export type Faq = { q: string; a: string };
export type Scenario = { need: string; pick: 'them' | 'kortix' };

export type Competitor = {
  slug: string;
  /** competitor display name, e.g. "ChatGPT" */
  name: string;
  /** 'adjacent' = you'll outgrow it; 'direct' = head-to-head */
  relation: 'adjacent' | 'direct';

  /** Hero */
  headline: string; // H1 — "Kortix vs X"
  sub: string; // hero subhead (also the hub card description)

  /** SEO */
  seo: {
    title: string;
    description: string;
    keywords: string[];
    ogTitle: string;
    ogDescription: string;
  };

  /** The verdict (TL;DR) */
  verdictThem: string; // "Choose X if…"
  verdictKortix: string; // "Choose Kortix if…"

  /** Comparison table */
  rows: CompareRow[];

  /** What each is built for */
  builtForThem: string;
  builtForKortix: string;

  /** Where Kortix is different */
  differentiators: Differentiator[];

  /** When to choose which */
  scenarios: Scenario[];

  /** FAQ (rendered with FAQPage structured data) */
  faqs: Faq[];

  /** Final CTA */
  ctaTitle: string;
  ctaBody: string;

  /** Trademark & legal footer */
  trademark: string;
};

export const COMPETITORS: Competitor[] = [
  {
    slug: 'chatgpt',
    name: 'ChatGPT',
    relation: 'adjacent',
    headline: 'Kortix vs ChatGPT',
    sub: 'ChatGPT is brilliant at answering questions and drafting text. Kortix builds AI agents that actually do the work — and run on infrastructure you own.',
    seo: {
      title: 'Kortix vs ChatGPT — From answering questions to doing the work',
      description:
        'ChatGPT answers and drafts. Kortix builds AI agents that actually do the work across your tools — open-source, self-hosted, and fully yours. See the difference.',
      keywords: [
        'kortix vs chatgpt',
        'chatgpt alternative',
        'ai agent vs chatgpt',
        'open source chatgpt alternative',
        'self-hosted ai agent',
      ],
      ogTitle: 'Kortix vs ChatGPT',
      ogDescription: 'ChatGPT talks. Kortix gets it done — and you own it.',
    },
    verdictThem:
      'you want a fast, all-purpose assistant to write, brainstorm, summarize, and answer questions in a chat window.',
    verdictKortix:
      'you want AI that goes beyond the chat box — agents that complete real, multi-step work across your tools, that you can host yourself and keep your data private.',
    rows: [
      {
        dimension: 'Finishes multi-step work end to end',
        them: 'Primarily answers and drafts; agent features are newer and limited',
        kortix: 'Agents act across your tools, end to end',
      },
      {
        dimension: 'You own and host it',
        them: "Runs on OpenAI's servers",
        kortix: 'Open-source — run it anywhere',
      },
      {
        dimension: 'Your data stays with you',
        them: 'Sent to and processed by OpenAI',
        kortix: 'Stays on your own infrastructure',
      },
      {
        dimension: 'Build a team of specialized agents',
        them: 'One general-purpose assistant',
        kortix: 'One agent per job',
      },
      {
        dimension: 'Tailor it deeply to your workflows',
        them: 'Limited to custom GPTs and settings',
        kortix: "Fully — it's yours to shape",
      },
      {
        dimension: 'Avoid vendor lock-in',
        them: "Tied to OpenAI's platform",
        kortix: 'Open-source and portable',
      },
      {
        dimension: 'Cost model',
        them: 'Per-seat monthly subscription',
        kortix: 'Open-source; pay only for the AI usage you run',
      },
    ],
    builtForThem:
      "ChatGPT is the best-known AI assistant in the world for good reason — it's fast, capable, and great at the things you'd ask a sharp helper to do: write a draft, explain something, brainstorm, clean up a message. That's where most people meet AI, and for a lot of day-to-day questions it's all you need.",
    builtForKortix:
      'Kortix is a different kind of product. It builds agents that take action — pulling data, running research, working through files, and completing tasks from start to finish without you copy-pasting between a chat window and your real tools. And because Kortix is open-source, those agents run where you choose, on your terms.',
    differentiators: [
      {
        title: 'It does the work, not just the talking.',
        body: 'Asking ChatGPT to "analyze last quarter\'s numbers" gets you a thoughtful answer you then have to act on yourself. A Kortix agent can go get the numbers, run the analysis, and hand you the finished output — so the work is actually done, not just described.',
      },
      {
        title: 'Your data and your AI stay yours.',
        body: "Everything you put into ChatGPT goes to OpenAI's servers. With Kortix, you can run agents on your own cloud or servers, so sensitive information never leaves your control. For anyone in a regulated or privacy-conscious business, that's the whole ballgame.",
      },
      {
        title: 'No lock-in, no per-seat tax.',
        body: "ChatGPT ties you to one company's platform and pricing. Kortix is open-source — you're never locked in, never at the mercy of a price change, and never rationing access seat by seat as your team grows.",
      },
    ],
    scenarios: [
      { need: 'Quick answers, writing help, brainstorming', pick: 'them' },
      { need: 'You need AI to actually complete tasks across your tools', pick: 'kortix' },
      { need: "Your data can't leave your control", pick: 'kortix' },
      { need: 'You want a whole team of agents, owned by you', pick: 'kortix' },
    ],
    faqs: [
      {
        q: 'Is Kortix a replacement for ChatGPT?',
        a: 'Not exactly — they overlap but aim at different jobs. ChatGPT is a general assistant for answers and drafting. Kortix builds agents that complete real work and that you own and host. Many teams use a chat assistant for quick questions and Kortix for the work that needs to get done automatically.',
      },
      {
        q: 'Can I keep my data private with Kortix?',
        a: 'Yes. Kortix is self-hostable, so you can run it on your own cloud or servers and keep your data inside your own walls.',
      },
      {
        q: 'Do I need to be technical to use Kortix?',
        a: 'You describe what you want in plain language and the agents do the work. Setting up self-hosting is more technical, but using the agents day to day is not.',
      },
      {
        q: 'Is Kortix free?',
        a: 'Kortix is open-source. There’s no per-seat subscription — you mainly pay for the AI usage your agents consume.',
      },
    ],
    ctaTitle: 'Stop copy-pasting from a chat window. Put your AI to work.',
    ctaBody:
      'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    trademark:
      'ChatGPT and OpenAI are trademarks of OpenAI, L.L.C. Kortix is not affiliated with, endorsed by, or sponsored by OpenAI. All product names, logos, and brands are the property of their respective owners and are used here for identification and comparison only. Comparisons reflect publicly available information as of June 2026 and may change.',
  },
  {
    slug: 'zapier',
    name: 'Zapier',
    relation: 'adjacent',
    headline: 'Kortix vs Zapier',
    sub: 'Zapier is great at connecting apps with set rules. Kortix gives you AI agents that reason, adapt, and handle open-ended work — running on infrastructure you own.',
    seo: {
      title: 'Kortix vs Zapier — Rigid automations, or agents that think?',
      description:
        'Zapier connects apps with fixed rules. Kortix gives you AI agents that reason, adapt, and do open-ended work — open-source and self-hosted. Compare the two.',
      keywords: [
        'kortix vs zapier',
        'zapier alternative',
        'ai agents vs automation',
        'open source automation',
        'self-hosted ai workflow',
      ],
      ogTitle: 'Kortix vs Zapier',
      ogDescription: 'Fixed rules that break — or agents that adapt and own the outcome.',
    },
    verdictThem:
      'you have predictable, repeatable steps to automate — "when this happens in app A, do that in app B" — and you want a mature library of ready-made connections.',
    verdictKortix:
      "your work isn't a fixed recipe — when tasks change, need judgment, or involve research and analysis — and you want agents that adapt instead of breaking.",
    rows: [
      {
        dimension: 'Handles fuzzy, changing tasks',
        them: 'Breaks when the steps change',
        kortix: 'Agents reason and adapt',
      },
      {
        dimension: 'Does open-ended work (research, analysis, files)',
        them: 'Moves data between apps',
        kortix: 'Research, analysis, finished output',
      },
      {
        dimension: 'Follows simple, predictable triggers',
        them: 'Yes — its core strength',
        kortix: 'Handles these too',
        lean: 'both',
      },
      {
        dimension: 'Self-host and keep data private',
        them: "Runs on Zapier's cloud",
        kortix: 'Your cloud or servers',
      },
      {
        dimension: 'Open-source',
        them: 'No',
        kortix: 'Yes — fully open',
      },
      {
        dimension: 'Avoid vendor lock-in',
        them: 'Tied to Zapier',
        kortix: 'Portable, no lock-in',
      },
      {
        dimension: 'Cost model',
        them: 'Tiered by tasks / number of Zaps',
        kortix: 'Open-source; pay for usage',
      },
    ],
    builtForThem:
      'Zapier is the workhorse of app automation. If you can describe your process as a clear set of "when X, do Y" steps, Zapier connects thousands of apps and runs it reliably, no code required. For rigid, repeatable plumbing, it\'s hard to beat.',
    builtForKortix:
      'Kortix is for the work that isn\'t a fixed recipe. Real tasks change shape: the data looks different this week, a step needs judgment, the request is "look into this and tell me what you find." A rule-based automation breaks the moment reality drifts from the script. A Kortix agent reasons through it.',
    differentiators: [
      {
        title: 'Rules break. Agents adapt.',
        body: 'A Zap does exactly what you wired it to do — and stops working the moment the inputs change. Kortix agents understand the goal and figure out how to reach it, even when the details shift. Less maintenance, fewer broken automations.',
      },
      {
        title: 'Open-ended work, not just moving data.',
        body: 'Zapier shuttles information from one app to another. Kortix agents can actually do something with it — research a topic, analyze a spreadsheet, draft a report, work through a multi-step project.',
      },
      {
        title: 'You own the engine.',
        body: "Zapier runs on Zapier's cloud, on Zapier's terms. Kortix is open-source and self-hostable — your automations and your data stay under your control, with no per-task meter capping how much your team can run.",
      },
    ],
    scenarios: [
      { need: 'Simple, predictable "if-this-then-that" automation', pick: 'them' },
      { need: 'Tasks that need judgment or change often', pick: 'kortix' },
      { need: 'Research, analysis, or open-ended work', pick: 'kortix' },
      { need: 'You need to keep data in-house', pick: 'kortix' },
    ],
    faqs: [
      {
        q: "Isn't Zapier adding AI agents too?",
        a: 'Yes, Zapier has added AI features. The core difference is structural: Zapier is built around fixed rules on its own cloud, while Kortix is an open-source agent platform you can host yourself — built from the ground up for adaptive work and data ownership.',
      },
      {
        q: 'Can Kortix connect to my apps like Zapier does?',
        a: 'Yes — Kortix agents work across your tools and services. The difference is they reason about what to do, rather than only following a pre-set rule.',
      },
      {
        q: 'Is Kortix harder to set up than Zapier?',
        a: 'Zapier wins on instant, no-setup convenience. Kortix asks more upfront — especially self-hosting — in exchange for ownership, privacy, and agents that adapt.',
      },
      {
        q: 'Is it free?',
        a: 'Kortix is open-source with no per-task pricing. You mainly pay for the AI usage your agents consume.',
      },
    ],
    ctaTitle: 'When your work outgrows fixed rules, give it agents that adapt.',
    ctaBody:
      'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    trademark:
      'Zapier is a trademark of Zapier, Inc. Kortix is not affiliated with, endorsed by, or sponsored by Zapier. All product names, logos, and brands are the property of their respective owners and are used here for identification and comparison only. Comparisons reflect publicly available information as of June 2026 and may change.',
  },
  {
    slug: 'viktor',
    name: 'Viktor',
    relation: 'direct',
    headline: 'Kortix vs Viktor',
    sub: "Viktor is a capable AI coworker — but it's a managed service you rent on someone else's cloud. Kortix gives you the same do-the-work power as agents you host, own, and control.",
    seo: {
      title: 'Kortix vs Viktor — An AI coworker you rent, or a team you own?',
      description:
        'Viktor is a managed AI coworker in Slack you pay by the credit. Kortix gives you the same do-the-work power as open-source agents you host and own — no lock-in, no meter.',
      keywords: [
        'kortix vs viktor',
        'viktor alternative',
        'open source ai coworker',
        'self-hosted ai agent',
        'ai agent without vendor lock-in',
      ],
      ogTitle: 'Kortix vs Viktor',
      ogDescription: 'Same do-the-work power — but owned, not rented.',
    },
    verdictThem:
      "you want a polished, zero-setup AI coworker living in Slack or Teams, and you're comfortable with a managed service, credit-based pricing, and your work running on the provider's cloud.",
    verdictKortix:
      'you want that same "agents that actually do work" capability — but open-source, hosted on your own infrastructure, with your data in-house, no per-credit meter, and no vendor lock-in.',
    rows: [
      {
        dimension: 'Completes real work across your tools',
        them: 'Yes — installed in Slack or Teams',
        kortix: 'Yes — across your tools',
        lean: 'both',
      },
      {
        dimension: 'You own and host it',
        them: "Managed service on Viktor's cloud",
        kortix: 'Open-source — your cloud',
      },
      {
        dimension: 'Your data stays with you',
        them: "Runs inside Viktor's cloud",
        kortix: 'On your own infrastructure',
      },
      {
        dimension: 'Zero-setup convenience',
        them: 'Yes — install and go',
        kortix: 'Setup required, especially self-host',
        lean: 'them',
      },
      {
        dimension: "Control over each agent's access",
        them: 'Managed for you',
        kortix: 'Granular — you decide',
      },
      {
        dimension: 'Avoid vendor lock-in',
        them: 'Tied to Viktor',
        kortix: 'Open-source and portable',
      },
      {
        dimension: 'Cost model',
        them: 'Credit-based; scales up with use',
        kortix: 'Open-source; pay only for AI usage',
      },
    ],
    builtForThem:
      "Viktor has nailed a real insight: people don't want another chatbot, they want something that does the job. It installs into Slack or Teams in minutes, connects to thousands of tools, and executes tasks end to end. For a team that wants results fast with nothing to manage, that convenience is genuinely valuable.",
    builtForKortix:
      "The trade-off is ownership. Viktor is a managed, closed service: your work runs on their cloud, you pay by the credit, and you're tied to their platform. Kortix delivers the same fundamental capability — agents that take action — as something you actually own.",
    differentiators: [
      {
        title: 'Own it instead of renting it.',
        body: "Viktor is a service you subscribe to; the moment you stop paying, the capability is gone, and your work has been running on their infrastructure the whole time. Kortix is open-source — your agents run on your cloud or servers, and they're yours to keep, change, and control.",
      },
      {
        title: 'Your data stays in your walls.',
        body: 'With Viktor, your tasks and data flow through their cloud. With Kortix, you can keep everything inside your own infrastructure — which matters a lot if you handle sensitive or regulated information.',
      },
      {
        title: "No credit meter on your team's work.",
        body: "Viktor's credit-based pricing means usage has a running cost that climbs as your team leans on it. Because Kortix is open-source, there's no per-credit meter — you pay for the underlying AI usage and nothing more, so you're never rationing how much real work your agents do.",
      },
      {
        title: 'Real control over every agent.',
        body: 'Kortix lets you decide exactly what each agent can touch, runs tasks in sealed workspaces, and keeps every change tracked and reversible — the kind of governance a business needs when AI is doing real work, not just demos.',
      },
    ],
    scenarios: [
      { need: 'Fastest possible setup, fully managed', pick: 'them' },
      { need: 'You want to own the capability, not rent it', pick: 'kortix' },
      { need: 'Data must stay on your own infrastructure', pick: 'kortix' },
      { need: 'You want predictable cost with no per-credit meter', pick: 'kortix' },
    ],
    faqs: [
      {
        q: 'Does Kortix do the same kind of work as Viktor?',
        a: 'Yes — both go beyond chat to complete real tasks across your tools. The difference is ownership: Kortix is open-source and self-hosted; Viktor is a managed service on its own cloud.',
      },
      {
        q: 'Is Viktor easier to get started with?',
        a: 'Yes, if you want zero setup. Viktor installs into Slack and runs. Kortix asks more upfront, especially if you self-host, in exchange for ownership, privacy, and control.',
      },
      {
        q: 'Will Kortix get expensive as my team grows?',
        a: 'Kortix has no per-seat or per-credit pricing. Your cost is mainly the AI usage your agents consume, so growing your team doesn’t trigger a new pricing tier.',
      },
      {
        q: 'Can I keep my data off a third-party cloud?',
        a: 'Yes — that’s a core reason teams choose Kortix. Self-host it and your data stays entirely within your own infrastructure.',
      },
    ],
    ctaTitle: 'The same AI coworker capability — owned, private, and yours to keep.',
    ctaBody:
      'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    trademark:
      'Viktor is a trademark of its respective owner (Zeta Labs). Slack is a trademark of Salesforce, Inc.; Microsoft Teams is a trademark of Microsoft Corporation. Kortix is not affiliated with, endorsed by, or sponsored by any of these companies. All product names, logos, and brands are the property of their respective owners and are used here for identification and comparison only. Comparisons reflect publicly available information as of June 2026 and may change.',
  },
  {
    slug: 'openclaw',
    name: 'OpenClaw',
    relation: 'direct',
    headline: 'Kortix vs OpenClaw',
    sub: 'Both are open-source and self-hosted — but OpenClaw is built as a personal "Jarvis" on your own machine. Kortix is the team-grade platform for running AI agents across a business, with the control that requires.',
    seo: {
      title: 'Kortix vs OpenClaw — A personal Jarvis, or a team-grade platform?',
      description:
        'OpenClaw is a brilliant personal AI assistant for your own machine. Kortix is the open-source, team-grade platform for running governed AI agents across your business.',
      keywords: [
        'kortix vs openclaw',
        'openclaw alternative',
        'open source ai agent for teams',
        'self-hosted ai agent platform',
        'business ai agents',
      ],
      ogTitle: 'Kortix vs OpenClaw',
      ogDescription:
        "Both open-source and self-hosted — one's a personal Jarvis, one's built for teams.",
    },
    verdictThem:
      'you want a personal, always-on AI assistant on your own laptop or server, wired into your messaging apps for individual automation.',
    verdictKortix:
      'you want to run AI agents across a team or business — with the ability to manage many agents, control what each can access, and keep everything governed and reversible.',
    rows: [
      {
        dimension: 'Open-source and self-hosted',
        them: 'Yes',
        kortix: 'Yes',
        lean: 'both',
      },
      {
        dimension: 'Designed for',
        them: 'Personal, individual use',
        kortix: 'Teams and businesses',
      },
      {
        dimension: 'Run and manage many agents',
        them: 'One personal assistant',
        kortix: 'A whole team',
      },
      {
        dimension: 'Control what each agent can access',
        them: 'Limited; security is largely DIY',
        kortix: 'You set the boundaries',
      },
      {
        dimension: "Sealed workspaces so tasks don't collide",
        them: 'Limited',
        kortix: 'Yes — isolated by default',
      },
      {
        dimension: 'Every change tracked and reversible',
        them: 'Limited',
        kortix: 'Yes — full audit trail',
      },
      {
        dimension: 'Runs on',
        them: 'Your laptop or VPS',
        kortix: 'Your cloud, private network, or on-prem',
      },
    ],
    builtForThem:
      'OpenClaw is a genuine open-source phenomenon — it earned its huge following by giving individuals a private, always-on assistant that lives on their own hardware and connects to the messaging apps they already use. As a personal "Jarvis," it\'s excellent, and it shares Kortix\'s core values: open-source, self-hosted, your data stays yours.',
    builtForKortix:
      "Kortix takes those same values and builds for a different scale: a business running AI agents as part of how it operates. That shift — from one person's assistant to a team's shared, governed workforce — is where the two diverge.",
    differentiators: [
      {
        title: 'Built for a team, not just one person.',
        body: 'OpenClaw is designed around a single personal assistant. Kortix lets you run a whole fleet of agents — different ones for different jobs — managed together as part of how your business works.',
      },
      {
        title: 'Control that a business actually needs.',
        body: 'When AI is doing real work for a company, "it just runs on my laptop" isn\'t enough. Kortix lets you decide exactly what each agent can access, runs each task in its own sealed workspace so nothing collides, and keeps every change tracked and reversible — so a mistake is easy to undo and nothing happens silently.',
      },
      {
        title: 'Runs where a business runs.',
        body: 'OpenClaw typically lives on a personal machine or a single server. Kortix is built to run on your company cloud, private network, or on-premises — the environments a business needs for security and scale.',
      },
      {
        title: 'Same open-source freedom — without the DIY safety burden.',
        body: "You keep everything you love about OpenClaw — open-source, self-hosted, no lock-in — but you don't have to hand-build the guardrails. Kortix brings the access controls, isolation, and change tracking already in place.",
      },
    ],
    scenarios: [
      { need: 'A private assistant for yourself', pick: 'them' },
      { need: 'AI agents running across a team or business', pick: 'kortix' },
      { need: 'You need control over what each agent can do', pick: 'kortix' },
      { need: 'You want open-source and self-hosted, but business-grade', pick: 'kortix' },
    ],
    faqs: [
      {
        q: "Aren't Kortix and OpenClaw both open-source and self-hosted?",
        a: 'Yes — they share those values. The difference is focus: OpenClaw is built as a personal assistant for one person; Kortix is built for teams, with the management, access control, and governance a business needs.',
      },
      {
        q: 'Can OpenClaw be used by a team?',
        a: "It can be configured for more than one person, but it's designed and documented primarily for personal use, so team governance and control are largely something you build yourself. Kortix is built for that from the start.",
      },
      {
        q: 'Is Kortix harder to run than OpenClaw?',
        a: 'Both are self-hosted. Kortix includes more team-grade structure out of the box — controls, isolation, change tracking — which is exactly what you want once AI is doing real work for a business.',
      },
      {
        q: 'Will I lose the freedom OpenClaw gives me?',
        a: 'No. Kortix is also open-source with no vendor lock-in — you keep ownership and portability, and gain the controls a team needs.',
      },
    ],
    ctaTitle: 'Love the open-source freedom of OpenClaw? Get it built for teams.',
    ctaBody:
      'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    trademark:
      'OpenClaw is a trademark of its respective owner. Kortix is not affiliated with, endorsed by, or sponsored by OpenClaw or its maintainers. All product names, logos, and brands are the property of their respective owners and are used here for identification and comparison only. Comparisons reflect publicly available information as of June 2026 and may change.',
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
  {
    slug: 'slack',
    name: 'Slack',
    domain: 'slack.com',
    category: 'Communication',
    blurb: 'Run coworkers from any channel — @mention to spin up work, get results in-thread.',
  },
  {
    slug: 'gmail',
    name: 'Gmail',
    domain: 'gmail.com',
    category: 'Communication',
    blurb: 'Triage, draft and send email — and turn threads into actions.',
  },
  {
    slug: 'salesforce',
    name: 'Salesforce',
    domain: 'salesforce.com',
    category: 'CRM & Sales',
    blurb: 'Enrich records, update opportunities and pull pipeline into any report.',
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    domain: 'hubspot.com',
    category: 'CRM & Sales',
    blurb: 'Sync contacts, log activity and build pipeline reports automatically.',
  },
  {
    slug: 'github',
    name: 'GitHub',
    domain: 'github.com',
    category: 'Developer',
    blurb: 'Open PRs, triage issues, review code and ship release notes.',
  },
  {
    slug: 'linear',
    name: 'Linear',
    domain: 'linear.app',
    category: 'Developer',
    blurb: 'Create scoped issues from support signal and keep projects in sync.',
  },
  {
    slug: 'stripe',
    name: 'Stripe',
    domain: 'stripe.com',
    category: 'Finance',
    blurb: 'Pull MRR, churn and revenue into daily reports and board decks.',
  },
  {
    slug: 'quickbooks',
    name: 'QuickBooks',
    domain: 'quickbooks.intuit.com',
    category: 'Finance',
    blurb: 'Reconcile invoices, match line items and surface anomalies.',
  },
  {
    slug: 'notion',
    name: 'Notion',
    domain: 'notion.so',
    category: 'Productivity',
    blurb: 'Read and write docs, build wikis and keep knowledge current.',
  },
  {
    slug: 'google-drive',
    name: 'Google Drive',
    domain: 'drive.google.com',
    category: 'Productivity',
    blurb: 'Read, create and organize files across your workspace.',
  },
  {
    slug: 'snowflake',
    name: 'Snowflake',
    domain: 'snowflake.com',
    category: 'Data & Analytics',
    blurb: 'Query the warehouse in plain English and chart the answer.',
  },
  {
    slug: 'posthog',
    name: 'PostHog',
    domain: 'posthog.com',
    category: 'Data & Analytics',
    blurb: 'Pull product metrics and build live usage dashboards.',
  },
  {
    slug: 'google-ads',
    name: 'Google Ads',
    domain: 'ads.google.com',
    category: 'Marketing',
    blurb: 'Audit spend, flag underperformers and draft new ad copy.',
  },
  {
    slug: 'meta-ads',
    name: 'Meta Ads',
    domain: 'facebook.com',
    category: 'Marketing',
    blurb: 'Track ROAS and CAC and recommend budget shifts.',
  },
  {
    slug: 'zendesk',
    name: 'Zendesk',
    domain: 'zendesk.com',
    category: 'Support',
    blurb: 'Triage tickets, draft replies and turn resolutions into KB articles.',
  },
  {
    slug: 'intercom',
    name: 'Intercom',
    domain: 'intercom.com',
    category: 'Support',
    blurb: 'Route conversations and surface account context for every reply.',
  },
];
