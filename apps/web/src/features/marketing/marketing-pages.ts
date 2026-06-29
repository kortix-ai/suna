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
    slug: 'claude-cowork',
    name: 'Claude Cowork',
    relation: 'direct',
    headline: 'Kortix vs Claude Cowork',
    sub: "Claude Cowork is the strongest agent on the desktop — but it's one assistant per person, locked to Anthropic's models, with your data on their cloud. Kortix runs a whole company's agents in parallel, on any model, on infrastructure you own.",
    seo: {
      title: 'Kortix vs Claude Cowork — One desktop assistant, or a company-wide agent platform?',
      description:
        'Claude Cowork does real agentic work on your desktop — for one person, on Anthropic models, on their cloud. Kortix is the open, self-hostable platform for running a fleet of agents across your company, on any model. Compare.',
      keywords: [
        'kortix vs claude cowork',
        'claude cowork alternative',
        'open source claude cowork alternative',
        'self-hosted ai agent platform',
        'multi-tenant ai agents',
      ],
      ogTitle: 'Kortix vs Claude Cowork',
      ogDescription:
        'One desktop assistant on one lab’s models — or a company-wide agent fleet you own.',
    },
    verdictThem:
      "you want a polished desktop agent that does real multi-step work for one person, you're happy on Anthropic's models, and you don't need to self-host or run a whole fleet.",
    verdictKortix:
      'you want that same do-the-work power as a company platform — many agents across departments, any model, self-hosted, with every agent, skill, and policy versioned and owned by you.',
    rows: [
      {
        dimension: 'Does real, multi-step work end to end',
        them: 'Yes — on your desktop',
        kortix: 'Yes — in the cloud, at scale',
        lean: 'both',
      },
      {
        dimension: 'Runs a fleet of agents in parallel',
        them: 'One assistant per person, on one machine',
        kortix: 'Thousands of agents in parallel',
      },
      {
        dimension: 'Choose your models',
        them: 'Anthropic (Claude) only',
        kortix: 'Any model — bring your own keys',
      },
      {
        dimension: 'Open-source and self-hostable',
        them: 'No — closed, runs via Anthropic',
        kortix: 'Yes — your cloud, VPC, or on-prem',
      },
      {
        dimension: 'Your data stays with you',
        them: "Processed by Anthropic's cloud",
        kortix: 'On your own infrastructure',
      },
      {
        dimension: 'Multi-tenant — departments, users, roles',
        them: 'A per-user desktop app',
        kortix: 'Multi-tenant by default',
      },
      {
        dimension: 'Isolated execution per task',
        them: 'Runs on your own desktop',
        kortix: 'Isolated microVM sandbox per session',
      },
      {
        dimension: 'Everything as versioned code you own',
        them: 'Plugins customize one assistant',
        kortix: 'Agents, skills, memory & policies as files in your repo',
      },
    ],
    builtForThem:
      "Claude Cowork is the most capable mainstream agent for individual knowledge work — it inherits Claude Code's engine, genuinely does multi-step work on your files and apps, shows a plan before acting, and has a clean approval model. For one person who lives on Claude and wants a brilliant agent on their desktop, it's outstanding.",
    builtForKortix:
      "Kortix is built for the next scale up: a company running agents as part of how it operates. Instead of one assistant on one machine tied to one lab's models, you get a multi-tenant platform where a fleet of agents runs in parallel — each in its own isolated sandbox, on whatever model you choose, with the whole setup versioned in a repo you own.",
    differentiators: [
      {
        title: 'A fleet, not one desktop assistant.',
        body: 'Cowork is one assistant per person, running on that person’s machine. Kortix runs a whole workforce — hundreds of thousands of agents in parallel, each in its own isolated sandbox — so the work scales past a single desktop and a single user.',
      },
      {
        title: 'Any model, your keys — never one lab.',
        body: 'Cowork only runs on Anthropic’s models. Kortix is model-agnostic: bring Claude, GPT, Gemini, open weights, or your own endpoint, and route per agent. You’re never locked to a single vendor’s roadmap, pricing, or outages.',
      },
      {
        title: 'Own it and run it yourself.',
        body: 'Cowork is closed and runs through Anthropic, so your data flows to their cloud. Kortix is open-source and self-hostable — run it on your own cloud, VPC, or on-prem, and keep every byte inside your walls.',
      },
      {
        title: 'Built for a company, governed as code.',
        body: 'Multi-tenant with real departments, users, and roles; scoped policies on every connector; isolated sandboxes with network-egress control; and agents, skills, memory and policies kept as versioned files you can diff, review, and roll back. Cowork customizes one assistant with plugins — Kortix governs an entire org.',
      },
    ],
    scenarios: [
      { need: 'A brilliant agent on one person’s desktop', pick: 'them' },
      { need: 'A fleet of agents across departments', pick: 'kortix' },
      { need: 'You need to choose your own models', pick: 'kortix' },
      { need: 'Self-hosted, with data on your own infrastructure', pick: 'kortix' },
    ],
    faqs: [
      {
        q: 'Is Claude Cowork not already an agent that does the work?',
        a: 'Yes — Cowork genuinely does multi-step work, and it’s excellent at it. The difference is architecture and ownership: Cowork is one closed, Claude-only assistant per person running on your desktop and Anthropic’s cloud. Kortix is an open, self-hostable, multi-tenant platform that runs a fleet of agents on any model, with everything versioned as code you own.',
      },
      {
        q: 'Can I use Claude models with Kortix?',
        a: 'Yes. Kortix is model-agnostic — Claude is fully supported, alongside GPT, Gemini, open-weight models, or your own endpoint. You bring your own keys and choose per agent.',
      },
      {
        q: 'Can Cowork run a fleet of agents for a whole company?',
        a: 'It’s designed as one desktop assistant per person, customized with plugins. Running governed agents across departments — with roles, isolation, and audit — is what Kortix is built for.',
      },
      {
        q: 'Can I self-host Kortix?',
        a: 'Yes. Kortix is open-source and runs on your own cloud, VPC, or on-prem, so your data and agents stay inside your infrastructure.',
      },
    ],
    ctaTitle: 'Love agents that do the work? Run a whole fleet — on your own terms.',
    ctaBody:
      'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    trademark:
      'Claude and Claude Cowork are trademarks of Anthropic, PBC. Kortix is not affiliated with, endorsed by, or sponsored by Anthropic. All product names, logos, and brands are the property of their respective owners and are used here for identification and comparison only. Comparisons reflect publicly available information as of June 2026 and may change.',
  },
  {
    slug: 'hermes',
    name: 'Hermes',
    relation: 'direct',
    headline: 'Kortix vs Hermes',
    sub: 'Hermes is a beautiful open-source personal agent — self-hosted, bring-your-own-model, living in your chat apps. Like every great personal agent, it’s built for one operator. Kortix is the same open spirit, built for a whole company.',
    seo: {
      title: 'Kortix vs Hermes — A personal agent, or a company-wide platform?',
      description:
        'Hermes is an excellent open-source personal AI agent for one operator. Kortix is the open-source, multi-tenant platform for running governed AI agents across a whole company. Compare the two.',
      keywords: [
        'kortix vs hermes',
        'hermes agent alternative',
        'open source ai agent for teams',
        'self-hosted ai agent platform',
        'multi-tenant ai agents',
      ],
      ogTitle: 'Kortix vs Hermes',
      ogDescription:
        'Both open-source and self-hosted — one’s a personal agent, one’s built for a company.',
    },
    verdictThem:
      'you want a private, always-on personal agent on your own machine — with persistent memory and self-built skills — wired into your messaging apps for individual automation.',
    verdictKortix:
      'you want to run AI agents across a team or company — many agents, scoped per-connector policies, isolated sandboxes, departments and roles — all governed and versioned.',
    rows: [
      {
        dimension: 'Open-source and self-hostable',
        them: 'Yes — MIT, bring your own model',
        kortix: 'Yes — any model, your keys',
        lean: 'both',
      },
      {
        dimension: 'Designed for',
        them: 'One operator (personal use)',
        kortix: 'Teams and companies',
      },
      {
        dimension: 'Run and manage many agents',
        them: 'A personal agent (+ optional subagents)',
        kortix: 'A whole fleet, in parallel',
      },
      {
        dimension: 'Multi-tenant — departments, users, roles',
        them: 'Not documented — single operator',
        kortix: 'Multi-tenant by default',
      },
      {
        dimension: 'Scoped policies per connector',
        them: 'Command approval; largely DIY',
        kortix: 'Allow / ask / block per tool, as code',
      },
      {
        dimension: 'Isolated sandbox per task',
        them: 'Optional container backends',
        kortix: 'Isolated microVM per session, egress-controlled',
      },
      {
        dimension: 'Versioned, auditable, reversible',
        them: 'Limited',
        kortix: 'Git-backed — full history',
      },
    ],
    builtForThem:
      'Hermes (from Nous Research) is a genuinely great personal agent: open-source and MIT-licensed, it lives on your own infrastructure, remembers context over time, builds its own reusable skills, and reaches you across CLI, Telegram, Slack, WhatsApp and more. As a single-operator "agent that grows with you," it’s excellent — and it shares Kortix’s core values: open, self-hosted, your models, your data.',
    builtForKortix:
      'Kortix takes those same values and builds for a different scale: a company running agents as part of how it operates. The shift from one person’s assistant to a team’s shared, governed, multi-tenant workforce — with per-connector policies, isolation, roles, and a Git-backed audit trail — is where the two diverge.',
    differentiators: [
      {
        title: 'Built for a company, not one operator.',
        body: 'Hermes is designed around a single personal agent. Kortix is multi-tenant by default: many agents, many people, departments and roles, each with their own scoped permissions — a shared workforce, not a personal sidekick.',
      },
      {
        title: 'Governance that scales past trust.',
        body: 'A personal agent can assume one trusted user. The moment many employees and connectors are involved, you need least-privilege: Kortix gives every connector allow/ask/block policies, runs each task in an isolated microVM sandbox with network-egress control, and keeps every change versioned and reversible.',
      },
      {
        title: 'A real runtime for parallel work.',
        body: 'Hermes can spawn the occasional subagent. Kortix is a runtime built to run hundreds of thousands of agents in parallel, each isolated, all landing their work back into one shared, Git-backed main.',
      },
      {
        title: 'Same open-source freedom — without the DIY safety burden.',
        body: 'You keep everything you love about a great open agent — open-source, self-hosted, bring-your-own-model, no lock-in — but you don’t have to hand-assemble the org-level guardrails. Kortix ships the isolation, scoped policies, roles, and audit trail already in place.',
      },
    ],
    scenarios: [
      { need: 'A private, always-on agent for yourself', pick: 'them' },
      { need: 'AI agents running across a team or company', pick: 'kortix' },
      { need: 'You need scoped control over what each agent can touch', pick: 'kortix' },
      { need: 'Open-source and self-hosted, but governed and multi-tenant', pick: 'kortix' },
    ],
    faqs: [
      {
        q: 'Aren’t Kortix and Hermes both open-source and self-hosted?',
        a: 'Yes — they share those values, and Hermes is a great single-player agent. The difference is scale and governance: Hermes is built for one operator; Kortix is built for a company, with multi-tenancy, scoped per-connector policies, isolated sandboxes, roles, and a Git-backed audit trail.',
      },
      {
        q: 'Can Hermes be used by a whole team?',
        a: 'It can spawn subagents and run on shared infrastructure, but it’s designed and documented for a single operator, so team roles, tenant isolation, and org-wide audit are largely something you’d build yourself. Kortix is built for that from the start.',
      },
      {
        q: 'Do I keep bring-your-own-model with Kortix?',
        a: 'Yes. Like Hermes, Kortix is model-agnostic — bring any provider and your own keys, and choose per agent.',
      },
      {
        q: 'Is Kortix harder to run than Hermes?',
        a: 'Both are self-hosted. Kortix includes far more team-grade structure out of the box — isolation, scoped policies, roles, audit — which is exactly what you want once agents are doing real work for a company.',
      },
    ],
    ctaTitle: 'Love a great open-source agent? Get one built for your whole company.',
    ctaBody:
      'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    trademark:
      'Hermes is a product of Nous Research. Kortix is not affiliated with, endorsed by, or sponsored by Nous Research. All product names, logos, and brands are the property of their respective owners and are used here for identification and comparison only. Comparisons reflect publicly available information as of June 2026 and may change.',
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
  {
    slug: 'glean',
    name: 'Glean',
    relation: 'adjacent',
    headline: 'Kortix vs Glean',
    sub: 'Glean is best-in-class enterprise search and assistant — but it’s a closed, seat-priced platform you query, not own. Kortix is the open runtime where you build and run the agents that do the work, on infrastructure you own.',
    seo: {
      title: 'Kortix vs Glean — Search your knowledge, or run agents that do the work?',
      description:
        'Glean is a closed, seat-priced enterprise search & assistant you query. Kortix is the open-source, self-hostable runtime where you build and run a fleet of agents that take action — agents, skills and policies as code you own. Compare.',
      keywords: [
        'kortix vs glean',
        'glean alternative',
        'open source glean alternative',
        'enterprise ai agents',
        'self-hosted ai platform',
      ],
      ogTitle: 'Kortix vs Glean',
      ogDescription:
        'Query your knowledge — or build and run the agents that do the work, and own them.',
    },
    verdictThem:
      'you want permission-aware enterprise search and an assistant over your company’s knowledge, and you’re a large org comfortable with a closed, seat-priced SaaS.',
    verdictKortix:
      'you want to build and run a fleet of agents that take action across your tools — owned, self-hostable, any model, with agents, skills and policies as code — not just search and ask.',
    rows: [
      {
        dimension: 'Core mode',
        them: 'Permission-aware search & assistant',
        kortix: 'A runtime that builds & runs agents',
      },
      {
        dimension: 'Takes real, multi-step action',
        them: 'A newer agent layer on top of search',
        kortix: 'Agents act end to end',
      },
      {
        dimension: 'Open-source and self-hostable',
        them: 'Closed — SaaS or vendor-managed cloud',
        kortix: 'Open-source — your cloud, VPC, or on-prem',
      },
      {
        dimension: 'You own it',
        them: 'You query it; you don’t own it',
        kortix: 'Yours — forkable and portable',
      },
      {
        dimension: 'Bring your own models',
        them: 'Yes — model hub',
        kortix: 'Yes — any model, your keys',
        lean: 'both',
      },
      {
        dimension: 'Everything as versioned code',
        them: 'Configured in Glean’s console',
        kortix: 'Agents, skills & policies as files in your repo',
      },
      {
        dimension: 'Access & pricing',
        them: 'Seat-priced, ~100-seat minimum, sales-led',
        kortix: 'Open-source; pay only for usage',
      },
    ],
    builtForThem:
      'Glean is the leader in permission-aware enterprise search: a knowledge graph that mirrors your source permissions, a mature catalog of connectors, a capable assistant over all of it, and serious enterprise security and compliance. If your primary need is finding and synthesizing what your company already knows, Glean is excellent at it.',
    builtForKortix:
      'Kortix is a different layer: not a place to search your knowledge, but a runtime to build and run the agents that do the work. Where Glean is closed and configured inside its console, Kortix is open-source and self-hostable, model-agnostic, and defined as code — agents, skills, connectors and policies are files in a repo you own.',
    differentiators: [
      {
        title: 'Do the work — don’t just find it.',
        body: 'Glean’s heritage is retrieval: it finds answers and assists, with an agent layer added on top. Kortix is built from the ground up to take action — agents that pull data, run analysis, work through files, and return finished output across your tools.',
      },
      {
        title: 'Own the runtime, don’t rent the index.',
        body: 'Glean is proprietary — SaaS, or a vendor-managed instance in your cloud you still don’t own. Kortix is open-source and self-hostable: run it on your cloud, VPC, or on-prem, fork it, and keep your data and agents entirely yours.',
      },
      {
        title: 'As code, not console.',
        body: 'In Glean, agents and configuration live inside Glean’s console. In Kortix, the whole company — agents, skills, memory, connectors, scoped policies — is version-controlled files you can diff, review, and roll back.',
      },
      {
        title: 'For teams of any size, not just 100-seat deals.',
        body: 'Glean is enterprise-only, sales-led, and seat-priced with a high floor. Kortix is open-source — start free, self-host, and pay only for the AI usage you run, whether you’re five people or five thousand.',
      },
    ],
    scenarios: [
      { need: 'Permission-aware search across your company knowledge', pick: 'them' },
      { need: 'Agents that take action across your tools', pick: 'kortix' },
      { need: 'Open-source, self-hosted, and owned by you', pick: 'kortix' },
      { need: 'Define agents, skills and policies as code', pick: 'kortix' },
    ],
    faqs: [
      {
        q: 'Is Kortix an enterprise search tool like Glean?',
        a: 'No — that’s the key difference. Glean is built around permission-aware search and an assistant over your knowledge. Kortix is a runtime for building and running agents that take action. They can be complementary: search finds, agents do.',
      },
      {
        q: 'Can I self-host Kortix instead of a vendor-managed cloud?',
        a: 'Yes. Kortix is open-source and runs on your own cloud, VPC, or on-prem — you own and operate it, rather than querying a vendor-managed platform.',
      },
      {
        q: 'Does Kortix let me bring my own models like Glean’s model hub?',
        a: 'Yes — Kortix is model-agnostic. Bring any provider and your own keys, and choose per agent.',
      },
      {
        q: 'Is Kortix only for large enterprises?',
        a: 'No. Glean is effectively gated to large, sales-led deals; Kortix is open-source and starts free, so teams of any size can run it.',
      },
    ],
    ctaTitle: 'Go from searching your knowledge to running the agents that do the work.',
    ctaBody:
      'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    trademark:
      'Glean is a trademark of Glean Technologies, Inc. Kortix is not affiliated with, endorsed by, or sponsored by Glean. All product names, logos, and brands are the property of their respective owners and are used here for identification and comparison only. Comparisons reflect publicly available information as of June 2026 and may change.',
  },
  {
    slug: 'tasklet',
    name: 'Tasklet',
    relation: 'direct',
    headline: 'Kortix vs Tasklet',
    sub: 'Tasklet is a slick cloud tool for always-on agents that take action — but it’s closed, cloud-only, and locked to its model stack. Kortix gives you the same autonomous agents as open, self-hostable code you own, on any model.',
    seo: {
      title: 'Kortix vs Tasklet — Cloud-only automation, or agents you own?',
      description:
        'Tasklet runs always-on agents in its cloud, on its model stack. Kortix gives you the same autonomous agents as open-source, self-hostable code — bring your own models, isolated sandboxes, everything versioned and owned by you. Compare.',
      keywords: [
        'kortix vs tasklet',
        'tasklet alternative',
        'open source tasklet alternative',
        'self-hosted ai agents',
        'ai automation you own',
      ],
      ogTitle: 'Kortix vs Tasklet',
      ogDescription:
        'Same always-on agents — but open-source, self-hostable, any model, owned by you.',
    },
    verdictThem:
      'you want a no-setup, self-serve cloud tool where always-on agents take actions across your apps, and you’re fine being cloud-only on their managed models.',
    verdictKortix:
      'you want those same autonomous agents but open-source and self-hostable — bring-your-own-models, isolated sandboxes, and agents, skills and policies versioned as code you own.',
    rows: [
      {
        dimension: 'Always-on agents that take action',
        them: 'Yes — in Tasklet’s cloud',
        kortix: 'Yes — on your infrastructure',
        lean: 'both',
      },
      {
        dimension: 'Open-source and self-hostable',
        them: 'No — cloud-only SaaS',
        kortix: 'Yes — your cloud, VPC, or on-prem',
      },
      {
        dimension: 'Your data stays with you',
        them: 'On Tasklet’s cloud',
        kortix: 'On your own infrastructure',
      },
      {
        dimension: 'Bring your own models',
        them: 'No — their managed model stack',
        kortix: 'Any model — your keys',
      },
      {
        dimension: 'Everything as versioned code',
        them: 'Built by chat in their UI',
        kortix: 'Agents, skills & policies as files in your repo',
      },
      {
        dimension: 'Isolation & per-connector policies',
        them: 'Basic access controls',
        kortix: 'Isolated microVM + allow/ask/block per tool',
      },
      {
        dimension: 'Multi-tenant — departments, roles',
        them: 'Team accounts',
        kortix: 'Multi-tenant by default',
      },
    ],
    builtForThem:
      'Tasklet nails a real insight: people want agents that own the work, not another chatbot. You describe a task in plain English and always-on agents execute it across thousands of integrations — even driving apps through a built-in computer-use browser when there’s no API. The setup is delightfully simple and the pricing is transparent and self-serve.',
    builtForKortix:
      'Kortix delivers the same autonomous, always-on agents — but as something you own. Where Tasklet is cloud-only, closed, and locked to its managed models, Kortix is open-source and self-hostable, model-agnostic, and defined as code, with isolation and governance built for running agents across a whole company.',
    differentiators: [
      {
        title: 'Own it and run it yourself.',
        body: 'Tasklet runs only in Tasklet’s cloud. Kortix is open-source and self-hostable — run it on your own cloud, VPC, or on-prem, so your agents and your data stay inside your walls.',
      },
      {
        title: 'Any model, your keys.',
        body: 'Tasklet routes to its own managed model stack with no bring-your-own option. Kortix is model-agnostic: bring any provider and your own keys, and pick per agent — better control, and often far cheaper.',
      },
      {
        title: 'Governed, and versioned as code.',
        body: 'Tasklet’s agents are built by chat and live in its managed runtime. Kortix keeps agents, skills, memory, connectors and scoped policies as versioned files, runs each task in an isolated microVM sandbox with network-egress control, and makes every change reviewable and reversible.',
      },
      {
        title: 'Built for a company, not just a team account.',
        body: 'Kortix is multi-tenant by default — real departments, users, and roles, each scoped to exactly what they should touch — so the same platform runs a five-person team or hundreds of thousands of agents in parallel.',
      },
    ],
    scenarios: [
      { need: 'Fastest no-setup cloud automation', pick: 'them' },
      { need: 'Open-source and self-hosted, owned by you', pick: 'kortix' },
      { need: 'You need to bring your own models', pick: 'kortix' },
      { need: 'Isolation, scoped policies, and audit across a company', pick: 'kortix' },
    ],
    faqs: [
      {
        q: 'Does Kortix run always-on agents like Tasklet?',
        a: 'Yes — both run autonomous, always-on agents that take real action across your tools (Kortix via cron and webhook triggers). The difference is ownership and architecture: Kortix is open-source, self-hostable, model-agnostic, and defined as code.',
      },
      {
        q: 'Can I keep my data off a third-party cloud?',
        a: 'Yes — that’s a core reason teams choose Kortix. Self-host it and your agents and data stay entirely within your own infrastructure. Tasklet is cloud-only.',
      },
      {
        q: 'Can I use my own models and keys?',
        a: 'Yes. Kortix is model-agnostic with bring-your-own-keys. Tasklet routes to its own managed model stack.',
      },
      {
        q: 'Is Kortix harder to set up than Tasklet?',
        a: 'Tasklet wins on instant, no-setup cloud convenience. Kortix asks a bit more upfront — especially self-hosting — in exchange for ownership, any-model flexibility, isolation, and governance.',
      },
    ],
    ctaTitle: 'Same always-on agents — open-source, any model, and yours to keep.',
    ctaBody:
      'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    trademark:
      'Tasklet is a trademark of its respective owner. Kortix is not affiliated with, endorsed by, or sponsored by Tasklet. All product names, logos, and brands are the property of their respective owners and are used here for identification and comparison only. Comparisons reflect publicly available information as of June 2026 and may change.',
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
