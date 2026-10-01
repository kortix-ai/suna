/**
 * `/launch` copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate. Wire i18n keys once the
 * page is announced. Voice and every claim: the `kortix-brand` skill (§1 positioning,
 * §3 message house, §4 proof points). No invented metric, no customer name.
 */

export const hero = {
  title: 'The open-source AI Management System',
  sub: 'Your agents, skills, company memory and connectors in one git repo you own. Any model, your keys, self-hosted or managed cloud.',
  ctaPrimary: 'Get started',
  ctaPrimaryHref: '/auth',
  ctaSecondary: 'Star on GitHub',
  ctaSecondaryHref: 'https://github.com/kortix-ai/suna',
} as const;

export const pillars = {
  eyebrow: 'What ships',
  title: 'Run your whole company from one place you own.',
  sub: 'A workforce of AI agents that does real work — on real cloud computers, from one repo, through change requests a person approves.',
  items: [
    {
      id: 'open',
      title: 'Open and yours',
      body: 'Open source and self-hostable. Your data, your models, your infrastructure. No lock-in, and every line auditable.',
      href: '/self-hosted',
      link: 'Self-hosting',
    },
    {
      id: 'workforce',
      title: 'A workforce, not one assistant',
      body: 'Specialist agents run in parallel, each session on its own cloud computer and its own branch, and they compound a shared memory.',
      href: '/agent-computer',
      link: 'The agent computer',
    },
    {
      id: 'work',
      title: 'Real work, not chat',
      body: 'Agents return finished deliverables and take real actions in your tools — on demand, human-assisted, or on a schedule.',
      href: '/automations',
      link: 'Automations',
    },
    {
      id: 'code',
      title: 'Everything is code',
      body: 'Versioned, reviewable, portable, governable. Work reaches main through a change request a person approves.',
      href: '/company-as-code',
      link: 'Company as code',
    },
  ],
} as const;

export const start = {
  eyebrow: 'Start',
  title: 'Two commands.',
  sub: 'kortix init turns any directory into a Kortix project. kortix ship checks it, asks for missing secrets, pushes it, and runs it. The repo behaves the same on your laptop as in the cloud.',
  shell: {
    title: 'terminal',
    lines: ['kortix init northwind', 'cd northwind', 'kortix ship'],
  },
} as const;

/** The marketing design reference: what the film and this page are drawn with. */
export const kit = {
  eyebrow: 'Design reference',
  title: 'One design system, from the product to the film.',
  sub: 'The film is a route in the web app. It uses the product’s tokens, fonts, marks and recordings, and every frame is a function of the frame number — so it renders to MP4 and plays live on this page.',
  filmHref: '/presentations/film/launch',
  filmLink: 'Open the film full screen',
  colors: [
    { token: 'bg-background', label: 'Canvas' },
    { token: 'bg-popover', label: 'Panel' },
    { token: 'bg-muted', label: 'Inset' },
    { token: 'bg-muted-foreground', label: 'Muted ink' },
    { token: 'bg-foreground', label: 'Ink' },
    { token: 'bg-kortix-green', label: 'Merged — the one accent' },
  ],
  type: [
    { sample: 'The open-source AI Management System', spec: 'Roobert Medium · tight tracking · headlines' },
    { sample: 'kortix ship', spec: 'Roobert Mono · commands, paths, branches only', mono: true },
  ],
  motion: [
    'Opacity on a short ease-out; transform on a curve three times longer.',
    'Springs with zero bounce. Entering scale never below 0.92.',
    'Blur only as a bridge between two states.',
    'A compressing stagger, never a marching one.',
    'Cuts land on the bar: 120 BPM, one bar is two seconds.',
    'One accent, spent where the product spends it: merged.',
  ],
} as const;
