import { Band, Heading } from '@/features/marketing/kit/page-frame';
import Link from 'next/link';
import {
  ArrowRightIcon,
  CheckIcon,
  CodeIcon,
  ShieldCheckIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react/dist/ssr';

// The three pillars, in the founder's order and words (kortix-brand D16):
// Multiplayer AI; Company as code (extensible); Sovereign and
// open ("own your data and run on your own infra"). Every fact is a claims.md
// row: Channels, Permissions, Path to `main`, Connectors, Source, Hosting,
// Models, Secrets. No "pi" in this copy (D20).
const PILLARS = [
  {
    id: 'multiplayer',
    href: '/multiplayer',
    icon: UsersThreeIcon,
    name: 'Multiplayer AI',
    line: 'One AI for the whole team.',
    body: 'Everyone works with the same agents, skills, memory and connectors. Start a session in the web app, in Slack or in Microsoft Teams.',
    facts: [
      'Shared agents, skills and memory',
      'Slack and Microsoft Teams',
      'Roles, groups and per-resource permissions',
      'A person approves what reaches main',
    ],
  },
  {
    id: 'company-as-code',
    href: '/framework',
    icon: CodeIcon,
    name: 'Company as code',
    line: 'Extensible to the core.',
    body: 'We treat your whole company like code. Every agent, skill, rule, connector and piece of context is a file in one git repo, and the agents and their harness are open source, so you can extend anything.',
    facts: [
      'Every agent and skill a file in git',
      'An open-source agent harness',
      '3,000+ apps, plus MCP, OpenAPI and raw HTTP',
      'A CLI and a TypeScript SDK',
    ],
  },
  {
    id: 'sovereign',
    href: '/sovereign',
    icon: ShieldCheckIcon,
    name: 'Sovereign and open',
    line: 'Own your data and your infrastructure.',
    body: 'Kortix is open source. Run it on Kortix Cloud, in your VPC or on your own on-prem network, with any model and your own keys.',
    facts: [
      'Open source: read it, fork it, audit it',
      'Self-host in your VPC or on-prem',
      'Any model provider, your own keys',
      'Secrets encrypted per project',
    ],
  },
] as const;

/** The three pillars: each name is the cell's headline, its meaning under it. */
export function PillarsBand() {
  return (
    <section id="pillars" className="scroll-mt-16 py-14 lg:py-20">
      <Heading
        title="Multiplayer. Company as code. Sovereign."
        titleMuted="The AI OS your whole company owns."
      />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px lg:grid-cols-3">
          {PILLARS.map(({ id, href, icon: Icon, name, line, body, facts }) => (
            <li
              key={id}
              id={id}
              className="bg-background flex scroll-mt-16 flex-col gap-5 p-6 lg:p-11"
            >
              <Icon className="text-foreground size-6" aria-hidden />
              <h3 className="text-foreground text-2xl font-medium tracking-tight text-balance">
                {name}
                <span className="text-muted-foreground block text-lg">{line}</span>
              </h3>
              <p className="text-muted-foreground text-base text-pretty">{body}</p>
              <ul className="mt-auto flex flex-col gap-2 text-sm">
                {facts.map((fact) => (
                  <li key={fact} className="text-foreground flex items-start gap-2">
                    <CheckIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {fact}
                  </li>
                ))}
              </ul>
              <Link
                href={href}
                className="text-foreground hover:text-muted-foreground outline-ring duration-normal inline-flex w-fit items-center gap-1.5 rounded-sm text-sm font-medium transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Learn more
                <ArrowRightIcon className="size-3.5" aria-hidden />
                <span className="sr-only">about {name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Band>
    </section>
  );
}
