/**
 * `/automations` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill.
 * ACCURACY GATE for this page specifically — every claim below traces to
 * `apps/web/content/docs/connect/triggers.mdx` and
 * `apps/web/content/docs/project/manifest.mdx`:
 *  - There are exactly TWO trigger types, `cron` and `webhook`. No third.
 *  - `session_mode` has FOUR values — fresh | reuse | pinned | keyed — and the
 *    default is `fresh`. Do not ship a three-value list.
 *  - There is NO "post the result to a channel" field on a trigger. Do not
 *    imply a trigger delivers its output anywhere. What a triggered session
 *    does with its work is what its prompt asks for.
 *  - Say "agent computer" / "cloud computer" / "sandbox". NEVER "container".
 *  - Never claim a certification. Never name a licence — "open source" and stop.
 *  - Nothing merges itself. A 3am fire still lands through a change request.
 */

export const hero = {
  eyebrow: 'Automations',
  title: 'Work that starts without anyone asking.',
  sub: 'A trigger starts a session with no person present. A cron schedule fires it on the clock; a signed webhook fires it on an event. Either way the agent gets its own cloud computer, its own branch, and the same review on the way back.',
  ctaPrimary: 'Start a session',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Read the docs',
  ctaSecondaryHref: '/docs/connect/triggers',
  microline: 'Two types · Declared in kortix.yaml · Reviewed like everything else',
  /** Four mono facts under the fold. Every value has to be defensible. */
  specs: [
    { k: 'Types', v: 'cron and webhook', visual: 'lanes' },
    { k: 'Schedule', v: '6-field cron, any IANA timezone', visual: 'cron' },
    { k: 'Webhook auth', v: 'HMAC-SHA256, no unsigned path', visual: 'signature' },
    { k: 'Runs as', v: 'An agent you name', visual: 'identity' },
  ],
} as const;

export const types = {
  eyebrow: 'Two types',
  title: 'Two types. There is no third.',
  sub: 'A trigger is a clock or a signature. Everything else about it — which agent it runs as, what it says, which session it lands in — is the same config either way.',
  cards: [
    {
      id: 'cron',
      kind: 'cron',
      title: 'It fires on the clock',
      body: 'A 6-field cron expression — second, minute, hour, day, month, weekday — in any IANA timezone. Or a single run_at timestamp, for something that should happen once and then stay quiet.',
    },
    {
      id: 'webhook',
      kind: 'webhook',
      title: 'It fires on an event',
      body: 'An external service POSTs to the trigger URL. Kortix checks the signature, renders the payload into the prompt, and starts the session. A payload that fails your filter is accepted and ignored.',
    },
  ],
  notes: [
    'Both types name the agent they run as, and inherit that agent’s deny-by-default reach.',
    'Both carry a prompt template that becomes the session’s first message.',
    'Both are entries in kortix.yaml, so both have a history and an author.',
  ],
} as const;

export const schedule = {
  eyebrow: 'The cron surface',
  title: 'A schedule you can read in one column.',
  sub: 'Every trigger in a project is one row: what it is called, when it fires, in whose timezone, as which agent, and which session that fire lands in. Nothing about it is hidden state you have to click into.',
  columns: ['Trigger', 'Cron', 'Timezone', 'Agent', 'Session'] as const,
  rows: [
    {
      slug: 'daily-digest',
      cron: '0 0 9 * * 1-5',
      tz: 'America/Los_Angeles',
      agent: 'kortix',
      mode: 'fresh',
      reads: 'Weekdays at 09:00',
    },
    {
      slug: 'invoice-sweep',
      cron: '0 30 6 1 * *',
      tz: 'Europe/Berlin',
      agent: 'finance',
      mode: 'reuse',
      reads: 'The 1st of the month at 06:30',
    },
    {
      slug: 'oncall-handoff',
      cron: '0 0 17 * * 5',
      tz: 'UTC',
      agent: 'support',
      mode: 'fresh',
      reads: 'Fridays at 17:00',
    },
    {
      slug: 'roadmap-review',
      cron: '0 0 8 * * 1',
      tz: 'America/New_York',
      agent: 'planner',
      mode: 'pinned',
      reads: 'Mondays at 08:00',
    },
  ],
  facts: [
    {
      id: 'timezone',
      k: 'Timezones are real',
      v: 'A trigger stores an IANA timezone name, not an offset, and defaults to UTC. Set America/Los_Angeles and it stays at 09:00 local across a daylight-saving change. An abbreviation like PST is rejected rather than guessed at.',
    },
    {
      id: 'picker',
      k: 'You do not have to write cron',
      v: 'The Schedules screen is a picker — every few minutes, weekdays, every month, or once at a moment you choose. Raw cron is the escape hatch behind it, not the price of entry.',
    },
    {
      id: 'pause',
      k: 'One switch pauses everything',
      v: 'A project-level pause stops every trigger at once, on top of each trigger’s own enabled flag. Use it when the same repo runs on two control planes so nothing fires twice.',
    },
    {
      id: 'queue',
      k: 'A burst queues, it does not drop',
      v: 'A project runs 3 triggered sessions provisioning at once by default. A fire past that limit comes back queued and runs when a slot frees, rather than failing.',
    },
  ],
} as const;

export const declared = {
  eyebrow: 'Declared in the repo',
  title: 'An automation is a file, not a dashboard setting.',
  sub: 'Triggers live in kortix.yaml next to your agents and sandbox images. Each one names its agent, its schedule or its secret, and the prompt template that becomes the session’s first message.',
  yaml: {
    title: 'kortix.yaml',
    lines: [
      '# fires on the clock',
      'triggers:',
      '  - slug: daily-digest',
      '    type: cron',
      '    agent: kortix',
      '    cron: "0 0 9 * * 1-5"',
      '    timezone: America/Los_Angeles',
      '    session_mode: fresh',
      '    prompt: |',
      '      Summarize yesterday’s commits.',
      '      Open a change request against main.',
      '',
      '# fires on an event',
      '  - slug: new-lead',
      '    type: webhook',
      '    agent: sales',
      '    secret_env: WEBHOOK_SECRET',
      '    prompt: >-',
      '      A new lead arrived: {{ body.name }}',
      '      ({{ body.email }}). Add it to the CRM.',
    ],
  },
  shell: {
    title: 'kortix triggers',
    lines: [
      '# add it, ship it, and the schedule is live',
      '$ kortix triggers add daily-digest --type cron \\',
      '    --cron "0 0 9 * * 1-5" \\',
      '    --timezone America/Los_Angeles \\',
      '    --prompt "Summarize yesterday. Open a CR."',
      '$ kortix ship',
      '→ kortix.yaml pushed. daily-digest is scheduled.',
      '',
      '# see every trigger and when it last fired',
      '$ kortix triggers ls',
      '',
      '# do not wait for 09:00 to find out',
      '$ kortix triggers fire daily-digest',
      '→ session started',
    ],
  },
  template: {
    title: 'The prompt is a template',
    body: 'A prompt renders {{ token.dotted.path }} against the payload that fired it. A webhook fire gets {{ body.* }} and the request headers; a cron fire gets {{ cron.schedule }}, {{ cron.timezone }} and {{ cron.scheduled_for }}. A value that is not there renders as nothing — no error, no leftover braces in the message your agent reads.',
  },
} as const;

export const webhook = {
  eyebrow: 'Webhooks',
  title: 'Signed, or it does not fire.',
  sub: 'Every webhook trigger names a project secret that signs it. A trigger without one is rejected at validation — there is no unauthenticated webhook to forget to lock down later.',
  endpoint: 'POST /v1/webhooks/projects/{projectId}/{slug}',
  header: 'X-Kortix-Signature: sha256=<hmac>',
  headerNote:
    'HMAC-SHA256 over the raw request body, compared in constant time. The GitHub-compatible X-Hub-Signature-256 header works too, so a repo webhook needs no adapter.',
  rows: [
    {
      code: '202',
      v: 'Signature valid. The session fired, queued behind the concurrency limit, or deduped against a delivery Kortix already saw.',
    },
    {
      code: '200',
      v: 'Valid, and deliberately skipped — the project is paused, or the payload did not match the trigger’s filter.',
    },
    { code: '401', v: 'Signature and token both missing or wrong. Nothing runs.' },
    { code: '404', v: 'No such trigger, or it is disabled, or it is not a webhook trigger.' },
    {
      code: '409',
      v: 'The secret named by secret_env has no value set. Fails loudly rather than firing unprotected.',
    },
  ],
  footnote:
    'A filter is a dotted path matched against the same payload the prompt sees. It exists to break loops: a source that reports both sides of a conversation would otherwise fire the agent on its own reply.',
} as const;

export const session = {
  eyebrow: 'Session strategy',
  title: 'Which session a fire lands in.',
  sub: 'By default every fire is a clean slate. When the work is a running thread rather than a fresh errand, a trigger can re-prompt a session it already owns. Kortix tries the modes in order and falls through on failure, so a fire never simply disappears.',
  steps: [
    {
      n: '01',
      mode: 'pinned',
      body: 'Re-prompt one exact session, named by id. If that session is gone or failed, fall through.',
    },
    {
      n: '02',
      mode: 'keyed',
      body: 'Render a key from the payload, then re-prompt the most recent healthy session stamped with that exact key. One customer, one thread. It never falls through into another key’s session.',
    },
    {
      n: '03',
      mode: 'reuse',
      body: 'Re-prompt the most recent healthy session this trigger created. A pinned trigger falls back here before falling further.',
    },
    {
      n: '04',
      mode: 'fresh',
      body: 'Cut a new branch and boot a new cloud computer. This is the default, and the last resort for every other mode.',
    },
  ],
  footnote:
    'A triggered session is visible to the whole project, not private to whoever configured the trigger. It stops itself after 5 minutes idle, so an automation that runs at 3am is not a machine billing until morning.',
} as const;

export const review = {
  eyebrow: 'Overnight',
  title: 'It fires at 3am. A person still decides.',
  sub: 'An automation gets no privileges a person would not get. The same isolation, the same scoped reach, the same one road back to main.',
  rows: [
    {
      id: 'agent',
      k: 'It runs as an agent',
      v: 'A trigger names an agent, and inherits exactly that agent’s grants — the connectors, secrets and skills its block in kortix.yaml lists, and nothing else. An agent with no grants gets no access.',
    },
    {
      id: 'sandbox',
      k: 'It gets its own computer',
      v: 'A fresh fire boots its own isolated machine on its own branch, the same as a session you start by hand. Nothing it installs or breaks touches another session.',
    },
    {
      id: 'cr',
      k: 'Nothing merges itself',
      v: 'Work reaches main only through a change request a person reviews and approves. You read the diff over coffee. The machine never had the last word.',
    },
    {
      id: 'audit',
      k: 'The automation itself has a history',
      v: 'A trigger is a block of YAML in the repo. Who added the 3am job, when, and what it was told to say are all in the log — the same as any other change.',
    },
  ],
} as const;

export const closing = {
  eyebrow: 'Automate it',
  title: 'Write the schedule. Read the change request.',
  sub: 'Open source and self-hostable. Any model, your keys. Kortix Cloud, your own VPC, or fully on-prem.',
  ctaPrimary: 'Start a session',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Read the trigger docs',
  ctaSecondaryHref: '/docs/connect/triggers',
} as const;
