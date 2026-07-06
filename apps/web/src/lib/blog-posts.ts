import type { Block } from '@/components/blog/blog-content';
import type { CoverLogo } from '@/components/blog/blog-cover';

/**
 * The blog, as data — not MDX. Each post is metadata + an array of typed
 * `Block`s rendered by `@/components/blog/blog-content`. Add a post by adding an
 * entry here. `author` references a key in the registry in `src/lib/blog.ts`.
 */
export type BlogPostEntry = {
  slug: string;
  title: string;
  description: string;
  /** ISO date YYYY-MM-DD — drives sort order and the byline. */
  date: string;
  author: string;
  tags: string[];
  /** Cover image under /public — used for OG/social only. On-page covers are
   *  rendered from `coverLogos` (a crisp logo lockup), not this image. */
  cover?: string;
  /** Competitor logos for the on-page cover lockup. Empty → a brand-mark cover. */
  coverLogos?: CoverLogo[];
  /** Show the Kortix mark in the cover lockup (default true). */
  coverKortix?: boolean;
  /** Minutes — shown in the byline. */
  readingTime: number;
  draft?: boolean;
  blocks: Block[];
};

const introducingKortix: BlogPostEntry = {
  slug: 'introducing-kortix',
  title: 'Introducing Kortix: the AI command center for your company',
  description:
    'A workforce of AI agents that do real work across your tools — defined as files in a git repo, run in isolated sandboxes, governed by review, and built enterprise-first. Here is the whole thing, A to Z.',
  date: '2026-06-06',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Product', 'Vision'],
  readingTime: 7,
  blocks: [
    {
      type: 'lead',
      text: 'Every company is being told to "adopt AI." But most AI tools stop at the conversation. You ask a question, you get an answer, and the moment you close the tab the work is gone. That is a faster way to think. It is not a company running on AI.',
    },
    {
      type: 'p',
      text: 'Kortix is the **command center for the AI agents that do your work** — one place to build a workforce of agents, connect them to your tools, run them on your terms, and keep every result accountable to a human.',
    },
    {
      type: 'p',
      text: "Underneath that is an idea we think is right for the next decade of software: **your company's AI operation should be files in a git repo.** Not a pile of settings in someone else's dashboard — actual files you own, version, review, and run.",
    },
    { type: 'h2', text: 'A company is a git repo' },
    {
      type: 'p',
      text: 'In Kortix, a **project** is one git repository. The repo *is* the project: its files, its history, its agents, its automations, its settings — all of it lives in git. Start fresh with a private repo Kortix hosts for you, or bring an existing one on GitHub.',
    },
    {
      type: 'ul',
      items: [
        '**Every change is reviewable.** A new automation, a tweak to an agent, a newly connected tool — each is a diff someone can read and approve before it goes live.',
        '**Nothing drifts.** There is no separate database of settings to fall out of sync with reality. The repo is the truth.',
        '**It is portable and yours.** Your whole setup is plain files. Read it, fork it, move it, run it on your own infrastructure.',
      ],
    },
    {
      type: 'callout',
      text: 'A company that runs on AI shouldn’t be a black box you rent. It should be a codebase you own.',
    },
    { type: 'h2', text: 'kortix.toml: the single source of truth' },
    {
      type: 'p',
      text: 'At the root of every project sits one file — `kortix.toml` when this was written, `kortix.yaml` today. Any repo with a valid manifest at its root *is* a Kortix project — that file defines what the project is, what it’s allowed to do, and how it runs. Here’s a real one:',
    },
    {
      type: 'code',
      code: `# kortix.yaml — the one file that defines this project.
kortix_version: 2

project:
  name: acme-ops
  description: Acme's operations command center.

# Secrets your agents need: names here, encrypted values in the vault.
env:
  required: [DATABASE_URL]
  optional: [STRIPE_API_KEY]

# The sandbox every task boots into — your image, your hardware.
sandbox:
  templates:
    - slug: ops
      dockerfile: .kortix/Dockerfile
      cpu: 4
      memory: 8

# Run work on a schedule — nobody has to kick it off.
triggers:
  - slug: weekly-health-report
    type: cron
    cron: "0 0 9 * * 1"
    prompt: Draft the weekly customer health report for review.

# A tool the agent can use — credentials stay in the platform, never here.
connectors:
  - slug: slack
    policies:
      - match: "*message*"
        action: require_approval`,
    },
    {
      type: 'p',
      text: 'That’s a company’s operating setup in a few dozen lines. The scheduler reads `triggers:`, the sandbox builder reads `sandbox.templates:`, the connector layer reads `connectors:`. Edit it in the dashboard or from inside a session and changes round-trip through the same file — the diff stays clean either way.',
    },
    { type: 'h2', text: 'What happens when you hand off a task' },
    {
      type: 'p',
      text: 'Day to day, you describe a task in plain language and get a finished result back. Here’s everything that happens underneath, from the moment you hit go:',
    },
    {
      type: 'ul',
      items: [
        '**A branch is cut.** The control plane opens a **session** and cuts a fresh branch from main. Your main line is never touched directly.',
        '**The sandbox boots.** An isolated sandbox comes up from a content-addressed snapshot of your image, clones the repo, and pulls git credentials on demand — no long-lived token sits in the environment.',
        '**The agent works.** It reads and writes files, reaches your connected tools, and commits progress to the session branch.',
        '**It proposes the work.** When done, the agent opens a **change request** — a summary plus the exact diff — and hands it to you. It does not merge its own work.',
      ],
    },
    {
      type: 'p',
      text: 'The sandbox is disposable by design. When the session ends, the environment is thrown away — only committed, merged work survives. Because each session is fully isolated, any number can run at once: yours, your teammates’, and your automated ones, none stepping on each other.',
    },
    { type: 'h2', text: 'Review is the only way in' },
    {
      type: 'p',
      text: 'The change request is the heart of the trust model. It’s the **only** path for a session’s work to reach your main line — for *everything* the agent touched: new code, a new skill, an edited automation, a change to the agent’s own instructions. You see the exact diff, with conflicts flagged up front. Until you merge, the work is proposed, not applied.',
    },
    {
      type: 'callout',
      text: 'An agent can have real autonomy inside its sandbox while having zero ability to change your company without a human saying yes. That’s the combination that makes handing agents real work sane.',
    },
    { type: 'h2', text: 'Tools without handing over the keys' },
    {
      type: 'p',
      text: 'Kortix connects your agents to the apps your team already uses — Slack, Gmail, Notion, Salesforce, and thousands more. When an agent uses a connected tool, **it never holds your credentials.** Each call is brokered server-side: the platform resolves the credential, runs the call, records it, and returns the result. The key never enters the sandbox.',
    },
    {
      type: 'p',
      text: 'And you govern every action with policy — each tool can **run**, **require approval**, or be **blocked**, matched by name, so you can let an agent read freely and pause it before anything sends, posts, or pays. Every call is audited.',
    },
    { type: 'h2', text: 'Self-hostable, open, and yours' },
    {
      type: 'p',
      text: 'When AI becomes how your company gets work done, the system running it stops being a tool and becomes infrastructure. Infrastructure you don’t own can be changed, repriced, or switched off without your say. So Kortix is **open and source-available**, and you can run the entire stack on your own infrastructure — one command brings up a production-style Kortix on your own machines, and the same CLI switches between our cloud and yours.',
    },
    {
      type: 'p',
      text: 'Because it’s all open, you can read exactly how isolation, review, and credential brokering work — not trust a description. No lock-in: your projects are git repos, your config is plain files, and the platform running them is yours to host.',
    },
    { type: 'h2', text: 'It compounds' },
    {
      type: 'p',
      text: 'Because your whole setup is version-controlled files, none of it resets tomorrow. Every agent you shape, every skill you teach, every tool you connect, every bit of memory your agents carry forward accumulates in the repo and gets more capable week over week. The routine work that used to fill calendars runs quietly in the background, 24/7, and your team spends its time on the decisions that need a human.',
    },
    {
      type: 'cta',
      title: 'Open the command center and hand an agent a real task.',
      body: 'Connect your first tool and watch it come back with something you can use. Free to start, free to self-host.',
    },
  ],
};

const kortixVsClaudeCowork: BlogPostEntry = {
  slug: 'kortix-vs-claude-cowork',
  title: 'Kortix vs Claude Cowork: a desktop assistant, or a company-wide agent platform?',
  description:
    "Claude Cowork is the best agent on the desktop. But it runs one assistant per person, on Anthropic's models, with your data on their cloud. Here's where you outgrow it — and what an open, company-wide agent platform looks like.",
  date: '2026-06-29',
  author: 'marko',
  cover: '/banner.png',
  tags: ['Comparisons', 'Agents'],
  coverLogos: [{ domain: 'claude.ai', name: 'Claude Cowork' }],
  readingTime: 4,
  blocks: [
    {
      type: 'lead',
      text: "Claude Cowork is, hands down, one of the best agents you can put on a desktop today. It inherits Claude Code's engine, genuinely does multi-step work across your files and apps, and has a clean approval model. So this isn't a \"they're bad, we're good\" post. The honest question is what happens when one person's desktop assistant has to become a whole company's way of working.",
    },
    {
      type: 'logos',
      label: 'Compared here:',
      items: [{ domain: 'anthropic.com', name: 'Claude Cowork' }],
    },
    { type: 'h2', text: 'What Claude Cowork is great at' },
    {
      type: 'ul',
      items: [
        '**It does the work, not just the talking** — give it a goal and it returns a finished deliverable.',
        '**A real permission model** — it shows a plan and waits for approval on consequential actions.',
        '**Extensible with plugins** — teach it how you like work done and expose your own tools.',
      ],
    },
    { type: 'h2', text: 'Where it stops: one assistant, one machine, one lab' },
    {
      type: 'ul',
      items: [
        '**One assistant per person** — not a fleet of agents running long jobs in parallel for the org.',
        '**Nothing is shared.** Each person’s agents, skills, and context live on their own desktop — what one person teaches, the company never gets.',
        '**Locked to Anthropic’s models** — no bring-your-own-key, so you pay frontier prices and can’t pick a cheaper model.',
        '**Closed and vendor-hosted** — you can’t self-host it, and your data flows to Anthropic’s cloud.',
      ],
    },
    {
      type: 'p',
      text: 'None of these are flaws for the product Cowork is. They’re exactly why it’s so good for one person — and exactly what you outgrow when "an agent on my laptop" needs to become "agents running our company."',
    },
    { type: 'h2', text: 'Shared across the company vs. siloed on a desktop' },
    {
      type: 'p',
      text: 'It’s not just the machine that’s landlocked — it’s the knowledge. In Cowork, each person’s agents, skills, and context stay on their own desktop. In Kortix, your agents, skills, and memory are **files in one shared repo**: what one person teaches, every teammate — and every agent — gets, and it compounds over time instead of resetting person by person.',
    },
    { type: 'h2', text: 'The model lock-in tax' },
    {
      type: 'p',
      text: 'Cowork only runs on Anthropic’s models, at Anthropic’s prices. Kortix lets you **bring your own key and run any model** — and the savings aren’t small. An open-weight model like **GLM-5.2** runs about **5–7× cheaper** than Claude Opus or GPT on output ($4.40 vs $25–30 per 1M tokens), and models like **DeepSeek** are **50×+ cheaper** on output. Route a cheap model for the bulk of the work and a frontier model only where it earns its keep.',
    },
    {
      type: 'callout',
      text: 'Same agents, a fraction of the bill — and you can run them on your own infrastructure, even your own GPUs, with your data never leaving your walls.',
    },
    { type: 'h2', text: 'Side by side' },
    {
      type: 'compare',
      them: 'Claude Cowork',
      rows: [
        {
          dimension: 'Does real, multi-step work',
          them: 'Yes — on your desktop',
          kortix: 'Yes — in the cloud, at scale',
          lean: 'both',
        },
        {
          dimension: 'Runs a fleet of agents in parallel',
          them: 'One assistant per person',
          kortix: 'Thousands of agents in parallel',
        },
        {
          dimension: 'Choose your models',
          them: 'Anthropic (Claude) only',
          kortix: 'Any model — your keys',
        },
        {
          dimension: 'Model cost (per 1M output)',
          them: '~$25–30 — frontier only',
          kortix: '~$4.40 (GLM-5.2) to ~$0.30 (DeepSeek)',
        },
        {
          dimension: 'Agents, skills & memory shared org-wide',
          them: 'Siloed on each desktop',
          kortix: 'Shared in one repo',
        },
        {
          dimension: 'Open-source & self-hostable',
          them: 'No — closed, via Anthropic',
          kortix: 'Yes — your cloud, VPC, on-prem',
        },
        {
          dimension: 'Your data stays with you',
          them: "Processed by Anthropic's cloud",
          kortix: 'On your own infrastructure',
        },
        {
          dimension: 'Multi-tenant — departments, roles',
          them: 'A per-user desktop app',
          kortix: 'Multi-tenant by default',
        },
        {
          dimension: 'Everything as versioned code',
          them: 'Plugins customize one assistant',
          kortix: 'Agents, skills & policies as files',
        },
      ],
    },
    { type: 'h2', text: 'When to pick which' },
    {
      type: 'verdict',
      themLabel: 'Claude Cowork',
      them: 'you want a brilliant agent on one person’s desktop, you’re happy on Anthropic’s models, and you don’t need to self-host or run a fleet.',
      kortix:
        'you want that same do-the-work power as a company platform — many agents across departments, any model, self-hosted, with everything versioned and owned by you.',
    },
    {
      type: 'p',
      text: 'They can even coexist: a power user keeps Cowork on their desktop while the company runs its shared, governed workforce on Kortix.',
    },
    {
      type: 'cta',
      title: 'Love agents that do the work? Run a whole fleet — on your own terms.',
      body: 'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    },
  ],
};

const personalAgentsVsCompanyOs: BlogPostEntry = {
  slug: 'personal-ai-agents-vs-company-os',
  title: 'Personal AI agents vs a company OS: Kortix, OpenClaw, and Hermes',
  description:
    'OpenClaw and Hermes are brilliant open-source personal agents — and we genuinely recommend them for individuals. But a personal "Jarvis" and a governed company platform are different things. Here is exactly where the line is.',
  date: '2026-06-28',
  author: 'team',
  cover: '/banner.png',
  tags: ['Comparisons', 'Open Source'],
  coverLogos: [
    { domain: 'github.com', name: 'OpenClaw' },
    { domain: 'nousresearch.com', name: 'Hermes' },
  ],
  readingTime: 4,
  blocks: [
    {
      type: 'lead',
      text: 'If you’ve spent time in open-source AI lately, you’ve met **OpenClaw** and **Hermes**. Both are excellent: open-source, self-hosted, bring-your-own-model, living in the chat apps you already use. For an individual who wants a private, always-on agent on their own machine, they’re a joy — we mean that as a compliment.',
    },
    {
      type: 'logos',
      label: 'Compared here:',
      items: [
        { domain: 'github.com', name: 'OpenClaw' },
        { domain: 'nousresearch.com', name: 'Hermes' },
      ],
    },
    {
      type: 'p',
      text: 'They share Kortix’s core values: open, self-hosted, your models, your data. So why build Kortix? Because a **personal agent** and a **company operating system** are different problems — and stretching one into the other is where it gets painful.',
    },
    { type: 'h2', text: 'Single-operator is a design choice, not a gap' },
    {
      type: 'ul',
      items: [
        '**OpenClaw** is explicit that it’s a personal assistant, not a shared multi-tenant system — and by default its tools run with broad access to the host machine. Fine on *your* laptop; a serious problem the moment several employees can steer a tool-enabled agent.',
        '**Hermes** is a beautiful "agent that grows with you" — but team roles, tenant isolation, and org-wide audit aren’t what it’s documented for. You’d assemble that yourself.',
      ],
    },
    {
      type: 'p',
      text: 'Neither is wrong. They optimized for the person. A company has to optimize for **many people, least privilege, and accountability** — and that changes the architecture from the ground up.',
    },
    { type: 'h2', text: 'Side by side' },
    {
      type: 'compare',
      them: 'OpenClaw / Hermes',
      rows: [
        {
          dimension: 'Open-source & self-hosted',
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
          dimension: 'Multi-tenant — departments, roles',
          them: 'Single operator',
          kortix: 'Multi-tenant by default',
        },
        {
          dimension: 'Scoped policies per connector',
          them: 'Largely DIY; broad access',
          kortix: 'Allow / ask / block per tool, as code',
        },
        {
          dimension: 'Isolated sandbox per task',
          them: 'Optional / personal',
          kortix: 'microVM per session, egress-controlled',
        },
        {
          dimension: 'Versioned, auditable, reversible',
          them: 'Limited',
          kortix: 'Git-backed — full history',
        },
      ],
    },
    { type: 'h2', text: 'When to pick which' },
    {
      type: 'verdict',
      themLabel: 'OpenClaw or Hermes',
      them: 'you want a private, always-on agent for *yourself*, on your own machine.',
      kortix:
        'you want agents running across a *team or company* — with scoped control, isolation, roles, and audit — without giving up open-source and self-hosting.',
    },
    {
      type: 'cta',
      title: 'Love a great open-source agent? Get one built for your whole company.',
      body: 'Same freedom, built for more than one person. Free to start, free to self-host.',
    },
  ],
};

const beyondTheChatBox: BlogPostEntry = {
  slug: 'beyond-the-chat-box',
  title: "Beyond the chat box: why ChatGPT, Claude, and Grok aren't an AI workforce",
  description:
    'Chat assistants answer; a workforce does the work. Why input-output tools — however brilliant — aren’t the same as a fleet of agents that run your company, own the data, and run on any model.',
  date: '2026-06-27',
  author: 'team',
  cover: '/banner.png',
  tags: ['Comparisons', 'Vision'],
  coverLogos: [
    { domain: 'chatgpt.com', name: 'ChatGPT' },
    { domain: 'claude.ai', name: 'Claude' },
    { domain: 'x.ai', name: 'Grok' },
  ],
  readingTime: 3,
  blocks: [
    {
      type: 'lead',
      text: 'ChatGPT, Claude, and Grok are extraordinary, and you should keep using them. But it’s worth being precise about what they are: **chat assistants.** You give an input, you get an output, and the moment you close the tab, the work is yours to carry out. That’s a faster way to *think*. It isn’t a company *running* on AI.',
    },
    {
      type: 'logos',
      label: 'Compared here:',
      items: [
        { domain: 'openai.com', name: 'ChatGPT' },
        { domain: 'anthropic.com', name: 'Claude' },
        { domain: 'x.ai', name: 'Grok' },
      ],
    },
    { type: 'h2', text: 'Input → output vs. hand-off → finished work' },
    {
      type: 'p',
      text: 'With a chat assistant, you’re the runtime: you ask, it answers, and you copy-paste between the chat window and your real tools to get anything done. With Kortix, you hand off a task and an agent **goes and does it** — 30+ minutes of real, multi-step work across your connected tools, with full context on your company, returning a finished deliverable for review.',
    },
    { type: 'h2', text: 'The differences that matter at company scale' },
    {
      type: 'compare',
      them: 'Chat assistants',
      rows: [
        {
          dimension: 'Finishes multi-step work end to end',
          them: 'Mostly answers; agent modes are supervised',
          kortix: 'Agents act across your tools, end to end',
        },
        {
          dimension: 'Runs a fleet in parallel',
          them: 'One supervised session',
          kortix: 'Thousands of isolated agents at once',
        },
        {
          dimension: 'Choose your models',
          them: "Locked to the vendor's models",
          kortix: 'Any model — your keys',
        },
        {
          dimension: 'Run cheaper models',
          them: 'Pay the vendor’s frontier price',
          kortix: 'GLM-5.2 ~5–7× cheaper; DeepSeek ~50×+',
        },
        {
          dimension: 'Own your data / self-host',
          them: "On the vendor's cloud",
          kortix: 'Open-source — your infrastructure',
        },
        {
          dimension: 'Company-wide memory',
          them: 'Per-user chat history',
          kortix: 'A shared, Git-backed brain',
        },
        {
          dimension: 'No lock-in',
          them: "Tied to one vendor's platform",
          kortix: 'Files in a repo you own',
        },
      ],
    },
    { type: 'h2', text: 'They’re complementary, not interchangeable' },
    {
      type: 'p',
      text: 'This isn’t "stop using ChatGPT." Use a chat assistant for quick answers, drafting, and thinking out loud. Use Kortix for the work that has to actually get done — repeatedly, across your tools, owned by you, running while you sleep. One is a brilliant place to ask. The other is where your company’s work runs.',
    },
    {
      type: 'cta',
      title: 'Go from asking questions to running the work.',
      body: 'Hand a Kortix agent a real task and get a finished result back. Free to start, free to self-host.',
    },
  ],
};

export const BLOG_POSTS: BlogPostEntry[] = [
  kortixVsClaudeCowork,
  personalAgentsVsCompanyOs,
  beyondTheChatBox,
  introducingKortix,
];
