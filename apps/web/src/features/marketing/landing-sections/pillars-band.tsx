import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { CheckIcon, CodeIcon, ShieldCheckIcon, UsersThreeIcon } from '@phosphor-icons/react/dist/ssr';

// The three pillars, in the founder's order and words (2026-10-27): Multiplayer
// AI; Sovereign, open source ("own your data and run on your own infra");
// Extensible ("your company as code … every piece of context, every agent").
// Every fact is a claims.md row: Channels, Permissions, Path to `main`,
// Source, Hosting, Models, Secrets, Connectors.
const PILLARS = [
  {
    id: 'multiplayer',
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
    id: 'sovereign',
    icon: ShieldCheckIcon,
    name: 'Sovereign, open source',
    line: 'Own your data and your infrastructure.',
    body: 'Kortix is open source. Run it on Kortix Cloud, in your VPC or on your own on-prem network, with any model and your own keys.',
    facts: [
      'Open source: read it, fork it, audit it',
      'Self-host in your VPC or on-prem',
      'Any model provider, your own keys',
      'Secrets encrypted per project',
    ],
  },
  {
    id: 'extensible',
    icon: CodeIcon,
    name: 'Extensible',
    line: 'Your company, as code.',
    body: 'We treat your whole company like code. Every agent, skill, rule, connector and piece of context is a file in one git repo: versioned, reviewed and extended like software.',
    facts: [
      'Every agent and skill a file in git',
      'Company memory as files agents read',
      '3,000+ apps, plus MCP, OpenAPI and raw HTTP',
      'A CLI and a TypeScript SDK',
    ],
  },
] as const;

/** The three pillars: each name is the cell's headline, its meaning under it. */
export function PillarsBand() {
  return (
    <section id="pillars" className="scroll-mt-16 py-20 lg:py-28">
      <Heading title="Multiplayer. Sovereign. Extensible." titleMuted="The AI OS your whole company owns." />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px lg:grid-cols-3">
          {PILLARS.map(({ id, icon: Icon, name, line, body, facts }) => (
            <li key={id} id={id} className="bg-background flex scroll-mt-16 flex-col gap-5 p-6 lg:p-11">
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
            </li>
          ))}
        </ul>
      </Band>
    </section>
  );
}
