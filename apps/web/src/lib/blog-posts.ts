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
      text: 'A company that runs on AI shouldn’t be a dashboard you rent and can’t inspect. It should be a codebase you own.',
    },
    { type: 'h2', text: 'kortix.yaml: the single source of truth' },
    {
      type: 'p',
      text: 'At the root of every project sits one file: `kortix.yaml`. Any repo with a valid manifest at its root *is* a Kortix project — that file defines what the project is, what it’s allowed to do, and how it runs. Here’s a real one:',
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
      text: 'When AI becomes how your company gets work done, the system running it stops being a tool and becomes infrastructure. Infrastructure you don’t own can be changed, repriced, or switched off without your say. So Kortix is **open-source and self-hostable**, and you can run the entire stack on your own infrastructure — one command brings up a production-style Kortix on your own machines, and the same CLI switches between our cloud and yours.',
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

const secureAiAgentToolAccess: BlogPostEntry = {
  slug: 'secure-ai-agent-tool-access',
  title: 'How to give AI agents tool access safely',
  description:
    'How to give AI agents production tool access without raw API keys: scoped connectors, approval policies, server-side credentials, and reviewed work.',
  date: '2026-07-07',
  author: 'team',
  cover: '/banner.png',
  tags: ['Security', 'Connectors', 'Enterprise'],
  readingTime: 7,
  blocks: [
    {
      type: 'lead',
      text: 'The moment an AI agent can use tools, it stops being a chat feature and becomes production infrastructure. It can read customer records, draft emails, open pull requests, query billing, post in Slack, or touch an internal API. At that point the hard question is not “can the model call the tool?” It is **who gave it access, how narrow is that access, what happens before a risky action runs, and what audit trail remains afterward?**',
    },
    {
      type: 'p',
      text: 'Kortix was built around that boundary. Tool access does not belong in a prompt and raw credentials do not belong in an agent sandbox. In Kortix, connections are part of the project operating layer: declared as files, brokered server-side, granted per agent, governed by policy, and reviewed when durable work changes the company. If you want the larger architecture first, read [Introducing Kortix](/blog/introducing-kortix) or the [company OS post](/blog/ai-transformation-company-os).',
    },
    {
      type: 'p',
      text: 'The rest of the market is converging on the same lesson. [Auth0](https://auth0.com/blog/api-key-security-for-ai-agents) calls out over-privileged tokens, prompt-injection exposure, and missing audit trails as common risks when teams hand API keys to agents. [WorkOS](https://workos.com/blog/ai-agent-credentials) argues agents need their own scoped, revocable credentials instead of borrowing a user’s full session. [Promptfoo’s OWASP Agentic AI summary](https://www.promptfoo.dev/docs/red-team/owasp-agentic-ai) lists Tool Misuse and Identity and Privilege Abuse as core agentic risks. The pattern is clear: agent security is mostly tool security.',
    },
    { type: 'h2', text: 'Chat is harmless until it touches systems' },
    {
      type: 'p',
      text: 'A model drafting text in a window has a small blast radius. A model with connected tools has the blast radius of those tools. That is not a reason to keep agents powerless; powerless agents do not run companies. It is a reason to treat the connector layer as seriously as you treat IAM, secrets, and production deploys.',
    },
    {
      type: 'ul',
      items: [
        '**A support agent** may need to read tickets and invoices, but should not be able to refund money without approval.',
        '**A finance agent** may need to pull Stripe, bank, and warehouse data, but should not be able to send vendor payments from the same path.',
        '**A recruiting agent** may need to enrich candidates and draft outreach, but should not send messages without a human approving the final copy.',
        '**An engineering agent** may need GitHub, Linear, CI, and preview access, but should land work through a reviewed change request instead of mutating main directly.',
      ],
    },
    {
      type: 'callout',
      text: 'The control plane cannot be “the prompt told the agent to be careful.” The control plane has to be outside the model.',
    },
    { type: 'h2', text: 'The five rules of safe tool access' },
    {
      type: 'p',
      text: 'A production agent platform needs five layers before you can comfortably connect real company systems:',
    },
    {
      type: 'ul',
      items: [
        '**Keep credentials out of the sandbox.** The agent should never receive a third-party API key unless the task truly requires direct process-level access. Connector credentials should be resolved server-side and injected into the upstream request, not into model context.',
        '**Grant tools per agent.** Connecting Slack, Gmail, Stripe, or GitHub to a project is not the same as letting every agent call it. The support agent and release agent need different reach.',
        '**Gate individual actions.** Read operations, write operations, deletes, sends, payments, and admin changes should not share one permission bit. Tool names need policy: always run, require approval, or block.',
        '**Make risky calls human-reviewable.** A good agent can prepare the exact action and evidence. The platform should pause at the boundary where a human decision is required.',
        '**Route durable change through review.** If the agent edits the operating layer — agents, skills, triggers, memory, policies, or code — that work should be a diff someone can review, merge, and roll back.',
      ],
    },
    { type: 'h2', text: 'How Kortix models a connector' },
    {
      type: 'p',
      text: 'Kortix connections are documented in [Connecting your tools](/docs/guides/connecting-tools). A connector can be a one-click Pipedream app, a remote MCP server, an OpenAPI or GraphQL API, a raw HTTP API, a channel such as Slack, or a connected computer. The definition lives with the project; the credential lives on the platform. The agent sees a tool catalog, not a pile of secrets.',
    },
    {
      type: 'code',
      code: `connectors:
  - slug: stripe
    provider: openapi
    spec: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
    policies:
      - match: "*.get*"
        action: always_run
      - match: "*.create*"
        action: require_approval
      - match: "*.delete*"
        action: block

agents:
  support:
    connectors: [plain, stripe]
    secrets: none
    kortix_cli: none

  release-bot:
    connectors: [github, vercel]
    kortix_cli: [project.cr.open]`,
    },
    {
      type: 'p',
      text: 'That example is deliberately boring. Boring is the point. You should be able to answer “what can this agent call?” by reading the project files, not by reverse-engineering a prompt or inspecting a live process. The [manifest reference](/docs/reference/manifest#connectors--connectors) defines connector policies and the [agent governance section](/docs/reference/manifest#agents-v2) defines per-agent grants.',
    },
    { type: 'h2', text: 'Server-side credentials change the failure mode' },
    {
      type: 'p',
      text: 'When credentials sit in environment variables inside the agent runtime, every prompt-injection bug, logging bug, file-read bug, and subprocess bug becomes a possible credential leak. When credentials are brokered server-side, the agent can ask to call a tool, but the platform decides whether the call is allowed, resolves the credential, executes the upstream request, and records what happened.',
    },
    {
      type: 'p',
      text: 'That is the model behind the Kortix Executor. Every session gets a scoped Executor token. The agent discovers tools, describes their schemas, and calls them through the Kortix API. The gateway enforces the project grant and connector policy, resolves credentials outside the sandbox, runs the request, and audits the call. The [connections guide](/docs/guides/connecting-tools) is explicit: the agent never holds third-party credentials.',
    },
    {
      type: 'callout',
      text: 'A scoped tool token is not just safer than a raw API key. It also makes the audit trail meaningful: agent identity, tool name, input boundary, policy decision, approval state, and upstream result can all be tied together.',
    },
    { type: 'h2', text: 'The dangerous pattern to delete' },
    {
      type: 'p',
      text: 'The common early pattern is understandable: put `STRIPE_SECRET_KEY`, `GITHUB_TOKEN`, `SLACK_BOT_TOKEN`, and a dozen other keys into `.env`, start the agent, and hope the prompt keeps it in bounds. That works for a demo. It is the wrong shape for a company.',
    },
    {
      type: 'ul',
      items: [
        '**It is too broad.** The key usually carries every permission the integration owner had, not the minimum action the agent needs.',
        '**It is hard to attribute.** Downstream systems see the shared key, not the agent, session, person, or approval that caused the call.',
        '**It is hard to revoke safely.** Rotating a shared key breaks every workflow using it; leaving it in place keeps the blast radius large.',
        '**It hides policy in code and prompts.** Security reviewers need declarative grants and logs, not “the agent instructions say don’t delete things.”',
      ],
    },
    { type: 'h2', text: 'A quick audit for your agent stack' },
    {
      type: 'p',
      text: 'Before you connect agents to production systems, ask these questions:',
    },
    {
      type: 'ul',
      items: [
        'Can I list every external system this agent can reach without opening the agent prompt?',
        'Can I give a sales agent CRM read access without also giving it billing write access?',
        'Can I block deletes, require approval for sends, and allow safe reads on the same connector?',
        'Can I see which person, agent, session, and policy decision caused a tool call?',
        'Can I revoke one agent’s reach without rotating a shared key that breaks other workflows?',
        'Can the operating layer move from cloud to VPC or on-prem without rewriting the tool model?',
      ],
    },
    {
      type: 'p',
      text: 'If the answer is no, you may still have a useful agent prototype. You do not yet have a secure AI command center.',
    },
    { type: 'h2', text: 'Why this is a company OS problem' },
    {
      type: 'p',
      text: 'Safe tool access is not a standalone feature. It only works when it sits beside the rest of the company operating layer: memory, agents, skills, triggers, secrets, policies, sandboxes, and change requests. The connector grant says what the agent may touch. The sandbox limits where it runs. The policy gate decides which calls need approval. The change request records durable changes as a diff. The repo keeps the whole thing owned and reviewable.',
    },
    {
      type: 'p',
      text: 'That is why Kortix frames the product as an Autonomous Company Operating System, not another assistant with more integrations. A company does not need one more place to paste keys. It needs a Git-backed AI command center where the tools, credentials, policies, and agent work are part of the same owned system.',
    },
    {
      type: 'cta',
      title: 'Connect the tools, keep the keys out of the agent.',
      body: 'Start with one workflow, grant only the connectors it needs, gate risky actions, and run the work from a repo your company owns.',
    },
  ],
};

const aiTransformationCompanyOs: BlogPostEntry = {
  slug: 'ai-transformation-company-os',
  title: 'AI transformation needs a company OS',
  description:
    'Why consultancies and AI-transformation teams need one Git-backed workspace for agents, memory, connectors, policy, and auditable work.',
  date: '2026-06-29',
  author: 'team',
  cover: '/banner.png',
  tags: ['Enterprise', 'AI Transformation', 'Company OS'],
  readingTime: 6,
  blocks: [
    {
      type: 'lead',
      text: 'AI transformation is past the demo phase. The hard part now is not proving that an agent can draft a report, inspect a spreadsheet, or update a CRM record. The hard part is giving every client, department, and delivery team a **repeatable operating layer** where agents, context, connectors, policy, and review live together. That is what a company OS is for.',
    },
    {
      type: 'p',
      text: 'Kortix is the **Autonomous Company Operating System**: an AI command center where a workforce of agents does real work, and everything that defines the system is files in one Git repo you own. For consultancies and AI-transformation teams, that matters because the deliverable is no longer a single chatbot. The deliverable is a governed workspace the client can keep running after the pilot. If you want the full product spine first, read [Introducing Kortix](/blog/introducing-kortix).',
    },
    {
      type: 'p',
      text: 'The market is already pointing this way. [Accenture AI Refinery](https://www.accenture.com/us-en/services/ai-data/ai-refinery) frames enterprise AI around agents, knowledge, models, and governance. [Deloitte](https://www.deloitte.com/in/en/services/consulting/services/engineering-ai-data/agentic-ai.html) describes multiagent systems that understand requests, plan workflows, coordinate role-specific agents, collaborate with humans, and validate outputs. The missing question is where all of that lives so it can be owned, reviewed, repeated, and ported into the tools people already use.',
    },
    { type: 'h2', text: 'The pilot is not the product' },
    {
      type: 'p',
      text: 'Most AI-transformation work starts with a useful prototype: a support agent, a sales-research assistant, a finance close helper, a legal intake workflow, a marketing campaign planner. The prototype proves demand. Then the real work starts.',
    },
    {
      type: 'ul',
      items: [
        '**Who owns the instructions?** If the prompt lives in one vendor dashboard, the client cannot audit or improve it like normal operational IP.',
        '**Where does the context accumulate?** If every tool stores a different slice of memory, the organization never gets one shared brain.',
        '**How are tools governed?** Reading a CRM, sending an email, querying Stripe, and posting in Slack should not have the same permission profile.',
        '**How does the work become official?** A finished deliverable needs review, history, rollback, and a clear path into the client’s source of truth.',
        '**How do you repeat it for the next department?** The second workspace should be a fork, not a rebuild.',
      ],
    },
    {
      type: 'p',
      text: 'A proof of concept can avoid those questions. A production AI-transformation program cannot. The operating layer becomes the product because it decides whether the client gets a one-off demo or a system that keeps improving.',
    },
    { type: 'h2', text: 'One client, one repo' },
    {
      type: 'p',
      text: 'In Kortix, a project is a repo. That repo contains the company’s agents, skills, memory, triggers, connector policy, sandbox definition, and operating instructions. One `kortix.yaml` defines how the workspace runs. Every session happens on an isolated branch. Every persistent change comes back through a change request.',
    },
    {
      type: 'code',
      code: `acme-ai-workspace/
├─ kortix.yaml              # project, sandboxes, triggers, connectors, policy
├─ .kortix/opencode/
│  ├─ agents/               # role-specific agents: finance, support, sales, legal
│  ├─ skills/               # repeatable client playbooks and workflows
│  └─ commands/             # approved operating motions
├─ memory/                  # durable company context and decisions
├─ artifacts/               # reports, briefs, packets, launch plans
└─ docs/                    # source-of-truth operating docs`,
    },
    {
      type: 'p',
      text: 'That sounds technical because it is. It is also the reason the workspace can be handed to a client without trapping them in your service team forever. Files can be inspected. Diffs can be reviewed. A successful sales-ops workspace can be forked into a recruiting workspace. A regulated client can run the same pattern in their own VPC or on-prem environment. The [docs](/docs) walk through the project, session, and change request model in detail.',
    },
    { type: 'h2', text: 'The workspace needs five layers' },
    {
      type: 'p',
      text: 'If you are leading AI transformation for a client, a serious agent workspace needs more than a chat UI. It needs at least five layers working together:',
    },
    {
      type: 'ul',
      items: [
        '**Context.** The policies, playbooks, decisions, customer notes, docs, and memory the agents need to act like part of the company.',
        '**Agents and skills.** Named roles and reusable workflows, not one giant prompt that tries to do everything.',
        '**Connectors.** Access to the real systems of work — Slack, Gmail, HubSpot, Stripe, Linear, Notion, warehouses, internal APIs — brokered through scoped credentials instead of pasted keys.',
        '**Policy.** Tool-level allow, ask, and block rules so a workspace can automate research freely and still pause before it sends, pays, deletes, or posts.',
        '**Review.** A change request path for durable work: what changed, who requested it, what the agent touched, and what a human approved.',
      ],
    },
    {
      type: 'callout',
      text: 'The unit of delivery is not “an agent.” The unit of delivery is a governed workspace where many agents can do real work safely.',
    },
    { type: 'h2', text: 'Governance belongs in the runtime' },
    {
      type: 'p',
      text: 'Enterprise buyers do not just ask whether the model is good. They ask where secrets live, how access is scoped, what gets logged, how approvals work, how quickly a bad change can be reverted, and whether the system can run under their infrastructure constraints.',
    },
    {
      type: 'p',
      text: 'Kortix was built around those constraints. Sessions run in disposable Linux sandboxes on their own branches. Connectors are brokered server-side through one scoped token. Secrets are encrypted and injected at runtime, not shown to the model. Work reaches `main` only through reviewed change requests. The same workspace can be used from the web, Slack, Teams, CLI, API, and MCP surfaces instead of forcing every employee into a new destination app.',
    },
    {
      type: 'p',
      text: 'That is the difference between “we connected an LLM to your tools” and “we gave your organization a controlled workforce.” The first is exciting in a workshop. The second survives procurement, security review, and the third month of production use.',
    },
    { type: 'h2', text: 'Why consultancies feel this first' },
    {
      type: 'p',
      text: 'Consultancies and systems integrators are where the repeatability pressure shows up fastest. They do not need one beautiful demo. They need a way to deploy the same architecture across many clients, many departments, and many compliance profiles without rebuilding the plumbing every time.',
    },
    {
      type: 'ul',
      items: [
        '**For the AI-transformation partner:** one horizontal platform can become the delivery substrate for many vertical offerings.',
        '**For the client CTO:** the workspace is Git-backed, self-hostable, and inspectable instead of a vendor-owned service wrapper.',
        '**For the delivery team:** each department gets its own agents, memory, connectors, and policies without losing the shared pattern.',
        '**For the end user:** the agent shows up where they already work — Slack, Teams, web, CLI, API — instead of asking the 99% of employees to adopt another AI portal.',
      ],
    },
    {
      type: 'p',
      text: 'This is also where open matters. A consultancy cannot credibly tell a bank, manufacturer, or healthcare company that their future operating layer is a closed prompt stack nobody can inspect. The closer agents get to real work, the more the client needs to own the substrate. That is why Kortix is open, self-hostable, and built for enterprise deployment from the start.',
    },
    { type: 'h2', text: 'What to build first' },
    {
      type: 'p',
      text: 'The best first workspace is narrow enough to ship and important enough to prove the operating model. Pick one workflow where the client already has documents, tools, approvals, and recurring pain. Then encode it as files.',
    },
    {
      type: 'ul',
      items: [
        '**Sales renewal workspace:** read CRM context, summarize account risk, draft renewal plans, open human-reviewed follow-ups.',
        '**Support triage workspace:** monitor tickets, classify urgency, draft replies from docs, escalate edge cases with evidence.',
        '**Finance close workspace:** pull reconciliations, produce variance notes, flag missing evidence, create the close packet for review.',
        '**Recruiting workspace:** source candidates, enrich profiles, draft Marko-style outreach, log every touch, never send without approval.',
        '**Engineering review workspace:** review PRs, run checks, verify previews, and return concrete blockers instead of vague comments.',
      ],
    },
    {
      type: 'p',
      text: 'Those are not abstract use cases for us. Kortix runs internal sweeps for production errors, PR review, docs maintenance, weekly briefs, outbound research, and this SEO/blog loop from the same project-native model: agents with skills, memory, tools, triggers, and a reviewed path for durable changes.',
    },
    { type: 'h2', text: 'A quick test for your stack' },
    {
      type: 'p',
      text: 'Before you choose an AI-transformation platform, ask five questions:',
    },
    {
      type: 'ul',
      items: [
        'Can the client clone or export the actual operating layer — agents, skills, memory, policy, and triggers — as files?',
        'Can two hundred agents run in parallel without sharing one fragile machine or one user’s desktop state?',
        'Can tool access be scoped per person, group, agent, and action?',
        'Can a security reviewer see what happened after the fact: prompts, tool calls, commits, approvals, and diffs?',
        'Can the same workspace move from cloud to VPC to on-prem without changing the basic model?',
      ],
    },
    {
      type: 'p',
      text: 'If the answer is no, you may still have a good agent demo. You do not yet have a company OS.',
    },
    {
      type: 'cta',
      title: 'Build the client workspace as files, then run it with agents.',
      body: 'Start with one department, connect the tools it already uses, and turn the workflow into a Git-backed AI command center the client can own.',
    },
  ],
};

const kortixVsGlean: BlogPostEntry = {
  slug: 'kortix-vs-glean',
  title: 'Kortix vs Glean: search or an agent platform that runs work?',
  description:
    "Glean is the best permission-aware enterprise search. But search finds work — it doesn't do it. Here's where you outgrow it, and the open runtime alternative.",
  date: '2026-07-13',
  author: 'team',
  cover: '/banner.png',
  tags: ['Comparisons', 'Enterprise', 'Open Source'],
  coverLogos: [{ domain: 'glean.com', name: 'Glean' }],
  readingTime: 5,
  blocks: [
    {
      type: 'lead',
      text: "Glean is genuinely the best permission-aware enterprise search you can buy. It indexes your apps, respects your ACLs, and answers in plain language with citations. So this isn't a \"they're bad, we're good\" post. The honest question is a different one: once you can find anything in your company, what actually does the work with it?",
    },
    {
      type: 'logos',
      label: 'Compared here:',
      items: [{ domain: 'glean.com', name: 'Glean' }],
    },
    { type: 'h2', text: 'What Glean is great at' },
    {
      type: 'ul',
      items: [
        '**Permission-aware search done right** — it inherits your source-system ACLs, so a result you can see is a result you can act on.',
        '**Mature connectors** — it reaches across the usual enterprise stack and keeps the index fresh.',
        '**Serious compliance posture** — built for the security review that enterprise search has to survive.',
        '**A clean assistant on top of retrieval** — ask a question, get a cited answer instead of ten blue links.',
      ],
    },
    { type: 'h2', text: 'Where it stops: search finds work, it doesn’t do it' },
    {
      type: 'p',
      text: 'Glean’s center of gravity is the index. Agents are a layer on top of retrieval, not a workforce that runs your company. The moment the job is “open the tickets, enrich the accounts, draft and send the outreach, land the fix, close the book” — search has stopped being the bottleneck and a chat assistant over the index isn’t the answer either. You need a runtime that hands a task to agents and they return finished work.',
    },
    {
      type: 'ul',
      items: [
        '**Retrieval-first, agents bolted on.** The product answers “where is it?” well; it is not built to run a fleet of agents that take real actions across your tools.',
        '**Closed and vendor-hosted.** You query Glean; you don’t own it. It is SaaS or vendor-managed cloud — your company’s knowledge leaves your walls to be indexed somewhere else.',
        '**Seat-priced and sales-led.** Public reporting puts Glean at roughly [$50–75 per user/month with a ~100-seat minimum](https://www.gosearch.ai/faqs/glean-enterprise-search-pricing-explained-costs-tiers-hidden-fees-gosearch-comparison) — about a $60k/year floor before infrastructure and implementation. That locks out the small team and the single-department pilot.',
        '**Configured in a console, not as code.** Connectors, assistants, and prompts live in a vendor dashboard. There is no diff to review, no version to roll back, no repo to fork.',
      ],
    },
    {
      type: 'p',
      text: 'None of that is a flaw in a search product. It is exactly the line you cross when “let me find it” becomes “let something do it.” If you want the broader framing, [beyond the chat box](/blog/beyond-the-chat-box) makes the same argument against chat assistants: input→output stops short of work.',
    },
    { type: 'h2', text: 'A runtime that does the work, not just retrieves it' },
    {
      type: 'p',
      text: 'Kortix is an open agent runtime — the command center where a workforce of agents runs your company, not a search bar over it. Hand a task to a project and agents run in isolated sandboxes, take real actions through scoped connectors, and land durable change back to one shared `main` through a reviewed change request. The context they need is files in a repo you own, not an index someone else rents back to you.',
    },
    {
      type: 'p',
      text: 'That is the real split. Glean makes your existing knowledge searchable; Kortix makes your company’s operating layer — agents, skills, memory, connectors, policies — into [files in one repo](/blog/introducing-kortix) that agents run against. One is a window onto work; the other is where the work happens.',
    },
    { type: 'h2', text: 'Own the data, pick the model, skip the seat tax' },
    {
      type: 'p',
      text: 'Because Kortix is open-source and self-hostable, your data never has to leave your walls — your cloud, your VPC, on-prem, or your own GPUs. And because you bring your own key and run any model, the bill is not bundled into a per-seat license. An open-weight model like **GLM-5.2** runs about **5–7× cheaper** than Claude Opus or GPT on output (~$4.40 vs $25–30 per 1M tokens), and **DeepSeek** is **50×+ cheaper** on output. Route a cheap model for the bulk of the work and a frontier model only where it earns its keep.',
    },
    {
      type: 'callout',
      text: 'No 100-seat floor, no sales process to start. Open-source means you can run one project today and a whole company on it tomorrow — on infrastructure where the data, config, and model belong to you.',
    },
    { type: 'h2', text: 'Side by side' },
    {
      type: 'compare',
      them: 'Glean',
      rows: [
        {
          dimension: 'Core job',
          them: 'Find & answer over company data',
          kortix: 'Build & run agents that do the work',
        },
        {
          dimension: 'Runs a fleet of agents in parallel',
          them: 'Assistants bolted onto search',
          kortix: 'Thousands of agents, isolated sandboxes',
        },
        {
          dimension: 'Self-hostable / own your data',
          them: 'No — SaaS or vendor-managed cloud',
          kortix: 'Yes — your cloud, VPC, on-prem',
        },
        {
          dimension: 'Choose your models',
          them: 'Vendor-managed, bundled in seat',
          kortix: 'Any model — your keys',
        },
        {
          dimension: 'Pricing model',
          them: '~$50–75/user/mo, ~100-seat min',
          kortix: 'Open-source; cloud or self-host, any size',
        },
        {
          dimension: 'Accessible below 100 seats',
          them: 'No — sales-led, large-enterprise floor',
          kortix: 'Yes — start with one project',
        },
        {
          dimension: 'Agents, skills & policies as code',
          them: 'Configured in a vendor console',
          kortix: 'Files in one repo you own',
        },
        {
          dimension: 'Versioned, reviewable, roll-back-able',
          them: 'Console settings, no diff',
          kortix: 'Git history + change requests',
        },
        {
          dimension: 'Multi-tenant governance',
          them: 'Enterprise permissions on search',
          kortix: 'Departments, roles, scoped connectors',
        },
      ],
    },
    { type: 'h2', text: 'When to pick which' },
    {
      type: 'verdict',
      themLabel: 'Glean',
      them: 'you want the best permission-aware enterprise search and assistant, you’re fine with a closed SaaS and a sales-led ~100-seat contract, and “find the answer” is the job.',
      kortix:
        'you want to run agents that actually do the work — across departments, any model, self-hosted, with everything versioned and owned by you.',
    },
    {
      type: 'p',
      text: 'They can coexist, too. Plenty of companies will keep Glean as the search layer and run the work itself on Kortix — agents that read, decide, and act, with the operating layer they need to do it governed as code. If that operating layer is what you’re missing, the [company OS post](/blog/ai-transformation-company-os) and the [secure connector model](/blog/secure-ai-agent-tool-access) are the next reads.',
    },
    {
      type: 'cta',
      title: "Don't just find the work. Run it.",
      body: 'Connect your tools and hand a Kortix agent a real task. Free to start, free to self-host.',
    },
  ],
};

export const BLOG_POSTS: BlogPostEntry[] = [
  kortixVsGlean,
  secureAiAgentToolAccess,
  aiTransformationCompanyOs,
  kortixVsClaudeCowork,
  personalAgentsVsCompanyOs,
  beyondTheChatBox,
  introducingKortix,
];
