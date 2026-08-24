/**
 * `/agents-and-skills` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill.
 *
 * ACCURACY GATE for this page specifically — verified against the tree, not the
 * pitch. Re-check before editing a claim:
 *  - An agent is `.kortix/opencode/agents/<name>.md` (behavior) PLUS an
 *    `agents.<name>` block in `kortix.yaml` (governance). Two homes, one agent.
 *  - MARKDOWN IS THE FLOOR, NOT THE CEILING. Do not write "an agent is a
 *    markdown persona" and stop. The `.md` is a STOCK OpenCode agent file —
 *    `compile-agent-config.ts` passes its frontmatter straight through
 *    (description, mode, model, variant, temperature, top_p, prompt, disable,
 *    hidden, options, color, steps, permission), so Kortix adds no dialect. The
 *    rest of the OpenCode surface sits in the same repo and is editable:
 *    `tools/` (real TypeScript, auto-discovered), `plugins/` (the starter ships
 *    a PTY plugin), `skills/`, `opencode.jsonc` (models/providers) and a
 *    `package.json` OpenCode `bun install`s at startup.
 *  - THE GRANT COVERS MORE THAN TOOLS. `AgentBlockV2` (`index.v2.ts`):
 *    `sandbox` (which machine it boots), `connectors` + `connectors_required`,
 *    `secrets`, `skills`, `kortix_cli`, `workspace`, `enabled`. Channels fall
 *    under `connectors` because a connected channel IS a connector with
 *    `provider: 'channel'` (`apps/api/src/projects/connectors.ts:61`).
 *  - Depth is not a harness menu. OpenCode is the only shipped runtime; ACP and
 *    the other harnesses are behind `KORTIX_ACP_RUNTIME`, default false.
 *  - The scoping field is `permission`. It is NOT called `tools` —
 *    `packages/manifest-schema/src/index.v2.ts` raises a hard error on `tools`:
 *    "`tools` is deprecated upstream — use `permission` instead."
 *    Values are exactly `allow` | `ask` | `deny`.
 *  - Governance is deny-by-default. `packages/starter/templates/base/kortix.yaml`:
 *    "Omitted grants resolve to `none` in this schema version. Grant explicitly."
 *  - The ceiling is real and quotable — `apps/api/src/projects/agents.ts:19-21`:
 *    the effective grant is `declared ∩ launching-user role`. An agent can never
 *    exceed the human who launched it.
 *  - A skill is a DIRECTORY with a `SKILL.md` at its root. Frontmatter is
 *    `name` + `description`; the directory name must equal `name`.
 *  - Counts: 10 skills committed into a new project repo, plus 10 platform
 *    skills injected into every session at boot (`kortix-cli` is in both lists,
 *    so 19 distinct). 2 agents ship: `kortix` and `memory-reflector`.
 *  - MARKETPLACE: ships, labelled beta, ON by default. But the deterministic
 *    installer WAS REMOVED (`apps/api/src/projects/routes/r10.ts`): "The
 *    deterministic install/lock/update/remove engine … has been removed …
 *    Adding a marketplace item to an existing project is now always an agent
 *    import." So: one click to ADD, and what happens next is an agent session
 *    that opens a change request. Never imply a lockfile-backed package install.
 *  - "Agents rewrite themselves" is TRUE and must always carry "human-merged".
 *    An agent cannot escalate its own grants by editing kortix.yaml, because the
 *    runtime grant is intersected with the launching user's role.
 *  - Say "agent computer" / "cloud computer" / "sandbox". NEVER "container".
 *  - Never claim a certification. Never name a licence — "open source" and stop.
 */

export const hero = {
  eyebrow: 'Agents & skills',
  title: 'The workforce that compounds.',
  sub: 'An agent is an OpenCode agent: markdown at baseline, and past that your own tools, plugins, models and a per-capability permission tree. A grant in kortix.yaml decides what it reaches — its machine, its connectors and channels, its secrets, its skills. A skill encodes how your company does one specific job. Both are files in your repo. Both are reviewed like code.',
  ctaPrimary: 'Start a session',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Read the docs',
  ctaSecondaryHref: '/docs/project/agents',
  microline: 'OpenCode-native · Versioned · Deny by default · Human-merged',
  /** Four mono facts under the fold. Every value has to be defensible. */
  specs: [
    { k: 'An agent is', v: 'An OpenCode agent, plus its grants', visual: 'grants' },
    { k: 'A skill is', v: 'A folder with a SKILL.md', visual: 'tree' },
    { k: 'Governance', v: 'Deny by default', visual: 'gate' },
    { k: 'Both land via', v: 'A change request to main', visual: 'diff' },
  ],
} as const;

export const agent = {
  eyebrow: 'What an agent is',
  title: 'Two files. No hidden object behind them.',
  sub: 'An agent has exactly two homes. The markdown file carries how it thinks — its prompt, its mode, its model, its permission tree — and it is a stock OpenCode agent file, because Kortix adds no dialect to it. The manifest block carries what it may touch. Nothing about an agent lives in a database you cannot read.',
  md: {
    title: '.kortix/opencode/agents/kortix.md',
    caption: 'Excerpt of the default agent in every new Kortix project.',
    lines: [
      '---',
      'description: "Generic Kortix general knowledge worker.',
      '  Hands-on, full tool access, handles coding / research /',
      '  content / ops / data tasks end-to-end in an isolated',
      '  session sandbox. Edit this file to specialize."',
      'mode: primary',
      'permission: allow',
      '---',
      '',
      'You are a **Kortix general knowledge worker**.',
      '',
      'You are hands-on: you read, edit, run, search, fetch, and',
      'ship. The session you are in is an isolated sandbox — an',
      'ephemeral branch of this repo, your own `/workspace` — so',
      'you can install, experiment, and recover freely. Only what',
      'you commit and push survives.',
      '',
      '## How you work',
      '',
      '1. **Understand first.** Read the relevant files, search',
      '   the codebase or web, gather the context. Do not guess.',
      '2. **Plan briefly.** For non-trivial work, jot the approach',
      '   to your todo list before touching anything.',
      '3. **Do the work.** Edit, write, run, fetch.',
      '4. **Verify.** Run the tests, hit the dev server, check the',
      '   output. Whatever proves the change actually works.',
      '5. **Commit small, meaningful chunks.** Each commit leaves',
      '   the repo in a working state.',
    ],
  },
  yaml: {
    title: 'kortix.yaml',
    lines: [
      '# behavior lives in the .md — this block is governance only',
      'default_agent: kortix',
      '',
      'agents:',
      '  kortix:',
      '    connectors: all',
      '    secrets: all',
      '    skills: all',
      '    kortix_cli: all',
      '',
      '  release-bot:',
      '    # this one gets almost nothing, on purpose',
      '    connectors: [github]',
      '    secrets: [GITHUB_AGENT_TOKEN]',
      '    kortix_cli: [project.cr.open]',
      '',
      '# a grant you leave out resolves to none.',
      '# there is no implicit access. grant explicitly.',
    ],
  },
  /** EXACTLY THREE. `agents-and-skills/page.tsx` renders these in a
   *  `sm:grid-cols-3` grid, so a fourth orphans onto its own row. */
  notes: [
    'The manifest rejects a behavioral field in the governance block, with an error pointing at the agent’s own .md file.',
    'Markdown is the floor, not the ceiling: the whole OpenCode surface sits beside it in the same repo — your own TypeScript tools, plugins that hook the runtime, the model and provider config. An agent can pin its own model, or inherit the project, account and platform default in that order.',
    'Two agents ship in every new project: kortix, the generalist, and memory-reflector, which curates the project brain.',
  ],
} as const;

export const reach = {
  eyebrow: 'Scoped reach',
  title: 'Deny by default. Never above the human.',
  sub: 'The grant block covers the whole surface, not just tools: which sandbox image the agent boots, which connectors and channels it may call, which secrets it may receive, which skills it may invoke, and what it may do to Kortix itself. An agent with no grants gets none of it. You grant explicitly, or the answer is no — and on top of that sits a ceiling nothing in the config can lift.',
  md: {
    title: '.kortix/opencode/agents/memory-reflector.md',
    caption: 'A real permission tree, from a real agent that ships.',
    lines: [
      '---',
      'description: "Reflects on recent project activity and',
      '  curates .kortix/memory/ — the project brain. Runs on a',
      '  cron and ends every run by opening a single change',
      '  request."',
      'mode: primary',
      'permission:',
      '  edit: allow',
      '  bash:',
      '    "git *": allow',
      '    "kortix cr *": allow',
      '    "kortix sessions *": allow',
      '    "*": ask',
      '---',
    ],
  },
  actions: [
    { k: 'allow', v: 'Runs freely. No prompt, no pause.' },
    { k: 'ask', v: 'Pauses for a human. The session waits for your answer.' },
    { k: 'deny', v: 'Blocked outright. Not a warning — a wall.' },
  ],
  actionsNote:
    'Set one action for a whole capability — read, edit, bash, task, websearch, or reaching outside the workspace — or add glob rules underneath it, so git push asks while everything else is allowed.',
  rows: [
    {
      id: 'ceiling',
      k: 'An agent never exceeds its human',
      v: 'The grant that applies at session start is what the agent declares, intersected with the role of whoever launched it. Grant an agent everything and it still gets exactly your own permissions — no more, on any path.',
    },
    {
      id: 'never',
      k: 'Some things can never be granted',
      v: 'Account-level administration — members, billing, creating projects — is outside the set an agent can hold at all. There is no value you can write in a file that turns that on.',
    },
    {
      id: 'secrets',
      k: 'Secrets are named, not shown',
      v: 'An agent’s block lists the secrets it may use by name — identifiers, never values. A session receives only the intersection of that grant and the role of whoever started it.',
    },
    {
      id: 'escalate',
      k: 'It cannot vote itself a raise',
      v: 'An agent can edit kortix.yaml — it is a file. But the edit only applies to sessions started after a person merges the change request, and even then the ceiling still holds.',
    },
  ],
} as const;

export const skill = {
  eyebrow: 'What a skill is',
  title: 'How your company does one job, written down once.',
  sub: 'A skill is a directory with a SKILL.md at its root. Frontmatter names it and says when to reach for it; the body is the procedure. Every session can load it, so the thing you explained to one agent in March is still true for every agent in November.',
  md: {
    title: '.kortix/opencode/skills/agent-browser/SKILL.md',
    caption: 'Excerpt of a skill that ships in every new project.',
    lines: [
      '---',
      'name: agent-browser',
      'description: Browser automation CLI for AI agents. Use when',
      '  the user needs to interact with websites — navigating',
      '  pages, filling forms, clicking buttons, taking',
      '  screenshots, extracting data, testing web apps. Triggers',
      '  include "open a website", "fill out a form", "scrape data',
      '  from a page", "test this web app", "login to a site".',
      '---',
      '',
      '# agent-browser',
      '',
      'Fast browser automation CLI for AI agents. Chrome via CDP',
      'with accessibility-tree snapshots and compact `@eN` refs.',
      '',
      'The CLI and a headless Chromium are **already installed**',
      'in this Kortix sandbox and on `$PATH` — you do not need to',
      'run any install step.',
      '',
      '## Start here',
      '',
      'This file is a discovery stub, not the usage guide. Before',
      'running any command, load the workflow content:',
      '',
      '```bash',
      'agent-browser skills get core',
      '```',
    ],
  },
  points: [
    {
      id: 'trigger',
      title: 'The description is the trigger',
      body: 'An agent decides whether to load a skill from its name and description alone. A vague description means the skill never fires — which is why the description reads like a list of the things a person would actually say.',
    },
    {
      id: 'more',
      title: 'More than prose',
      body: 'A skill directory can carry scripts, references and assets beside the markdown. The instruction and the tool that executes it ship together, so a procedure does not rot away from the thing it drives.',
    },
    {
      id: 'grant',
      title: 'Granted, not global',
      body: 'The skills grant on an agent controls which skills it may load. A finance agent does not get handed the deployment runbook because it happened to be in the repo.',
    },
  ],
  counts: [
    { k: '10', v: 'skills committed into a new project repo on day one' },
    { k: '10', v: 'platform skills injected into every session at boot' },
    { k: '2', v: 'agents in a new project: a generalist and a memory curator' },
  ],
} as const;

export const repo = {
  eyebrow: 'Everything is files',
  title: 'The workforce is in the diff.',
  sub: 'Agents and skills are not rows in a table you cannot see. They are markdown in the repo the cloud computer clones, so changing your workforce is the same act as changing your code — and it gets the same review.',
  tree: [
    { path: 'your-company/', note: '', depth: 0 },
    { path: 'kortix.yaml', note: 'governance: what each agent may touch', depth: 1 },
    { path: '.kortix/opencode/', note: 'the runtime your agents think in', depth: 1 },
    { path: 'agents/', note: 'one OpenCode agent per file', depth: 2 },
    { path: 'kortix.md', note: 'the generalist, in every project', depth: 3 },
    { path: 'memory-reflector.md', note: 'curates the project brain on a cron', depth: 3 },
    { path: 'skills/', note: 'one directory per skill', depth: 2 },
    { path: 'agent-browser/SKILL.md', note: 'how this company drives a browser', depth: 3 },
  ],
  rows: [
    {
      id: 'readonly',
      k: 'The editor writes a branch, not a row',
      v: 'Customize is deliberately read-only. Pressing “Create new” or “Edit” opens a session that edits the files on a branch and opens a change request you review and merge. There is no button that silently changes how an agent behaves tomorrow.',
    },
    {
      id: 'self',
      k: 'Agents rewrite themselves — and get reviewed for it',
      v: 'An agent can sharpen its own prompt, add a skill, or tighten a permission rule. Every one of those is a commit on a branch in a change request a person merges. Self-improvement, human-merged. An agent never merges its own.',
    },
    {
      id: 'clone',
      k: 'A workforce you can fork',
      v: 'Because it is all text in one repo, you can branch your whole workforce, try a different set of grants, roll it back, or hand the lot to a new project. The configuration travels with the clone.',
    },
  ],
} as const;

export const marketplace = {
  eyebrow: 'Marketplace',
  title: 'Start from someone else’s work. Own it immediately.',
  sub: 'Browse agents, skills and whole projects, add one to your project in a click, and what arrives is files in your repo — not a dependency you rent. It is labelled beta because sources and updates are still moving, and it is on for every project.',
  steps: [
    {
      n: '00',
      title: 'Find it',
      body: 'Browse the marketplace without signing in. Kortix ships its own registry — 62 agents, 61 skills and 62 project templates — and you can switch on curated outside registries with one click. None load by default.',
    },
    {
      n: '01',
      title: 'Add it',
      body: 'One button. It starts an agent session that reads the item’s source and merges what fits into your project’s own files, rather than dropping a package in and hoping.',
    },
    {
      n: '02',
      title: 'It wires itself up',
      body: 'If the item needs a key or a connected app, the agent hands you a fill-in link in the same turn. You never paste a credential into a chat, and the agent never sees the value.',
    },
    {
      n: '03',
      title: 'You approve it',
      body: 'The session opens a change request. You read exactly which files are about to join your company, and merge when you are happy. Nothing lands unreviewed.',
    },
  ],
  footnote:
    'One thing this is not: a package manager. There is no lockfile, no version pin and no automatic update — an item you add becomes your own files, exactly like code you wrote. That is a deliberate trade, and it is the one we would make again.',
  ctaLabel: 'Browse the marketplace',
  ctaHref: '/marketplace',
} as const;

export const closing = {
  eyebrow: 'Build the workforce',
  title: 'Write it once. Every session knows it.',
  sub: 'Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or fully on-prem.',
  ctaPrimary: 'Start a session',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Read the agent docs',
  ctaSecondaryHref: '/docs/project/agents',
} as const;
