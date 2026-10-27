import { Band, Heading } from '@/features/marketing/kit/page-frame';
import { CheckIcon, CodeIcon, ShieldCheckIcon, UsersThreeIcon } from '@phosphor-icons/react/dist/ssr';

// The three pillars (positioning v2, founder 2026-10-27). Every fact is a
// claims.md row: Channels, Permissions, Path to `main`, Connectors, the
// trigger types, Source, Models, Hosting, Secrets.
const PILLARS = [
  {
    id: 'multiplayer',
    icon: UsersThreeIcon,
    label: 'Multiplayer AI',
    title: 'One AI for the whole team.',
    body: 'Everyone works with the same agents, skills, memory and connectors. Start a session in the web app, in Slack or in Microsoft Teams.',
    facts: [
      'Shared agents, skills and memory',
      'Slack and Microsoft Teams',
      'Roles, groups and per-resource permissions',
      'A person approves what reaches main',
    ],
  },
  {
    id: 'code-first',
    icon: CodeIcon,
    label: 'Extensible, code-first',
    title: 'Everything is code you can change.',
    body: 'Agents, skills, rules and connectors are files in one git repo. Connect any API, script it from the CLI, build on it with the SDK.',
    facts: [
      'Agents and skills as files in git',
      '3,000+ apps, plus MCP, OpenAPI and raw HTTP',
      'Cron and webhook triggers',
      'A CLI and a TypeScript SDK',
    ],
  },
  {
    id: 'sovereign',
    icon: ShieldCheckIcon,
    label: 'Sovereign',
    title: 'Your company stays yours.',
    body: 'Open source, any model, and it runs where you choose: Kortix Cloud, your VPC or your own on-prem network.',
    facts: [
      'Open source: read it, fork it, audit it',
      'Any model provider, your own keys',
      'Kortix Cloud, your VPC or on-prem',
      'Secrets encrypted per project',
    ],
  },
] as const;

/** The three pillars as three equal cells between the rails. */
export function PillarsBand() {
  return (
    <section id="pillars" className="scroll-mt-16 py-20 lg:py-28">
      <Heading title="Multiplayer. Code-first. Sovereign." titleMuted="The AI OS your whole company owns." />
      <Band className="mt-12">
        <ul className="bg-border grid grid-cols-1 gap-px lg:grid-cols-3">
          {PILLARS.map(({ id, icon: Icon, label, title, body, facts }) => (
            <li key={id} id={id} className="bg-background flex scroll-mt-16 flex-col gap-5 p-6 lg:p-11">
              <div className="flex items-center gap-2">
                <Icon className="text-foreground size-5" aria-hidden />
                <p className="text-muted-foreground text-sm">{label}</p>
              </div>
              <h3 className="text-foreground text-xl font-medium tracking-tight text-balance">{title}</h3>
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
