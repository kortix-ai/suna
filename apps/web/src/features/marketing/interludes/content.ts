/**
 * Home-page interlude copy — the two quiet sections.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill.
 *
 * WHY THESE EXIST. The back half of the home page is four opinionated surfaces
 * in a row — a pinned wheel of cards, a bordered slab, a dark trust card, a
 * gridded CTA card — landing back to back with nothing between them. Each one
 * is a different shape and a different weight, so the page stops reading as a
 * sequence and starts reading as a stack of unrelated blocks. These two are the
 * rest between them: ordinary two-column text-and-graphic sections, one with
 * the graphic right and one with it left, deliberately the calmest things on
 * the page.
 *
 * WHY THEY ARE NOT THE PASSAGES. `features/marketing/capabilities` is the dense
 * read — four prose passages, each indexing a sub-page, each mounted on its own
 * elsewhere on this page. These two carry no link at all and roughly a third of
 * the words, and they are two-column with a bordered panel where a passage is a
 * single narrow document with a mono rail. They are breathing room, and the
 * moment either one starts arguing a whole capability it has stopped doing its
 * job.
 *
 * ==========================================================================
 * ACCURACY GATE — checked against code and against the shipped starter
 * (`packages/starter/templates/base`), not against marketing copy. Do not
 * soften, inflate, or "restore" any of it.
 * ==========================================================================
 *  - AGENTS. An agent is an OpenCode agent. Markdown is the baseline — the
 *    starter's `.kortix/opencode/agents/kortix.md` carries real OpenCode
 *    frontmatter (`mode: primary`, `permission: allow`) — and the whole
 *    OpenCode lifecycle sits in the same directory: tools, plugins, skills,
 *    commands, models. Never reduce an agent to "a markdown file".
 *  - HARNESS. OpenCode is the only one. ACP, `kortix_version: 3` and the
 *    Claude Code / Codex / Pi harnesses sit behind `KORTIX_ACP_RUNTIME`
 *    (default false) and are not shipped. Never name them.
 *  - GRANTS. `kortix.yaml` states it outright: "Omitted grants resolve to
 *    `none` in this schema version. Grant explicitly." That is the claim made
 *    below, in those words.
 *  - MERGE is default-deny for AGENTS, not human-only — `project.cr.merge` is
 *    a grantable capability. APPROVAL GATES ARE OFF BY DEFAULT
 *    (`policy.default_mode` falls back to `allow_all`), so never write that the
 *    agent asks before acting as a default. The three answers are exactly
 *    allow / ask / block (`apps/api/src/connectors/policy.ts`).
 *  - THE TREE below is the real shipped starter layout, read from
 *    `packages/starter/templates/base`. Do not add a directory it does not
 *    have, and do not show a `channels:` key in `kortix.yaml` — the v2 manifest
 *    validator REJECTS it. Channel routing is live project state, exactly as
 *    the shipped manifest's own closing comment says.
 *  - SURFACES. Slack, web and CLI only. Slack is the one live channel; Teams is
 *    behind an operator switch and email/voice are experimental. The manifest
 *    enum is closed at four. Telegram, WhatsApp, SMS and Discord are NOT
 *    channels, in any tense.
 *  - TRIGGERS are exactly two kinds: a cron schedule and a signed webhook.
 *  - NO METRICS anywhere in this file. The only sanctioned figure on the site
 *    is the live GitHub star count, and it belongs to the open-source section.
 *  - NO CUSTOMER NAMES, ever. Neither prompt below names a company.
 *  - Never name a licence. Never claim a certification. Say "cloud computer" or
 *    "its own machine" — never "container", and never a blanket "microVM"
 *    (true for the Platinum provider only).
 */

/* ── 1 · Asking — after the use cases ─────────────────────────────────────── */

export type AskMode = {
  readonly id: string;
  /** Mono rail label. One of the three sanctioned ways work runs. */
  readonly name: string;
  /** Half a line: what this mode is. */
  readonly definition: string;
  /** What somebody actually types. Plain language, no product nouns. */
  readonly prompt: string;
};

export const asking = {
  eyebrow: 'In your words',
  title: 'It all starts with a sentence.',
  paragraphs: [
    'None of the work above needs a workflow builder or a prompt engineer. Somebody asks — in a Slack thread, on the web, or from the CLI — and a machine boots to go and do it.',
    'What separates the three ways below is only how much of it happens without you. And a request worth making twice is worth keeping: write it down as a skill, commit it, and every session after that starts already knowing.',
  ],
  panel: {
    title: 'Ask',
    label: 'Input',
    footer: 'You set allow, ask or block per action. Merge stays default-deny for agents.',
  },
  modes: [
    {
      id: 'on-demand',
      name: 'On demand',
      definition: 'You ask; it comes back finished.',
      prompt:
        'Take every support ticket from yesterday, draft a reply to each one from our own docs, and leave them unsent for me.',
    },
    {
      id: 'human-assisted',
      name: 'Human-assisted',
      definition: 'It stops at the calls that are yours.',
      prompt:
        'Fix the bug that broke checkout, run the tests, and open a change request I can read before it lands.',
    },
    {
      id: 'automated',
      name: 'Automated',
      definition: 'Nobody is present.',
      prompt:
        'Every morning at 07:00, build the revenue report from the warehouse and post it to the team channel.',
    },
  ] satisfies readonly AskMode[],
} as const;

/* ── 2 · Owning — after the open-source slab ──────────────────────────────── */

export type TreeNode = {
  /** Indent level. 0 is the repository root. */
  readonly depth: number;
  /** The file or directory name, exactly as the shipped starter spells it. */
  readonly name: string;
  /** Right-hand annotation. Omit where the name already says it. */
  readonly note?: string;
  /** Directories render slightly stronger than the files under them. */
  readonly dir?: boolean;
};

export const owning = {
  eyebrow: 'What you own',
  title: 'The company is a directory.',
  paragraphs: [
    'Every agent, every skill, every remembered fact and every grant is a file. An agent is an OpenCode agent — markdown is the baseline, and the rest of the OpenCode lifecycle lives beside it in the same directory: skills, tools, plugins, commands, models. kortix.yaml sits above all of it and says what each agent is allowed to touch.',
    'Leave a grant out and it resolves to none, so reach is something you write down rather than something you inherit. And because it is a repository it is portable: clone it and the company comes with you — the agents, the skills, and everything it has learned. Nothing you build here is locked to us.',
  ],
  panel: {
    title: 'your-company/',
    label: 'Repo',
    footer:
      'The layout a new workspace ships with. Omitted grants resolve to none — reach is declared, never inherited.',
  },
  tree: [
    { depth: 0, name: 'kortix.yaml', note: 'agents, grants, triggers' },
    { depth: 0, name: '.kortix/', dir: true },
    { depth: 1, name: 'memory/', dir: true },
    { depth: 2, name: 'MEMORY.md', note: 'what the company has learned' },
    { depth: 1, name: 'opencode/', dir: true },
    { depth: 2, name: 'agents/', dir: true },
    { depth: 3, name: 'kortix.md', note: 'persona, mode, permission' },
    { depth: 3, name: 'memory-reflector.md' },
    { depth: 2, name: 'skills/', dir: true, note: 'how you do one job' },
    { depth: 2, name: 'tools/', dir: true },
    { depth: 2, name: 'plugins/', dir: true },
    { depth: 2, name: 'opencode.jsonc', note: 'the runtime agents think in' },
    { depth: 0, name: 'README.md' },
  ] satisfies readonly TreeNode[],
} as const;
