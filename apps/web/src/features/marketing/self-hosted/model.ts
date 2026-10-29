import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
/**
 * `/self-hosted` copy: how to run Kortix on your own server. /sovereign says
 * why; this page says how. English only for now.
 *
 * Every line was checked on 2026-10-28 against the source named above its
 * block. "developers.mdx" is `apps/web/content/docs/developers.mdx`, section
 * "Self-hosting". Terminal output is the real CLI: `kortix self-host init`,
 * `doctor` and `version` were run against a scratch instance, the `start`
 * lines are `apps/cli/src/commands/self-host.ts:546-548`, and the install
 * lines are the `info`/`ok` calls in `scripts/install.sh`.
 *
 * Standing rules (kortix-brand `claims.md`):
 *  - Never "air-gapped". Sessions and Drive run on Platinum, and the instance
 *    must be reachable from the internet so the sandboxes can call back.
 *  - No egress filtering claim. No sizing numbers: the docs state none.
 *  - Never name a license. No price references, no "free".
 *  - Sample data uses the fictional Arcadia.
 */

/* Hero. Sources: developers.mdx intro, "Install by hand", "Secure the
   instance"; the CLI runs named above. */
export const hero = {
  title: 'Self-host Kortix.',
  titleMuted: 'One CLI, one server, the whole platform.',
  sub: 'The kortix CLI installs the web app, the API, the LLM gateway and the database on your server as one Docker Compose stack. Then it keeps the stack up to date.',
  guide: { label: 'Read the self-hosting guide', href: '/docs/developers#self-hosting' },
  why: { label: 'Why self-host', href: '/sovereign' },
  caption: 'Four commands on a Linux server with Docker.',
  captionMuted: 'Then sign in at your own domain.',
} as const;

export type Step = {
  readonly id: 'install' | 'init' | 'start' | 'doctor';
  readonly label: string;
  readonly title: string;
  readonly lines: readonly string[];
  readonly line: string;
};

export const steps: readonly Step[] = [
  {
    id: 'install',
    label: 'Install the CLI',
    title: 'Terminal: your server',
    lines: [
      '$ curl -fsSL https://kortix.com/install | bash',
      '▸  Resolving latest release from GitHub…',
      '✓  Latest release: <version>',
      '✓  Checksum verified (<sha256>)',
      '✓  Installed binary at /home/ops/.kortix/kortix',
    ],
    line: 'One line installs the kortix CLI. It runs on Linux and macOS, on x86_64 and arm64.',
  },
  {
    id: 'init',
    label: 'Configure',
    title: 'Terminal: your server',
    lines: [
      '$ kortix self-host init --domain kortix.arcadia.example --admin-email ops@arcadia.example',
      '✓  Self-host config created',
      'Dashboard https://kortix.arcadia.example',
      'API       https://api.kortix.arcadia.example',
      'Channel   stable (auto-update: on, nightly at 02:00 America/New_York)',
    ],
    line: 'init writes the Compose file and the .env, and generates every password and signing key.',
  },
  {
    id: 'start',
    label: 'Start',
    title: 'Terminal: your server',
    lines: [
      '$ kortix self-host start',
      '✓  Self-hosted Kortix is starting',
      'Dashboard: https://kortix.arcadia.example',
      'Logs:      kortix self-host logs',
    ],
    line: 'start pulls the images and brings up the stack, with a TLS certificate for your domain.',
  },
  {
    id: 'doctor',
    label: 'Check',
    title: 'Terminal: your server',
    lines: [
      '$ kortix self-host doctor',
      '✓  docker Docker version 29.9.2, build a82e528',
      '✓  docker-compose Docker Compose version v5.6.1',
      '✓  compose-config valid',
      '✓  capture-store bundled Kortix Capture store present',
      '✓  email-url smtp (smtp://***@smtp.arcadia.example:587)',
      '✓  preview-origins p.kortix.arcadia.example',
      '✓  open-sign-up new accounts must confirm their email',
    ],
    line: 'doctor checks Docker, the config, email, previews and sign-up. Fix every failing check.',
  },
];

/* Pillars. Sources: developers.mdx intro, "What runs where", "Updates and
   versions", "Configure" (Enterprise license row), "Commands"; CLI help
   (`kortix self-host --help`); claims.md SAML 2.0 rule. */
export const pillars = {
  title: 'Everything to run it yourself.',
  titleMuted: 'One CLI, one stack, daily updates, Enterprise when you need it.',
  items: [
    {
      id: 'cli',
      name: 'One CLI',
      line: 'Install, configure, update, check.',
      facts: [
        'kortix self-host does all of it',
        'Questions on the first run',
        'Every setting in one .env',
      ],
    },
    {
      id: 'stack',
      name: 'One stack',
      line: 'Docker Compose on your server.',
      facts: [
        'Web app, API and LLM gateway',
        'Postgres and file storage',
        'TLS from Caddy on your domain',
      ],
    },
    {
      id: 'updates',
      name: 'Daily updates',
      line: 'Or pin one exact version.',
      facts: [
        'Track stable or latest',
        'The database migrates first',
        'Roll back with one command',
      ],
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      line: 'One flag on your instance.',
      facts: ['SAML 2.0 single sign-on and SCIM', 'Role-based access control', 'Audit'],
    },
  ],
} as const;

/* Topics, one tab each.
   where: developers.mdx "What runs where" (services table, "Off the box").
   reach: developers.mdx "Reachability modes", "Evaluate with a Cloudflare
     tunnel".
   setup: developers.mdx "First sign-in and setup" steps 1-7, and the
     sign-up warning in the intro.
   updates: developers.mdx "Updates and versions".
   enterprise: developers.mdx "Configure" (Enterprise license row),
     "Commands" flags (`--enterprise-license` with init/configure/update),
     "The platform admin console"; guide.mdx "Run Kortix on your own
     infrastructure".
   needs: developers.mdx "Requirements". */
export const topics = {
  title: 'How self-hosting works.',
  titleMuted: 'From the first command to the daily update.',
  tabs: [
    {
      id: 'where',
      title: 'What runs where',
      description: 'Your server, and Platinum.',
      body: [
        'init writes one Docker Compose project. Every service in it runs on your server.',
        'Sessions and Drive run on Platinum sandboxes. They call back to your instance.',
      ],
    },
    {
      id: 'reach',
      title: 'Reachability',
      description: 'A domain, or a tunnel to evaluate.',
      body: [
        'Sandboxes must reach your instance from the internet, so it needs a public URL.',
        'A domain is the production setup. A Cloudflare tunnel lets you try Kortix on your own machine.',
      ],
    },
    {
      id: 'setup',
      title: 'First sign-in',
      description: 'Six steps in the web app.',
      body: [
        'Sign up with the admin email as soon as the stack starts.',
        'Until you turn on email or close sign-up, anyone who reaches the instance can create an account.',
      ],
    },
    {
      id: 'updates',
      title: 'Updates and versions',
      description: 'Daily, or pinned.',
      body: [
        'The updater checks once a day. It migrates the database first. If a migration fails, nothing is swapped.',
        'With two replicas, new containers pass a health check before the old ones stop.',
      ],
    },
    {
      id: 'enterprise',
      title: 'Enterprise on your server',
      description: 'One flag, every account.',
      body: [
        'With Enterprise, one flag turns on the Enterprise features for every account on the instance.',
        'Platform admins run the whole instance from /admin.',
      ],
    },
    {
      id: 'needs',
      title: 'Requirements',
      description: 'What the server needs.',
      body: [
        'A Linux server with a public IP. The bootstrap script installs Docker and the Compose plugin when they are missing.',
      ],
    },
  ],
} as const;

export type TopicId = (typeof topics.tabs)[number]['id'];

/** developers.mdx "What runs where": the services, then "Off the box". */
export const whereGroups = [
  {
    k: 'Your server',
    rows: [
      { k: 'frontend', v: 'The web app' },
      { k: 'kortix-api', v: 'The REST API' },
      { k: 'llm-gateway', v: 'The LLM gateway' },
      { k: 'supabase-*', v: 'Postgres, auth and file storage' },
      { k: 'kortix-updater', v: 'Pulls, migrates and rolls daily' },
      { k: 'caddy', v: 'TLS on 80 and 443, domain mode' },
    ],
  },
  {
    k: 'Platinum',
    rows: [
      { k: 'Sessions', v: 'One sandbox per session' },
      { k: 'Drive', v: 'Platinum volumes' },
    ],
  },
] as const;

/** developers.mdx "Reachability modes". */
export const reachModes = [
  {
    k: 'domain',
    flag: '--domain <domain>',
    v: 'Production. HTTPS on your domain and api.<domain>.',
    sessions: true,
  },
  {
    k: 'tunnel',
    flag: '--tunnel cloudflare',
    v: 'Evaluation. The API gets a public tunnel URL.',
    sessions: true,
  },
  { k: 'local', flag: 'neither flag', v: 'Every port binds 127.0.0.1.', sessions: false },
] as const;

/** developers.mdx "First sign-in and setup", in order. */
export const setupSteps = [
  { k: 'Sign up as the admin', v: 'With an address in the admin list.' },
  { k: 'Connect GitHub', v: 'At /admin/git, for new project repositories.' },
  { k: 'Create the team account', v: 'Invite your team and set up SSO there.' },
  { k: 'Create a project', v: 'In the team account.' },
  { k: 'Add a model key', v: 'Each project connects its own provider.' },
  { k: 'Turn on email, close sign-up', v: 'EMAIL_URL, then DISABLE_SIGNUP=true.' },
] as const;

export const updateLines = [
  '# apply the channel now',
  '$ kortix self-host update',
  '',
  '# switch to every release',
  '$ kortix self-host update --channel latest',
  '',
  '# pin one version, or go back to one',
  '$ kortix self-host update --tag <version>',
  '$ kortix self-host rollback --release <version>',
] as const;

export const enterpriseLines = [
  '$ kortix self-host configure --enterprise-license',
  '$ kortix self-host start',
] as const;

/** claims.md SAML 2.0 rule; developers.mdx "Configure" Enterprise row. */
export const enterpriseFeatures = [
  'SAML 2.0 single sign-on',
  'SCIM directory sync',
  'Role-based access control',
  'Audit',
] as const;

/** developers.mdx "Requirements". */
export const needs = [
  { k: 'Server', v: 'Linux, with a public IP' },
  { k: 'Runtime', v: 'Docker Engine and the Compose plugin' },
  { k: 'DNS', v: '<domain>, api.<domain> and *.p.<domain>' },
  { k: 'Ports', v: '80 and 443, inbound' },
  { k: 'Sandboxes', v: 'A Platinum API key' },
  { k: 'Models', v: 'A provider key, added in the web app' },
] as const;

/* FAQ. Sources per answer: claims.md "air-gapped" rule and developers.mdx
   intro, "What runs where" (images on Docker Hub); developers.mdx "Evaluate
   with a Cloudflare tunnel"; developers.mdx "Connect your clients" and
   self-host.ts:455 (the `hosts use` hint); developers.mdx "First sign-in and
   setup" step 5; developers.mdx "Updates and versions"; developers.mdx "Back
   up and uninstall"; developers.mdx "Several instances on one server". */
export const faqItems = [
  {
    id: 'air-gapped',
    question: 'Can a self-hosted Kortix run air-gapped?',
    answer:
      'No. The stack pulls its images from Docker Hub, and sessions run on Platinum sandboxes that call back to your instance over the internet. For an isolated topology, talk to us: we scope it with you.',
  },
  {
    id: 'laptop',
    question: 'Can I try it on my own machine first?',
    answer:
      'Yes. Run kortix self-host init --tunnel cloudflare, then kortix self-host start. The web app opens at http://localhost:13737, and the API gets a public trycloudflare.com URL that changes each time the tunnel restarts.',
  },
  {
    id: 'cli',
    question: 'How do I point the kortix CLI at my instance?',
    answer:
      'kortix self-host start registers a CLI host named selfhost. Switch with kortix hosts use selfhost, and back with kortix hosts use cloud.',
  },
  {
    id: 'models',
    question: 'Which models can a self-hosted instance use?',
    answer:
      'The providers each project connects, with its own keys. A self-hosted instance has no Kortix-managed models. A project can also connect Platinum as its provider with a Platinum API key.',
  },
  {
    id: 'update-fails',
    question: 'What happens when an update fails?',
    answer:
      'A failed migration swaps nothing, and the previous version keeps serving. A failed swap keeps the previous version too. kortix self-host status shows the outcome of the last run.',
  },
  {
    id: 'backup',
    question: 'How do I back up the instance?',
    answer:
      'Stop the stack, copy the instance directory and its four Docker volumes, then start it again. Drive folders and session workspaces live at Platinum, so a server backup does not hold them.',
  },
  {
    id: 'instances',
    question: 'Can one server run several instances?',
    answer:
      'Yes. Pass --instance <name> to every command. Only one instance per server can use domain mode, because Caddy binds ports 80 and 443.',
  },
] as const;

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      steps,
      pillars,
      topics,
      whereGroups,
      reachModes,
      setupSteps,
      updateLines,
      enterpriseLines,
      enterpriseFeatures,
      needs,
      faqItems,
    },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
}
