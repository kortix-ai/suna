/**
 * Copy for the platform-stack section — the pinned card stack whose every card
 * carries a real product panel.
 *
 * Six layers, in the order a reader needs them, as a loop rather than a list:
 * the repo that IS the company, the tools it reaches, the model, the harness
 * that drives it, the machine it runs on, and the plane it is operated from —
 * which commits the work back into layer 01. A seventh entry closes the stack;
 * it is a full stop, not a layer, and carries no product panel.
 *
 * Security and governance is deliberately not a layer here. The home page runs
 * a dedicated trust section, and adding it made the sequence read as a feature
 * list again.
 *
 * Deliberately local rather than in `translations/*.json`: this section used to
 * be a request-to-finished-work walkthrough, and the seven non-English locales
 * still hold that older translated heading. Local copy avoids shipping a
 * heading that contradicts the section in every other language.
 *
 * ACCURACY GATE — every line below is checked against shipped code, not against
 * the manifesto. The rules that keep getting broken:
 *   - A granted runtime secret IS a real env value inside the session and any
 *     command the agent runs can read it (docs/ENV_SECRET_EXPOSURE_BASELINE.md).
 *     Never write "the model never sees them". "Brokered server-side and never
 *     enters the machine" is true for CONNECTOR credentials only.
 *   - Egress is not controlled at the network. Nothing implements it.
 *   - microVM is the Platinum provider only; the default is containers. The
 *     sanctioned phrasing is "its own isolated machine".
 *   - Channels are a closed enum: slack | teams | email | voice. Telegram,
 *     WhatsApp, SMS and Discord are not channels. And `channels:` is REJECTED
 *     by the v2 manifest validator (`rejectChannelsV2`), so `kortix.yaml` never
 *     "declares channels" — channel routing is live project state, not repo
 *     config. The manifest declares the machine image, connectors and triggers.
 *   - "Open source", never a licence name. SOC 2 Type II is in progress, never
 *     "certified" or "compliant".
 *   - OpenCode is the only harness that may be named.
 *
 * Three claims that read fine but do not survive the code, so they are not here:
 *   - "the Cursor subscription you already pay for" — there is no Cursor auth,
 *     credential or provider anywhere in the codebase. ChatGPT is real
 *     (`apps/api/src/projects/codex-device-auth.ts`).
 *   - "air-gapped" — nothing implements it, and the enterprise VPC spec says in
 *     as many words that it is "not full air-gap".
 *   - "work reaches main only through a change request a human approves" — the
 *     dashboard commits config straight to the default branch, and the merge
 *     grant is a named grant, not a human-only gate. Scoped to session work and
 *     phrased as a grant below.
 */

export const SECTION = {
  eyebrow: 'The Kortix stack',
  title: 'Every layer an AI workforce needs — in one platform you own.',
  // Short on purpose: the section pins to the viewport, so every line here is
  // height taken away from the card that has to fit under it — and the stack
  // itself now names every layer, which is what the long enumeration did.
  description:
    'Most tools hand you one layer and rent you the rest. Kortix is all six — they read in order, and the sixth commits the work back into the first.',
} as const;

export type Layer = {
  /** Stable id, also the DOM test hook and the key `LayerShowcase` switches on. */
  id: 'source' | 'context' | 'models' | 'harness' | 'computer' | 'control-plane' | 'kortix';
  /** Two-digit ordinal shown in the left gutter. */
  ordinal: string;
  /** The layer's name. Same noun as the card's own product panel header. */
  label: string;
  /** The claim the layer makes, as a sentence. */
  title: string;
  description: string;
  /**
   * Three facts. Each one has to be checkable in the product, not a promise.
   * Empty on the closing card, which is a full stop rather than a layer.
   */
  bullets: string[];
};

/**
 * The order is the argument: it starts at the repo, walks outward through the
 * things a session needs, and the last layer commits the work back into the
 * first one. Each `description` picks up the noun the layer before it left.
 */
export const LAYERS: Layer[] = [
  {
    id: 'source',
    ordinal: '01',
    label: 'Source of truth',
    title: 'One git repo that is the company.',
    description:
      'Agents, skills, memory, connector config and triggers are all text in one repo. Not settings in someone else’s database — files you own.',
    bullets: [
      'kortix.yaml declares the machine image, the connectors and the triggers',
      'Agents and skills are markdown; memory is files that accumulate',
      'grep the whole company, diff any change, roll any part of it back',
    ],
  },
  {
    id: 'context',
    ordinal: '02',
    label: 'Context & connections',
    title: 'Every tool your company already runs on.',
    description:
      'The repo also holds the connectors. Wire up Slack, docs, tickets, CRM, billing and code once, then scope which agent may touch which one.',
    bullets: [
      '3,000+ apps in a click, plus MCP, OpenAPI, Postman, GraphQL and raw HTTP',
      'Connector credentials are brokered server-side and never enter the machine',
      'Rule each tool call allow, ask or block — down to the arguments it was given',
    ],
  },
  {
    id: 'models',
    ordinal: '03',
    label: 'Large language models',
    title: 'Run any model. Keep your keys.',
    description:
      'Kortix is model-agnostic. Pick the model per agent, per session or per message, and switch the day a better one lands.',
    bullets: [
      'Bring your own API key from any major provider, or use ours',
      'Or sign in with the ChatGPT subscription you already pay for',
      'Or your own models, behind your own URL — anything OpenAI-compatible',
    ],
  },
  {
    id: 'harness',
    ordinal: '04',
    label: 'Agentic harness',
    title: 'The part that turns a model into an agent.',
    description:
      'A model on its own answers. The harness gives it planning, tool use and multi-step runs it actually finishes — powered by OpenCode, configured by a file in the repo.',
    bullets: [
      // ACCURACY: markdown is the baseline, not the ceiling. An agent is an
      // OpenCode agent — tools, plugins and model config sit beside it in the
      // same repo. Do not shorten this back to "an agent is markdown".
      'An OpenCode agent: markdown, plus the tools and plugins beside it',
      'Say allow, ask or deny per tool — down to a single shell command',
      'Open source, so the harness is never the thing you are locked into',
    ],
  },
  {
    id: 'computer',
    ordinal: '05',
    label: 'Agent computer',
    title: 'Every session gets its own computer.',
    description:
      'The harness needs somewhere to run. Each session boots its own isolated Linux machine with your repo and your tools already on it — nothing to install, no laptop involved.',
    bullets: [
      'Session id, sandbox id and branch name are one and the same string',
      'The agent can install, run and break anything — only commits survive',
      'Thousands run in parallel with no crossover between them',
    ],
  },
  {
    id: 'control-plane',
    ordinal: '06',
    label: 'Control plane',
    title: 'One place to start it, one gate to land it.',
    description:
      'Start, watch and steer every agent in the organization — from the web app, from Slack, from your terminal, or from nobody at all. Then the work commits back into the repo you started from.',
    bullets: [
      'Web, Slack, mobile, CLI and API all start the same session',
      'Cron schedules and signed webhooks start sessions with no one asking',
      'Session work lands on main as a change request you read as a diff first',
    ],
  },
];
