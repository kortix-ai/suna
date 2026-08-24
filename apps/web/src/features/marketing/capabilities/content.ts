/**
 * Home-page long-form copy — four passages, mounted independently.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill.
 *
 * WHAT THESE ARE. The home page is visual: a hero video, a stacked layer card
 * set, a use-case wheel, a slab and a dark trust card. None of it can be READ.
 * These four are the readable material on that page — the operational detail the
 * stack gestures at and never explains.
 *
 * WHY THEY ARE FOUR SECTIONS AND NOT ONE. They used to be one 2,626px block of
 * prose sitting between the layer stack and the use-case wheel: a wall of
 * reading in a page that otherwise alternates. Each passage now mounts on its
 * own, next to the surface that raises the question it answers. Same instinct as
 * the two interludes — alternate rather than pile up.
 *
 * THE RULE THAT KEEPS THEM HONEST. Each passage stands alone. A reader who hits
 * one and never sees the other three must lose nothing: no opener may lean on a
 * predecessor, no passage may say "as above", and each carries its own way in
 * (eyebrow + title) and its own close. If you find yourself writing a connective
 * into the first sentence of one of these, the split is being undone.
 *
 * NO OVERLAP WITH THE LAYER STACK. `how-it-works-content.ts` sits above these on
 * the page. These four were kept precisely because they say things it does not —
 * see the per-passage notes below. None restates a whole sub-page, and none may
 * contradict one.
 *
 * ==========================================================================
 * ACCURACY GATE — every claim below was checked against code, not against the
 * sub-page copy it summarises. Do not soften, inflate, or "restore" any of it.
 * ==========================================================================
 *  - SECRETS. Never write that a granted secret is invisible to the model. A
 *    granted RUNTIME secret is a real env value in the session, readable by any
 *    command the agent runs (`docs/ENV_SECRET_EXPOSURE_BASELINE.md`). Only
 *    CONNECTOR credentials never enter the machine — they are `scope='connector'`
 *    and structurally excluded from sandbox env injection
 *    (`apps/api/src/projects/secrets.ts:173` skips them; :226 filters to
 *    `scope='runtime'`). Encryption is AES-256-GCM under an HKDF-SHA256 key
 *    derived per project (`secrets.ts:60,72`).
 *  - EGRESS. Never claim it is controlled at the network. Not implemented.
 *  - microVM. Never a blanket claim — true for Platinum (Cloud Hypervisor) only;
 *    the default provider is not. Write "its own isolated machine".
 *  - CHANNELS are a closed enum of four: `packages/manifest-schema/src/
 *    constants.ts:55` → `['slack','teams','email','voice']`. Slack is live;
 *    Teams is `TEAMS_CHANNEL_ENABLED: optBoolFalse` (`apps/api/src/config.ts:364`);
 *    email is experimental and per-project opt-in. Telegram, WhatsApp,
 *    SMS and Discord are NOT channels, in any tense. And `channels:` is REJECTED
 *    by the v2 manifest validator — channel routing is live project state, never
 *    repo config, so no passage may say `kortix.yaml` declares a channel.
 *  - ONE THREAD IS ONE SESSION is a database guarantee, not a convention:
 *    `uniqueIndex('idx_chat_threads_thread')` on (platform, workspace_id,
 *    thread_id) in `packages/db/src/schema/kortix.ts:1341`.
 *  - HARNESS. OpenCode only. ACP, `kortix_version: 3` and the Claude Code /
 *    Codex / Pi harnesses sit behind `KORTIX_ACP_RUNTIME` (`config.ts:272`,
 *    default false) and are not shipped. Never name them. Saying "an agent is
 *    an OpenCode agent" is a statement about depth, not about choice — do not
 *    let it imply a harness menu.
 *  - WHAT AN AGENT IS. Markdown is the FLOOR, never the ceiling. Do not write
 *    "an agent is a markdown file" and stop there. Verified:
 *      · Behavior is a stock OpenCode agent `.md` — Kortix adds no dialect.
 *        `compile-agent-config.ts` passes the frontmatter straight through as
 *        `OpencodeAgentConfig`: description, mode, model, variant, temperature,
 *        top_p, prompt, disable, hidden, options, color, steps, permission.
 *      · `permission` is per-capability, not one switch: read, edit, glob, grep,
 *        list, bash, task, external_directory, lsp, skill, todowrite, question,
 *        webfetch, websearch, doom_loop, plus arbitrary tool names — each
 *        `allow | ask | deny` or a glob→action map
 *        (`index.v2.ts` → `PermissionConfigObjectV2`).
 *      · The rest of the OpenCode surface lives in the same repo and is
 *        editable: `tools/` (real TypeScript, auto-discovered — the starter
 *        ships web_search, scrape_webpage, image_search, memory, show),
 *        `plugins/` (the starter ships a PTY plugin), `skills/`,
 *        `opencode.jsonc` (models, providers), and a real `package.json` that
 *        OpenCode `bun install`s at startup.
 *      · The GRANT covers more than tools. `AgentBlockV2` fields: `sandbox`
 *        (which machine it boots), `connectors` + `connectors_required`,
 *        `secrets`, `skills`, `kortix_cli`, `workspace`, `enabled`. CHANNELS
 *        are covered by `connectors` because a connected channel IS a connector
 *        with `provider: 'channel'` (`apps/api/src/projects/connectors.ts:61`).
 *  - TRIGGERS are exactly two kinds. A webhook with no `secret_env` is rejected
 *    at validation (`packages/manifest-schema/src/index.ts:940`, and again at
 *    `apps/api/src/projects/triggers.ts:746`); the signature is HMAC-SHA256
 *    (`apps/api/src/projects/lib/triggers.ts:69`); the cron timezone must be a
 *    valid IANA name (`index.ts:899,916`).
 *  - TRIGGER TEMPLATE TOKENS. The cron payload is built in
 *    `apps/api/src/projects/trigger-execution-store.ts:40-49`:
 *    `cron.schedule`, `cron.timezone`, `cron.scheduled_for`, `cron.claimed_at`,
 *    `cron.last_scheduled_for`. There is NO `cron.fired_at`. Do not invent one.
 *    Webhook prompts render `{{ body.path }}` (`triggers.ts:160`), and a keyed
 *    session needs its own `session_key` template (`triggers.ts:636`).
 *  - POLICY. Actions are `always_run | require_approval | block`
 *    (`apps/api/src/connectors/policy.ts:20`). `default_mode` falls back to
 *    `allow_all` when a project declares no `policy:` block
 *    (`apps/api/src/projects/policies.ts:73`) — approval gates are OFF by
 *    default. Say "set it", never "it is on".
 *  - MERGE is default-deny for agents, not human-only. `project.cr.merge` is a
 *    grantable capability asserted at `apps/api/src/projects/routes/r9.ts:58`.
 *  - AGENT CEILING. The effective grant at session birth is
 *    `declared ∩ launching-user role` (`apps/api/src/projects/agents.ts:19-21`).
 *  - AUDIT. Recording is never gated; only read/export/stream is
 *    (`apps/api/src/types.ts:129-135`).
 *  - SELF-HOST is NOT air-gapped. `kortix self-host start` pulls images over the
 *    internet and the default sandbox provider is remote. No passage claims this
 *    today — the rule stands in case one is ever re-added.
 *  - LICENCE. Say "open source" and stop. Never name one.
 *  - CERTIFICATION. Never claim one. SOC 2 is in progress; do not mention a
 *    certification in these passages at all.
 *  - NUMBERS. No invented metrics, no customer names, no benchmarks. The live
 *    GitHub star count is the only sanctioned figure on the site and it belongs
 *    to the open-source section — these four carry no figure at all.
 *  - Say "cloud computer" / "agent computer" / "sandbox". NEVER "container".
 */

export type Passage = {
  /** DOM id of the mounted `<section>`, and the test hook. */
  readonly id: string;
  /** Mono uppercase kicker. Thematic, never the same words as `linkLabel`. */
  readonly eyebrow: string;
  /** The way in. Short enough to hold one line at `sm` in a 32rem measure. */
  readonly title: string;
  /** The read. Two or three, and the last one has to land as a close. */
  readonly paragraphs: readonly string[];
  /** The scan layer, in mono. Each has to be checkable in the product. */
  readonly facts: readonly string[];
  readonly href: string;
  readonly linkLabel: string;
};

/**
 * FOUR PASSAGES, AND THE FOUR THAT WERE CUT.
 *
 * This material used to run eight entries. Four of them restated the layer stack
 * that sits above, so a reader met the same thing twice — once as cards, once as
 * prose — and the second pass read as length rather than depth. Each cut is
 * recorded here so nobody re-adds one without the argument:
 *
 *  - THE REPO. `how-it-works-content.ts` layer 01 already carries all of it:
 *    "kortix.yaml declares the machine image, the connectors and the triggers",
 *    "Agents and skills are markdown", "grep the whole company, diff any
 *    change, roll any part of it back". The only residue was `kortix init` /
 *    `kortix ship`, which the hero CLI panel and the open-source terminal both
 *    already show.
 *  - THE AGENT COMPUTER. Layer 05 carries all three beats, and its "Session id,
 *    sandbox id and branch name are one and the same string" is sharper than
 *    the paragraph that was here.
 *  - CONNECTORS. Layer 02's three bullets state 3,000+/MCP/OpenAPI/GraphQL/HTTP,
 *    server-side brokering, AND "allow, ask or block — down to the arguments it
 *    was given". The one beat the card could not hold — an approval HOLDS the
 *    call and the run resumes from it rather than failing — moved into
 *    `control` below, which already owns approval gates.
 *  - RUN IT YOURSELF. The open-source section owns it: the live star count, the
 *    two commands, and a four-row ledger of where self-hosting stops.
 *
 * What is left is the operational layer the stack gestures at and never
 * explains: what an agent really is, where sessions come from, work that starts
 * itself, and what keeps all of it in bounds.
 *
 * `agents` is kept DESPITE layer 04 touching it, deliberately. That card says
 * "An OpenCode agent: markdown, plus the tools and plugins beside it" — true,
 * and far too small for what the frontmatter and the grant actually hold. Cut
 * this passage and the grant surface (the machine it boots, its connectors and
 * channels, its secrets, its skills, its Kortix verbs) appears in no card at all.
 *
 * `control` is the strongest structural case: `how-it-works-content.ts:11-13`
 * says in as many words that "Security and governance is deliberately not a
 * layer here", and the trust section is badges and pillars, not mechanism.
 * Nothing else on the page explains it.
 */

/* ── 01 · What an agent is · mount after the layer stack ──────────────────────
   Layer 04 names the harness and stops at markdown. This is the correction, and
   the only place on the home page the grant surface appears at all. */
export const agents: Passage = {
  id: 'agents',
  eyebrow: 'What an agent is',
  title: 'An agent is a prompt and a set of grants.',
  paragraphs: [
    'An agent is an OpenCode agent. At baseline that is one markdown file — frontmatter setting its mode, its model and a per-capability permission tree, a body that is the system prompt — but markdown is the floor, not the ceiling. The whole OpenCode surface sits in the same repo and is yours to edit: your own TypeScript tools, plugins that hook the runtime, the skills it loads, the model and provider config.',
    'What it may reach is a block in kortix.yaml, and it covers far more than tools: which sandbox image it boots, which connectors and channels it can call, which secrets it may receive, which skills it may invoke, and what it may do to Kortix itself. A grant left out resolves to none. Whatever is granted is then intersected with the role of whoever started the session, so an agent never exceeds its human.',
  ],
  facts: ['OpenCode agent', 'Tools, plugins, models', 'Omitted grants are none'],
  href: '/agents-and-skills',
  linkLabel: 'Agents and skills',
};

/* ── 02 · Where work arrives · mount after the use-case wheel ─────────────────
   The wheel is ten finished artifacts and never says how any of them was asked
   for. This is the surface the ask arrives on — and the closed enum, stated
   before anyone assumes the list is longer than it is. */
export const channels: Passage = {
  id: 'channels',
  eyebrow: 'Where work arrives',
  title: 'A message in Slack starts a session.',
  paragraphs: [
    'Bind a project to Slack and a message in a thread starts a session. The agent picks up its own cloud computer, does the work, and answers in the same thread: the reply streams into one message, files move both directions, and a decision it needs from you arrives as a card with buttons.',
    'A thread is exactly one session — a unique index in the database, not a convention two services agree to honour. Slack is the surface that is live. Microsoft Teams is code-complete behind an operator switch; email is experimental and opt in per project. That is the entire list, because the platform enum is closed at three.',
  ],
  facts: ['Slack, live', 'Teams behind an operator switch', 'Email experimental'],
  href: '/channels',
  linkLabel: 'Channels',
};

/* ── 03 · Nobody present · mount after the asking interlude ───────────────────
   That interlude's third mode is "Automated — nobody is present", illustrated by
   a 07:00 report. This is the mechanism under exactly that card, and it hands
   the reader into the open-source and repo material that follows. */
export const automations: Passage = {
  id: 'automations',
  eyebrow: 'Nobody present',
  title: 'A trigger starts a session at 3am.',
  paragraphs: [
    'Work that starts itself has two shapes and no third: a cron schedule, stored against an IANA timezone name rather than an offset, or a webhook signed with HMAC-SHA256. A webhook trigger that names no signing secret is rejected at validation, so there is no unsigned path to forget to lock down later.',
    'The prompt a trigger fires is a template. A webhook fire renders {{ body.* }}; a cron fire renders {{ cron.schedule }}, {{ cron.timezone }} and {{ cron.scheduled_for }}. Each fire is a clean slate by default, or a trigger can re-prompt a session it already owns, keyed off the payload so one customer keeps one thread. Both shapes are entries in kortix.yaml and both run as an agent you name, so the 3am job has an author, a diff and a history like everything else in the repo.',
  ],
  facts: ['Cron and signed webhook', 'Declared in kortix.yaml', 'Runs as an agent you name'],
  href: '/automations',
  linkLabel: 'Automations',
};

/* ── 04 · In bounds · mount after the owning interlude, before trust ──────────
   The trust section is badges and pillars. This is the mechanism under them, and
   the owning interlude's "reach is declared, never inherited" hands straight
   into it. Three paragraphs on purpose: who may do what, what a secret really
   is, and the one way work lands.

   DO NOT ADD THE ALLOW / ASK / BLOCK WALKTHROUGH HERE. It was proposed for this
   passage on 2026-07-31 and rejected: the per-action policy material and the
   connector-permissions capture belong on `/connectors`, high up, where a
   reader is already thinking about connecting a tool. This passage stays prose,
   and stays quiet. */
export const control: Passage = {
  id: 'control',
  eyebrow: 'In bounds',
  title: 'Secrets, approvals, and the way work lands.',
  paragraphs: [
    'People, groups and service accounts are all principals, and a permission attaches to a principal for an action on a resource type. A service account never inherits the reach of whoever created it. Secrets are sealed with AES-256-GCM under a key derived per project, and an agent receives only the ones its grant names.',
    'We will not tell you a granted secret is invisible to the model: once delivered it is a real environment value in the session, because that is how a tool uses it. What holds is narrower — connector credentials never enter the machine at all, and the machine is destroyed with everything on it. Account administration — members, billing, creating projects — is outside the set an agent can hold at all.',
    'Approval gates are not on by default, so set the default you want. When one fires it holds the call open rather than failing it, so the run resumes from exactly where it stopped — a gate that errors out just teaches an agent to retry around it. Work reaches main one way: a change request, and merge is refused to every agent unless an admin grants it in kortix.yaml, which is itself an edit a person has to merge.',
  ],
  facts: ['AES-256-GCM per project', 'Gates off until you set them', 'Merge default-deny'],
  href: '/security',
  linkLabel: 'Security',
};
