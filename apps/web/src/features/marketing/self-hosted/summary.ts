/**
 * The /self-hosted page, condensed. Every line is a shorter form of a claim in
 * `content.ts`, whose header lists the facts corrected against the shipped CLI
 * (the wizard does not ask for GitHub or a model key; there is no air gap and
 * no Redis). Read it before changing a fact here. `**phrase**` renders in ink.
 *
 * English only for now: the long-form copy in `content.ts` keeps its
 * translations; this summary has none yet.
 */

/** The hero's description, shortened to two lines. The title and buttons
 *  still come from `content.ts` (translated). */
export const heroSub =
  'One Docker Compose stack, built from the images the cloud runs. Your data stays on disk you control, in code you can read.';

export const yoursSummary = {
  title: 'Your company stays on your side.',
  titleMuted: 'Sandbox compute runs on your provider.',
  body: [
    'Self-hosting is **the whole control plane**: accounts, projects, repos, secrets, policies and audit, inside your network on storage you back up.',
    '**Agent sandboxes run on the provider you configure**, Platinum by default. Fully isolated topologies are scoped with us.',
  ],
  cells: [
    { k: 'Your database', v: 'Postgres, as a directory you back up.' },
    { k: 'Your files', v: 'Storage, as a second directory next to it.' },
    { k: 'Every repo and secret', v: 'Held by the platform on your disk.' },
    { k: 'Your model gateway', v: 'Sessions route model calls through it.' },
  ],
} as const;

export const commandsSummary = {
  title: 'Start the stack.',
  titleMuted: 'Point the CLI at it.',
  sub: 'No provisioning step and no console to click through.',
  install: { k: 'Bring the stack up', v: 'One command starts the whole Compose project.' },
  hosts: { k: 'Point the CLI at it', v: 'kortix hosts use switches between self-hosted and cloud.' },
} as const;

export const firstRunSummary = {
  title: 'Six questions.',
  titleMuted: 'Everything else is generated.',
  body: [
    'The CLI asks **only what you can know**, then generates every port, URL, password and signing key itself.',
    'The instance lands in **one directory**, and every generated value can be rotated later.',
  ],
  cells: [
    { k: 'How it is reachable', v: 'A domain, or a Cloudflare tunnel to evaluate.' },
    { k: 'An admin email', v: 'Optional. It grants platform admin.' },
    { k: 'An Enterprise license', v: 'Unlocks SSO, SCIM, custom roles and groups.' },
    { k: 'Who creates organizations', v: 'Admins only, by default.' },
    { k: 'Your sandbox provider key', v: 'A Platinum key, the one required secret.' },
    { k: 'Connectors and updates', v: 'An optional app catalog, then nightly updates.' },
  ],
} as const;

export const stackSummary = {
  title: 'One Compose project.',
  titleMuted: 'No hidden pieces.',
  body: [
    'The same artifact runs **on a laptop, a VPS or a cloud VM**. A domain is one environment variable, not a different deployment.',
  ],
  cells: [
    { k: 'Two directories and a file', v: 'Back up the database, storage and .env.' },
    { k: 'It keeps itself current', v: 'Nightly migrate, then swap. Or pin a version.' },
    { k: 'TLS when you want it', v: 'The proxy is added only when you set a domain.' },
    { k: 'No separate backup service', v: 'Copy the instance directory to back it up.' },
  ],
} as const;

export const paritySummary = {
  title: 'Not a community edition.',
  titleMuted: 'The same images the cloud runs.',
  body: [
    'Self-hosted instances run **the same images the managed cloud runs**, from the same pipeline, on the same release train.',
  ],
  cells: [
    { k: 'The same images', v: 'Published Kortix images, never built locally.' },
    { k: 'The same product', v: 'Sessions, agents, connectors, triggers and reviews.' },
    { k: 'One honest exception', v: 'SSO, SCIM and audit read need an Enterprise license.' },
    { k: 'No platform fee', v: 'Your gateway, your keys, no metering.' },
  ],
} as const;

export const modelsSummary = {
  title: 'Any provider.',
  titleMuted: 'Your keys, your bill.',
  body: [
    'You connect the providers you already pay for. **Every model call routes through the gateway on your own box.**',
  ],
  cells: [
    { k: 'The gateway is yours', v: 'Kortix has no credential in that path.' },
    { k: 'Anything you can reach', v: 'Anthropic, OpenAI, Google, OpenRouter and more.' },
    { k: 'Or your subscription', v: 'Sign in with the ChatGPT plan you pay for.' },
  ],
} as const;

export const targetsSummary = {
  title: 'A laptop, a VPS, or your network.',
  titleMuted: 'The same Compose project everywhere.',
  body: ['What changes is **where you point the domain** and how much machine you give it.'],
  cells: [
    { k: 'A laptop', v: 'Evaluate through a tunnel. Its URL changes on restart.' },
    { k: 'A VPS or cloud VM', v: 'Point a domain, open 80 and 443, TLS is automatic.' },
    { k: 'Your VPC or on-prem', v: 'The same stack in your network, scoped with us.' },
  ],
} as const;
