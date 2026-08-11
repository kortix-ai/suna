/**
 * Copy for /a1o — "all in one". Six layers of the dosco stack, one per face of
 * a die you roll around the table. Whichever face lands up is the layer shown.
 *
 * `slot` is the die face this layer is printed on. Slots are laid out so that
 * opposite faces sum to seven, the way a real die is arranged — DIE_FACES in
 * die-scene.tsx binds each slot to a face normal.
 *
 * The word printed on the die is derived from `title`, never stored separately:
 * two independent strings drifted apart once already (a face reading TRUST
 * while the copy read Governance).
 *
 * HONESTY RULES (same bar as features/marketing/security/content.ts):
 * - SOC 2 Type II is IN PROGRESS. Never "compliant" / "certified" until the
 *   report lands.
 * - Do NOT advertise multi-harness / harness-agnostic / ACP. OpenCode REST +
 *   kortix_version 2 is the only shipped path (see CLAUDE.md).
 */

export type Layer = {
  slot: 1 | 2 | 3 | 4 | 5 | 6;
  ordinal: string;
  title: string;
  teaser: string;
  body: string;
};

export const LAYERS = [
  {
    slot: 1,
    ordinal: '01',
    title: 'Models',
    teaser: 'Every frontier model, one gateway',
    body: 'Every run is routed through a single gateway, so the model stays a setting instead of an architecture. Switch per agent, per task, or to whatever ships next week.',
  },
  {
    slot: 2,
    ordinal: '02',
    title: 'Agent loop',
    teaser: 'What turns a model into a coworker',
    body: 'A model answers; an agent finishes the job. dosco runs the loop around it — reading the repo, planning, calling tools, checking its own work, returning a branch you can review.',
  },
  {
    slot: 3,
    ordinal: '03',
    title: 'Cloud runtime',
    teaser: 'One task, one machine, one branch',
    body: 'Every session boots its own cloud sandbox on its own Git branch, preloaded with your repo and tools. Thousands run in parallel with zero crossover, none of it on your laptop.',
  },
  {
    slot: 4,
    ordinal: '04',
    title: 'Context',
    teaser: 'Agents that already know the place',
    body: 'Repos, docs, secrets, and connected tools are shared context rather than a prompt you paste again each morning. Connect a system once and every agent inherits it.',
  },
  {
    slot: 5,
    ordinal: '05',
    title: 'Control plane',
    teaser: 'Where the fleet is operated',
    body: 'One place to launch, schedule, watch, and stop every agent. Live streams, full history, spend, and triggers that start work without a human in the loop.',
  },
  {
    slot: 6,
    ordinal: '06',
    title: 'Governance',
    teaser: 'Built in, not bolted on',
    body: 'Isolated execution, scoped credentials, and a complete audit trail are how the platform is built. SSO and role-based access come standard; self-host it entirely if you want.',
  },
] as const satisfies readonly Layer[];

export const COPY = {
  wordmark: 'dosco',
  title: 'All in one',
  lede: 'Six layers of the agent stack. One platform. Roll the die to read a face.',
  hint: 'Drag to roll',
  spin: 'Spin',
  throw: 'Throw',
  /** Shown when SOC 2 wording could otherwise imply certification. */
  footnote: 'SOC 2 Type II audit in progress. Controls already live.',
} as const;
