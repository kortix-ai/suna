/**
 * /connectors page copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill. The canonical product noun is CONNECTOR.
 *
 * ACCURACY GATE — every claim below traces to shipped code. Do not soften or
 * inflate these without re-reading the source:
 *  - The sandbox carries one project-scoped token (`KORTIX_CLI_TOKEN`) and
 *    zero third-party secrets. Credentials resolve server-side in the connector
 *    gateway (`apps/api/src/connectors/gateway.ts`), which is the chokepoint every
 *    tool call goes through.
 *  - Connector credentials are stored with `scope='connector'` and are
 *    structurally excluded from sandbox env injection
 *    (`apps/api/src/projects/secrets.ts` filters `scope='runtime'`).
 *  - Policy actions are `always_run | require_approval | block`, surfaced as
 *    Allow / Ask / Block (`apps/api/src/connectors/policy.ts`).
 *  - Approval HOLDS the call so the agent's turn pauses and resumes on approve.
 *  - Audit rows land in `kortix.connector_calls` with hashed inputs and
 *    redacted results. The per-session audit view is an Enterprise entitlement —
 *    never write "full org-wide audit trail", that view does not exist.
 *
 * DO NOT WRITE: "grant this connector to this person or department" (retired),
 * "writes require approval by default" (the shipped default is permissive),
 * or anything about the experimental Discover catalogue (off by default).
 */

export const hero = {
  eyebrow: 'Connectors',
  title: 'Every tool your company runs on. None of the keys.',
  sub: 'Connect a tool once, for the whole company. Agents reach it through one scoped token that Kortix brokers server-side — so the raw credential never lands in the machine the model is driving.',
  ctaPrimary: 'Get started',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Talk to sales',
  ctaSecondaryHref: '/contact',
  microline: '3,000+ apps · MCP · OpenAPI · GraphQL · raw HTTP',
  specs: [
    { k: 'Apps', v: '3,000+ connected', visual: 'apps' },
    { k: 'Keys', v: 'Never enter the machine', visual: 'vault' },
    { k: 'Policy', v: 'Allow, ask, or block', visual: 'policy' },
    { k: 'Custom APIs', v: 'MCP · OpenAPI · GraphQL · HTTP', visual: 'protocols' },
  ],
} as const;

/* ── 1 · connect once ─────────────────────────────────────────────────────── */

export const connect = {
  eyebrow: 'Connect once',
  title: 'One connection. Every agent, every session, every person.',
  sub: 'A connector belongs to the project, not to a laptop or a login. Add it once and every session that project starts can reach it — with no second setup and no key passed around in a DM.',
  /** Mirrors the real tabs on the Add-a-connector screen. */
  routes: [
    {
      id: 'easy',
      label: 'Easy connect',
      title: '3,000+ apps, OAuth handled',
      body: 'Pick the app, click through its OAuth screen, done. Kortix stores the connection, not your password — Gmail, Notion, Linear, Salesforce, HubSpot, Zendesk, Google Drive and thousands more.',
    },
    {
      id: 'custom',
      label: 'Custom',
      title: 'Your own APIs, in the same shape',
      body: 'Point Kortix at an OpenAPI or Postman spec, a GraphQL endpoint, a remote MCP server, or a bare HTTP base URL. It reads the source, works out the authentication, and turns every operation into a tool.',
    },
    {
      id: 'channels',
      label: 'Channels',
      title: 'The places people already talk',
      body: 'Slack and email connect the same way, so an agent can be reached and can reply where the work already happens.',
    },
  ],
  /** Real product screenshot — the Easy connect catalogue on a live project. */
  shot: {
    src: '/media/connectors/connector-catalogue.webp',
    alt: 'The Kortix connector catalogue, showing Notion, Google Sheets, Linear, Google Drive, Salesforce, HubSpot, GitHub, Gmail and more, each one click from connected.',
    caption: 'Connectors → Add app → Easy connect. Real screen, real project.',
  },
} as const;

/* ── 2 · the token flow ───────────────────────────────────────────────────── */

export const broker = {
  eyebrow: 'The credential never travels',
  title: 'The agent gets a token. It never gets the key.',
  sub: 'A sandbox is a real Linux machine the model can run anything on. So we do not put your credentials in it. The sandbox carries exactly one Kortix token, scoped to the project, and every outbound call is assembled on our side of the wall.',

  /** The old shape, stated plainly so the new one has something to beat. */
  before: {
    label: 'The usual way',
    title: 'A drawer of keys in the agent’s environment',
    lines: [
      'STRIPE_API_KEY=sk_live_…',
      'NOTION_TOKEN=secret_…',
      'SLACK_BOT_TOKEN=xoxb-…',
      'GITHUB_PAT=ghp_…',
    ],
    body: 'Every key sits in the environment the model reads from. Revoking one means rotating it everywhere it was copied, and any of them can end up in a log line.',
  },
  after: {
    label: 'How Kortix does it',
    title: 'One scoped token, and nothing else',
    lines: ['KORTIX_CLI_TOKEN=kortix_pat_…'],
    body: 'Scoped to one project and narrowed again by what that agent is allowed to touch. Turning a connector off takes effect on the next call. Nothing in the sandbox needs rotating, because nothing in the sandbox was ever a secret of yours.',
  },

  /** The diagram, left to right. */
  flow: [
    {
      id: 'agent',
      step: '01',
      title: 'The agent asks',
      mono: 'connector.call("gmail", "send_email", {…})',
      body: 'The agent calls a tool. It names the connector and the action — it has no URL, no host, no key.',
    },
    {
      id: 'broker',
      step: '02',
      title: 'Kortix brokers',
      mono: 'POST /v1/connectors/call',
      body: 'The gateway checks this agent may use this connector, resolves the policy, decrypts the credential server-side, and attaches it to the outbound request.',
    },
    {
      id: 'api',
      step: '03',
      title: 'The API answers',
      mono: 'Authorization: Bearer ••••••••',
      body: 'The third-party API sees a normal authenticated request. The response comes back to the agent. The credential stays behind.',
    },
  ],

  /** Rendered as the "never crosses this line" strip under the diagram. */
  neverLabel: 'Never crosses into the sandbox',
  never: ['API keys', 'OAuth access tokens', 'Refresh tokens', 'Client secrets'],
  /** Rendered as the reassurance row. Each item is a shipped mechanism. */
  guarantees: [
    {
      id: 'encrypted',
      title: 'Encrypted at rest',
      body: 'Connector credentials are encrypted with a per-project key and stored apart from the values a sandbox is allowed to read.',
    },
    {
      id: 'runtime',
      title: 'Injected at call time',
      body: 'The secret is attached to one outbound request and thrown away. It is never written into the sandbox environment.',
    },
    {
      id: 'invisible',
      // ACCURACY: the body scopes this to CONNECTOR credentials, but the title
      // alone — cropped into a screenshot or read by itself — became the blanket
      // "secrets are hidden from the model" claim, which is false.
      title: 'Connector keys stay server-side',
      body: 'The model is never shown a credential, and the ledger stores a hash of the inputs rather than the inputs themselves.',
    },
  ],
} as const;

/* ── 3 · scope ────────────────────────────────────────────────────────────── */

export const scope = {
  eyebrow: 'Scope',
  title: 'The same connector, readable by one agent and invisible to another.',
  sub: 'Reach is granted, not inherited. An agent gets the connectors you list for it and nothing else, and effective access is always the intersection of what the person can do and what the agent was granted.',
  layers: [
    {
      id: 'project',
      label: 'Per project',
      body: 'A connector lives in one project. Another project cannot see it, call it, or read its credential — a project is its own blast radius.',
    },
    {
      id: 'agent',
      label: 'Per agent',
      body: 'Each agent lists the connectors it may use. The support agent reaches Zendesk and Gmail; the reporting agent reaches neither, and cannot discover that they exist.',
    },
    {
      id: 'person',
      label: 'Per person',
      body: 'Choose who the connection belongs to: one project-managed account everyone shares, or a personal authorization where each member acts as themselves and an automated principal cannot act at all.',
    },
  ],
  /** Real `kortix.yaml`. Keep it valid — people will copy it. */
  codeCaption: 'kortix.yaml',
  code: `[[agents]]
name = "support"
connectors = ["zendesk", "gmail"]

[[agents]]
name = "recruiting"
connectors = ["greenhouse", "gmail"]

[[agents]]
name = "reporting"
connectors = ["warehouse"]`,
  codeNote:
    'Grants are text in the repo, so a change to who can reach what is a diff someone reviews — not a setting that quietly moved.',
} as const;

/* ── 4 · policy ───────────────────────────────────────────────────────────── */

export type PolicyStateId = 'allow' | 'ask' | 'block';

export const policy = {
  eyebrow: 'Policy',
  title: 'Decide what runs, what asks, and what never happens.',
  sub: 'Every action a connector exposes gets one of three answers, and you set them. One tool at a time, or one pattern that covers a hundred — a glob by default, or a regular expression when you wrap it in slashes.',
  states: [
    {
      id: 'allow',
      label: 'Allow',
      verb: 'Runs on its own',
      body: 'The call goes straight through. For reads and for the routine writes you have already decided you trust.',
      example: 'gmail.list_messages',
    },
    {
      id: 'ask',
      label: 'Ask',
      verb: 'Pauses for a human',
      body: 'The run stops at the call and waits. A person approves it once, approves it for the rest of the session, or denies it.',
      example: 'gmail.send_email',
    },
    {
      id: 'block',
      label: 'Block',
      verb: 'Never runs',
      body: 'The action is not available, and no approval can lift it in the moment. Deleting a customer stays off the table.',
      example: 'stripe.delete_customer',
    },
  ] satisfies readonly {
    id: PolicyStateId;
    label: string;
    verb: string;
    body: string;
    example: string;
  }[],

  /**
   * The fourth state in the screenshot, and the honest default.
   *
   * ACCURACY: `policy.default_mode` falls back to `allow_all` when a project
   * declares no `policy:` block (`apps/api/src/projects/policies.ts:73`), so an
   * untouched project runs everything. `risk` is the other mode: read
   * → `always_run`, write and destructive → `require_approval`
   * (`riskDefaultAction`, `apps/api/src/connectors/policy.ts`). Never write that
   * writes ask by default — they do not until somebody sets `risk`.
   */
  defaultState:
    'A tool left on Default has no rule of its own and falls through to the project default. Until you set that default to risk — reads run, writes and destructive actions ask — an untouched project runs everything.',

  /** Real product screenshot — the Permissions tab on a live connector. */
  shot: {
    src: '/media/connectors/connector-permissions.webp',
    alt: 'The Permissions tab of the Google Drive connector in Kortix: a default rule, then every Drive tool set to Allow, Ask, Block or Default.',
    caption: 'Permissions on a real Google Drive connector — 51 tools, one answer each.',
  },

  /** The pause, told as a timeline. This is the part people do not expect. */
  pause: {
    eyebrow: 'The pause is real',
    title: 'An approval stops the run. It does not fail it.',
    body: 'A gate that errors out teaches an agent to retry around it. A Kortix gate holds the call open, so the agent is still mid-task when you answer — and picks up exactly where it stopped.',
    steps: [
      { id: 'run', mono: 'running', label: 'The agent drafts the reply and reaches send_email.' },
      {
        id: 'hold',
        mono: 'waiting',
        label: 'The call is held. You see the action and its arguments.',
      },
      {
        id: 'go',
        mono: 'approved',
        label: 'You approve. The same call completes and the run continues.',
      },
    ],
  },

  /**
   * Argument-level conditions. This is the beat competitors do not have.
   *
   * ACCURACY — read out of `apps/api/src/connectors/policy.ts` on 2026-07-31:
   *  - A condition is a dot path into the call args (`to`, `message.channel`),
   *    a `match`, and an optional `negate` (`PolicyArgCondition`). ALL must hold.
   *  - `match` uses the SAME grammar as a tool-path matcher: a glob by default,
   *    or an explicit `/regex/flags` when slash-wrapped (`compileMatcher`). An
   *    invalid regex compiles to a never-match, and a nested-quantifier (ReDoS)
   *    shape is rejected at write time (`isValidMatcher`). "Regular expression"
   *    is therefore sayable — do not downgrade it back to "pattern".
   *  - An ARRAY argument matches only when EVERY element matches
   *    (`argValueMatches`), and a missing value never matches. Both fail closed.
   *  - An unevaluable or malformed condition makes a permissive rule NOT apply
   *    and a restrictive rule apply (`ruleApplies`) — always toward less access.
   *  - Cap is 10 conditions per rule (`MAX_CONDITIONS_PER_POLICY`); the page does
   *    not state the number, and should not start inventing a different one.
   */
  conditions: {
    title: 'Rules that read the arguments, not just the tool name',
    body: 'A tool-name rule can only ask “may the agent send email?” — which is rarely the question. A condition points at a value inside the call and matches it with a glob or a regular expression, so a rule can allow sending to your own domain and stop at everything else. A list argument passes only when every entry passes, so one off-list recipient is enough to hold the call. Anything the rule cannot decide resolves toward less access, never more.',
    rows: [
      { match: 'send_email', when: 'to ends with @acme.com', action: 'allow' },
      { match: 'send_email', when: 'anything else', action: 'ask' },
      { match: '/^(share|publish)_/', when: 'always', action: 'ask' },
      { match: 'delete_*', when: 'always', action: 'block' },
    ] satisfies readonly { match: string; when: string; action: PolicyStateId }[],
  },

  note: 'Project-wide rules are evaluated first and cannot be overridden by whoever adds a connector later.',
} as const;

/* ── 5 · audit ────────────────────────────────────────────────────────────── */

export const audit = {
  eyebrow: 'Audit',
  title: 'Every call it made, and who let it.',
  sub: 'The gateway that resolves the credential is also the thing that writes the record. There is no path to a connected tool that skips it.',
  /** Column names below are the real ledger fields. Do not invent more. */
  fields: [
    { id: 'action', label: 'Action', body: 'The connector and the exact action called.' },
    {
      id: 'who',
      label: 'Acted by',
      body: 'The agent and the person or trigger behind the session.',
    },
    { id: 'status', label: 'Outcome', body: 'Ran, denied, waiting on approval, or errored.' },
    { id: 'risk', label: 'Risk', body: 'Whether the action reads, writes, or destroys.' },
    { id: 'approver', label: 'Approved by', body: 'Who released a held call, and when.' },
    {
      id: 'digest',
      label: 'Inputs',
      body: 'A hash of the arguments, and a redacted result — never a raw secret.',
    },
  ],
  note: 'Read the trail for any session inside the app. Audit access is part of Enterprise.',
} as const;

/* ── 6 · close ────────────────────────────────────────────────────────────── */

export const close = {
  title: 'Connect the first one in a minute.',
  sub: 'Start free, connect a tool, and watch the first approval gate stop an agent mid-run. Self-host it if you would rather the whole thing lived in your own environment.',
  ctaPrimary: 'Get started',
  ctaSecondary: 'Read the docs',
  ctaSecondaryHref: '/docs/connect/connectors',
  points: [
    'Open source and self-hostable — Kortix Cloud, your VPC, or on-prem.',
    'Credentials encrypted, brokered server-side, never handed to the model.',
    'Allow, Ask, or Block on every action, with a human in the loop where it matters.',
  ],
} as const;
