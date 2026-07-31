/**
 * `/about` copy — the founder's thesis, in his framing, cut to the bone.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 *
 * Voice rules: the `comms` skill. Long form: `MANIFESTO.md`.
 *
 * ACCURACY GATE for this page specifically:
 *  - This is a vision page, so forward-looking language is wanted. It must
 *    never read as shipped capability. TRAINING, RL and EVALS ARE NOT SHIPPED —
 *    every mention is written as direction, never as something a reader can do
 *    today. Anything in the present tense is true today.
 *  - `platform.items` carries NO status field and the page renders no status
 *    chip: the tense does the work. A row whose capability does not ship is
 *    written in the future ("the layer we are building next", "then …"), never
 *    in the present. Adding a row for something unshipped means writing it that
 *    way — do not reintroduce a status marker, and do not let a present-tense
 *    sentence describe a capability that does not exist.
 *  - Competitor names, exactly: **Claude Cowork** (one word, lowercase `w`) and
 *    **ChatGPT Work** (two words). There is no "Claude Work" and no
 *    "ChatGPT Cowork". Claim nothing about their limits or concurrency.
 *  - Never name a licence — "open source" and stop. Never claim a certification.
 *  - NEVER claim blanket "microVM isolation": true for Platinum, not for
 *    Daytona, which is the default. Write "its own isolated machine".
 *  - NEVER write that a secret is "never visible to the model". A granted
 *    runtime secret is a real env value in the session. CONNECTOR credentials
 *    are the ones brokered server-side that never enter the machine.
 *  - Never claim egress is controlled at the network. Nothing implements it.
 *  - OpenCode is the agent harness. Name no other.
 *  - The GitHub star count is the only sanctioned number, read live from
 *    `/api/github-stars`. No funding, headcount, customers or other metrics.
 *  - Keep it short. Every sentence that restates the one above it comes out.
 */

export const hero = {
  eyebrow: 'About Kortix',
  title: 'We are building the open AGI platform.',
  lead: 'Every company should own all of it — every agent, all of their data, every skill, every connector, the memory, the whole configuration.',
  ctaPrimary: 'We are hiring',
  ctaPrimaryHref: '/careers',
  ctaSecondary: 'Read the code',
  ctaSecondaryHref: 'https://github.com/kortix-ai/suna',
  imageAlt: 'The Kortix team',
  starsCaption: 'stars on kortix-ai/suna',
} as const;

/** The three claims the page rests on. One headline, one paragraph, no more. */
export const statements = [
  {
    id: 'own',
    n: '01',
    title: 'You own all of it.',
    body: 'On your own infrastructure if you want it there. Kortix does not sit beside the company as one more tool. It becomes the company — where the work, the context and the operations live.',
  },
  {
    id: 'closed',
    n: '02',
    title: 'The closed platforms are becoming AGI operating systems too.',
    body: 'Claude Cowork, ChatGPT Work and the rest are heading for full agent management systems an entire company runs on. That is the direction of the industry. The difference is that you will never own those.',
  },
  {
    id: 'shift',
    n: '03',
    title: 'Autonomy is shifting from humans to agents.',
    body: 'Every company is already autonomous. Today people drive that autonomy. Agents will. Kortix is where the shift happens.',
  },
] as const;

/**
 * The six-verb spine — the shape of the platform, not a feature checklist.
 * There is no status column: the first four rows are present tense because they
 * are true today, and the last two are future tense because they are not.
 */
export const platform = {
  eyebrow: 'The platform',
  title: 'Build, host, manage, monitor. Then train and eval.',
  sub: 'One place your agents run and all of your context connects. Six verbs, one system.',
  items: [
    {
      id: 'build',
      verb: 'Build',
      body: 'Agents, skills, connectors, triggers and memory are files in one git repo that is the company.',
    },
    {
      id: 'host',
      verb: 'Host',
      body: 'Every session runs on its own isolated machine. Thousands run in parallel on one config.',
    },
    {
      id: 'manage',
      verb: 'Manage',
      body: 'Per-resource permissions for people and agents. Secrets encrypted at rest; connector credentials brokered server-side, never entering the machine.',
    },
    {
      id: 'monitor',
      verb: 'Monitor',
      body: 'Watch a session live, diff every change to an agent or a skill, and land work through a change request.',
    },
    {
      id: 'train',
      verb: 'Train',
      body: 'The layer we are building next: your own models, trained on the work your agents already did, inside the same platform.',
    },
    {
      id: 'eval',
      verb: 'Eval',
      body: 'Then evals and reinforcement learning, scored on your own sessions rather than a public benchmark.',
    },
  ],
} as const;

export const closing = {
  title: 'Every lab will have an AGI platform. Ours is the one you own.',
  ctaPrimary: 'Come build it',
  ctaPrimaryHref: '/careers',
  ctaSecondary: 'Read the code',
  ctaSecondaryHref: 'https://github.com/kortix-ai/suna',
} as const;
