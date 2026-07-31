/**
 * `/self-hosted` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill. Never name a licence — "open source" and stop.
 * Say "cloud computer" / "sandbox", never "container". No invented numbers.
 *
 * ACCURACY GATE — everything below is checked against the shipped CLI
 * (`apps/cli/src/commands/self-host.ts`, `apps/cli/src/self-host/*`) and the
 * rendered Compose stack, not against the docs, which are stale in two places.
 *
 * CORRECTIONS made against the brief this page was written from:
 *  1. The first run does NOT ask for managed-git / GitHub credentials. That
 *     step was deliberately removed; GitHub is connected in the dashboard at
 *     Settings → Git after `start`, and `kortix self-host connect-github` is a
 *     deprecated alias that says so. The wizard asks six things — listed below.
 *  2. The first run does NOT ask for a model key either. Models are BYOK in the
 *     app after `start` (`secrets-registry.ts`: "NOT init-required").
 *  3. Pipedream IS a wizard prompt, but it is optional and defaults to skip.
 *  4. AIR-GAPPED IS NOT WHAT `kortix self-host start` GIVES YOU. By default the
 *     agent sandboxes run on a third-party provider (Daytona) and the instance
 *     must be reachable from the internet so the sandbox can call back. Saying
 *     otherwise would be false. This page states the boundary plainly and sends
 *     isolated topologies to `/enterprise`.
 *  5. There is no Redis and no separate worker service in this stack. Do not
 *     add either to the diagram.
 *  6. Link `/docs/host`, never `/docs/guides/self-hosting` — that path does not
 *     exist (the redirect in `next.config.ts` points at a missing page).
 */

export const hero = {
  eyebrow: 'Self-hosted',
  title: 'The same Kortix, on your box.',
  sub: 'One Docker Compose stack, built from the same images the managed cloud runs. Your database, your files, your repos and your policies sit on disk you control. It is open source, so what you are running is code you can read.',
  ctaPrimary: 'Self-host free',
  ctaPrimaryHref: '/docs/host',
  ctaSecondary: 'Use Kortix Cloud',
  ctaSecondaryHref: '/auth',
  microline: 'Same images as the cloud · One command · Any model, your keys',
  /** Four mono facts the page then proves. Every value is defensible. */
  specs: [
    { k: 'Install', v: 'kortix self-host start' },
    { k: 'Stack', v: 'One Docker Compose project' },
    { k: 'Models', v: 'Your provider, your keys' },
    { k: 'Updates', v: 'Nightly, or pin a version' },
  ],
} as const;

/* ── 1 · what you keep ─────────────────────────────────────────────────────
   HONESTY GATE. The control plane is genuinely yours. Sandbox compute is NOT,
   by default — the API reaches Daytona (or Platinum, or E2B) over egress, and
   the instance must be publicly reachable so the sandbox can call back. Both
   columns below are drawn from that reality, not from a wish. */
export const yours = {
  eyebrow: 'What you keep',
  title: 'The company stays on your side of the wall.',
  sub: 'Self-hosting is not a smaller Kortix with the interesting parts removed. It is the whole control plane — accounts, projects, repos, secrets, connectors, policies, audit — running inside your network, on storage you back up yourself.',
  onbox: {
    label: 'on your box',
    items: [
      'The Postgres database, as a directory you can back up',
      'File storage, as a second directory next to it',
      'Every project repo and every secret the platform holds',
      'Accounts, roles, policies, triggers, channels and the audit record',
      'The LLM gateway your sessions route model calls through',
    ],
  },
  offbox: {
    label: 'not on your box',
    /** Stated up front on purpose. A reviewer will find this in ten minutes. */
    items: [
      'Agent sandboxes, which run on the provider you configure',
      'The image registry the stack pulls from, which needs no credentials',
    ],
    note: 'Sandbox compute is a provider choice: Daytona by default, or Platinum or E2B. local-docker runs sandboxes on the same box through Docker and is experimental — not for production. Air-gapped and other fully isolated topologies are scoped with us rather than self-served.',
  },
} as const;

/* ── 2 · the commands ──────────────────────────────────────────────────────
   `start` creates the config if it is missing, so it really is the one command.
   It also registers the `selfhost` CLI host and makes it active. `hosts use`
   flips `active` in ~/.config/kortix/config.json; tokens are stored per host,
   so switching swaps the token, the account and the default project with it. */
export const commands = {
  eyebrow: 'Two commands',
  title: 'Start the stack. Point the CLI at it.',
  sub: 'There is no separate provisioning step and no console to click through. One command brings the stack up. One more decides which Kortix your CLI is talking to.',
  install: {
    title: 'bring the stack up',
    lines: [
      '# install the CLI',
      '$ curl -fsSL https://kortix.com/install | bash',
      '',
      '# create the config if it is missing, then start everything',
      '$ kortix self-host start',
      '→ stack up · dashboard registered as host "selfhost"',
      '',
      '# check on it any time',
      '$ kortix self-host status',
      '$ kortix self-host logs kortix-api',
    ],
  },
  hosts: {
    title: 'choose which Kortix you are talking to',
    lines: [
      '# a host is one Kortix API endpoint, with its own token',
      '$ kortix hosts ls',
      '',
      '# work against your own stack',
      '$ kortix hosts use selfhost',
      '→ Active host is now selfhost',
      '',
      '# and back to the managed cloud',
      '$ kortix hosts use cloud',
      '→ Active host is now cloud',
    ],
  },
  notes: [
    'Tokens are stored per host, so switching hosts switches the account and the default project with it.',
    'kortix self-host start registers the selfhost host for you and makes it active.',
    'Override for one command instead of switching: pass --host selfhost.',
  ],
} as const;

/* ── 3 · the first run ─────────────────────────────────────────────────────
   The six guided questions, in the exact order the CLI asks them (the ordering
   comment in commands/self-host.ts is explicit that there are no others). The
   generated list is defaultEnv(). The only genuinely blocking secret is the
   sandbox provider key. */
export const firstRun = {
  eyebrow: 'First run',
  title: 'Six questions. Everything else is generated.',
  sub: 'You are not handed a template env file to fill in. The CLI asks the handful of things only you can know, generates every port, URL, password, signing key and Compose default itself, and writes the whole instance to one directory.',
  asks: {
    label: 'what it asks you',
    items: [
      {
        n: '01',
        k: 'How this instance is reachable',
        v: 'A domain you point at the box, or a Cloudflare tunnel for evaluation. Sessions run on a remote sandbox and have to call back, so this is the first real decision.',
      },
      {
        n: '02',
        k: 'An admin email',
        v: 'Grants platform admin, so you can configure GitHub and the rest in the dashboard. Optional, and you can set it later.',
      },
      {
        n: '03',
        k: 'Whether you hold an Enterprise licence',
        v: 'Unlocks SAML SSO, SCIM directory sync, custom roles, groups and audit read on this instance.',
      },
      {
        n: '04',
        k: 'Who may create organizations',
        v: 'Admin-only by default. People still join by invite or SSO either way.',
      },
      {
        n: '05',
        k: 'Your sandbox provider and its key',
        v: 'Daytona, Platinum, E2B, or experimental local-docker. This is the one credential the stack genuinely cannot start without.',
      },
      {
        n: '06',
        k: 'Connectors, and the update window',
        v: 'Pipedream credentials for the 3,000+ app catalog — optional, skipped by default — then whether to auto-update nightly.',
      },
    ],
  },
  generates: {
    label: 'what it generates for you',
    items: [
      'Every host port, reassigned automatically if one is already taken',
      'Every internal URL the services use to find each other',
      'The database password, the JWT signing secret and the API keys derived from it',
      'The gateway, service and tunnel signing tokens',
      'A fresh RSA keypair for SAML, so SSO has a key the day you turn it on',
      'The whole docker-compose.yml and .env, written at mode 0600',
    ],
    note: 'Everything the CLI generates is rotatable later with kortix self-host env rotate, and every value is visible with kortix self-host env ls, masked unless you ask for --show.',
  },
  after: 'GitHub and your model key are not asked here on purpose. Both are set in the dashboard after the stack is up — GitHub at Settings → Git, the model key in the model picker.',
} as const;

/* ── 4 · the stack ─────────────────────────────────────────────────────────
   Rendered by self-host/compose-assets.ts. Kortix services + the vendored,
   digest-pinned Supabase distribution. Caddy renders only with a domain;
   cloudflared only in tunnel mode. There is NO Redis and NO worker service. */
export const stack = {
  eyebrow: 'The stack',
  title: 'One Compose project, no hidden pieces.',
  sub: 'The same artifact runs on a laptop, a VPS or a cloud VM. A domain is one environment variable, not a different deployment. Everything lives in one instance directory you can back up by copying it.',
  groups: [
    {
      id: 'kortix',
      label: 'kortix',
      services: [
        { k: 'frontend', v: 'The web app' },
        { k: 'kortix-api', v: 'The API and the in-process LLM gateway' },
        { k: 'llm-gateway', v: 'Control-plane routing' },
        { k: 'kortix-migrate', v: 'One-shot database migration on every roll' },
        { k: 'kortix-updater', v: 'Nightly pull, migrate, then swap' },
      ],
    },
    {
      id: 'data',
      label: 'data plane',
      services: [
        { k: 'supabase-db', v: 'Postgres, on a directory you control' },
        { k: 'supabase-auth', v: 'Sign-in, invites and SAML' },
        { k: 'supabase-rest', v: 'The data API' },
        { k: 'supabase-storage', v: 'Files, on a second directory' },
        { k: 'supabase-kong', v: 'The data-plane gateway' },
      ],
    },
    {
      id: 'edge',
      label: 'edge — only what you chose',
      services: [
        { k: 'caddy', v: 'Automatic TLS. Rendered only when you set a domain' },
        { k: 'cloudflared', v: 'The tunnel. Rendered only in tunnel mode' },
      ],
    },
  ],
  data: {
    title: 'Your data is two directories and a file',
    body: 'The Postgres data directory, the storage directory, and the .env that holds every key the instance uses. Back up those three and you have backed up the instance. There is no separate backup service to configure, and nothing to export from us.',
  },
  updates: {
    title: 'It keeps itself current',
    body: 'The updater checks once a day at a time you set, runs the migration, then starts the new services before it stops the old ones. Track the curated stable channel, ride latest, or pin an exact version and never move.',
  },
} as const;

/* ── 5 · same product ──────────────────────────────────────────────────────
   Grounded in: the same docker.io/kortix/* images the pipeline built; no
   self-host feature flag branching in apps/api/src. The ONE honest caveat is
   ENTERPRISE_LICENSE_AVAILABLE, which gates SSO / custom roles / directory sync
   / groups — so it is stated, not buried. */
export const parity = {
  eyebrow: 'Parity',
  title: 'Not a community edition.',
  sub: 'This is not a stripped build with the good parts held back for the paid tier. Self-hosted instances run the same images the managed cloud runs, produced by the same pipeline, on the same release train.',
  rows: [
    {
      id: 'images',
      k: 'The same images',
      v: 'The frontend, the API and the gateway are the published Kortix images. A self-hosted instance never builds its own — it consumes exactly what the release pipeline already produced.',
    },
    {
      id: 'features',
      k: 'The same product surface',
      v: 'Projects, sessions on their own cloud computers, agents, skills, connectors, channels, triggers, secrets, change requests and the audit record. Nothing on that list is cloud-only.',
    },
    {
      id: 'enterprise',
      k: 'One honest exception',
      v: 'SAML SSO, SCIM directory sync, custom roles, groups and reading the audit log are Enterprise entitlements. On a self-hosted instance they switch on with an Enterprise licence. The built-in owner, admin, member, manager and editor roles are there on every install, and the audit record is written on every install whether or not you can read it back yet.',
    },
    {
      id: 'billing',
      k: 'No metering in the way',
      v: 'A self-hosted instance runs its own gateway for its own model routing. It never sees or routes to Kortix credentials, and there is no platform fee on a self-hosted account.',
    },
  ],
} as const;

/* ── 6 · models ────────────────────────────────────────────────────────────
   `kortix providers set <provider> <key>` stores an encrypted project secret.
   The provider list is the literal map in apps/cli/src/commands/providers.ts. */
export const models = {
  eyebrow: 'Models',
  title: 'Any provider. Your keys. Your bill.',
  sub: 'A self-hosted instance has no managed model lineup and does not want one. You connect the providers you already pay for, and every model call routes through the gateway running on your own box.',
  shell: {
    title: 'connect a provider',
    lines: [
      '# stored as an encrypted project secret, injected at session boot',
      '$ kortix providers set anthropic sk-ant-...',
      '$ kortix providers set openai sk-...',
      '$ kortix providers set openrouter sk-or-...',
      '',
      '# or the subscription you already pay for',
      '$ kortix providers login chatgpt',
      '',
      '$ kortix providers ls',
      '→ anthropic · openai · openrouter',
    ],
  },
  points: [
    {
      id: 'routing',
      title: 'The gateway is yours',
      body: 'Sessions call the gateway inside your own stack, over your own domain or tunnel. Kortix has no credential in that path and no visibility into it.',
    },
    {
      id: 'anything',
      title: 'Anything you can reach',
      body: 'Anthropic, OpenAI, Google, Groq, xAI, DeepSeek, Mistral, Bedrock and OpenRouter, or the ChatGPT and Copilot subscription you already hold.',
    },
  ],
} as const;

/* ── 7 · where it runs ─────────────────────────────────────────────────────
   Sizing is the documented floor and the recommendation, both stated as such.
   Port facts: 80/443 inbound in domain mode only; everything else loopback. */
export const targets = {
  eyebrow: 'Where it runs',
  title: 'A laptop, a VPS, or your own network.',
  sub: 'It is the same Compose project everywhere. What changes is where you point the domain and how much you give it.',
  rows: [
    {
      id: 'laptop',
      k: 'A laptop',
      v: 'Evaluation, through a Cloudflare tunnel with no domain. The tunnel URL changes on every restart, so use it to try the product, not to run on it.',
    },
    {
      id: 'vps',
      k: 'A VPS or cloud VM',
      v: 'The production path. Point a domain and its API subdomain at the box, open 80 and 443, and the bundled proxy takes out a TLS certificate itself.',
    },
    {
      id: 'network',
      k: 'Your own VPC or on-prem',
      v: 'The same stack inside your network. Isolated and air-gapped topologies need the sandbox tier moved inside with it, which we scope with you.',
    },
  ],
  sizing: {
    label: 'What it wants',
    items: [
      { k: 'Machine', v: '2 vCPU / 4 GB floor, 4 vCPU / 16 GB for real use' },
      { k: 'Runtime', v: 'Docker Engine with the Compose plugin' },
      { k: 'Inbound', v: 'Ports 80 and 443, with a domain' },
      { k: 'DNS', v: 'A record for the domain and for api.<domain>' },
    ],
  },
} as const;

export const closing = {
  eyebrow: 'Two ways to run it',
  title: 'Run it yourself, or let us run it.',
  sub: 'Self-hosting is free and always will be. Kortix Cloud is the same product with the box, the upgrades and the sandbox tier taken off your hands.',
  ctaPrimary: 'Self-host free',
  ctaPrimaryHref: '/docs/host',
  ctaSecondary: 'Use Kortix Cloud',
  ctaSecondaryHref: '/auth',
  tertiary: 'Need it inside your own network, with SSO and a licence? Talk to us.',
  tertiaryLabel: 'Talk to us',
  tertiaryHref: '/enterprise',
} as const;
