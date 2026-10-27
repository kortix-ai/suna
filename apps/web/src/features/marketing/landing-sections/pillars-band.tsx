import { FeatureSplit } from '@/features/marketing/kit/feature-split';
import { Heading } from '@/features/marketing/kit/page-frame';

// The three pillars, in the founder's order and words (kortix-brand D16):
// Multiplayer AI; Company as code ("extensible, powered by pi"); Sovereign and
// open ("own your data and run on your own infra"). Each is its own section
// so the Product menu's anchors (#multiplayer, #company-as-code, #sovereign)
// land on it. Every fact is a claims.md row: Channels, Permissions, Path to
// `main`, Harness, Connectors, Source, Hosting, Models, Secrets.
const PILLARS = [
  {
    id: 'multiplayer',
    title: 'Multiplayer AI.',
    titleMuted: 'One AI for the whole team.',
    body: [
      'Everyone works with **the same agents, skills, memory and connectors**. Start a session in the web app, in Slack or in Microsoft Teams.',
      'Roles decide who may do what, and **a person approves what reaches main**.',
    ],
    cells: [
      { k: 'Shared by the team', v: 'Every agent, skill and memory is the same for everyone.' },
      { k: 'Slack and Microsoft Teams', v: 'Start or continue a session where your team already talks.' },
      { k: 'Permissions', v: 'Roles, groups and per-resource permissions for people and agents.' },
      { k: 'Approval', v: 'Work reaches main through a change request a person approves.' },
    ],
  },
  {
    id: 'company-as-code',
    title: 'Company as code.',
    titleMuted: 'Extensible, powered by pi.',
    body: [
      'We treat your whole company like code. **Every agent, skill, rule, connector and piece of context is a file in one git repo.**',
      'Every session runs **pi, the open-source agent harness**, so you can extend anything.',
    ],
    cells: [
      { k: 'Files in git', v: 'Agents and skills you version, review and roll back.' },
      { k: 'pi', v: 'Every session runs on the open-source agent harness.' },
      { k: 'Connectors', v: '3,000+ apps, plus MCP, OpenAPI and raw HTTP.' },
      { k: 'CLI and SDK', v: 'Script it from the CLI, build on it with the TypeScript SDK.' },
    ],
  },
  {
    id: 'sovereign',
    title: 'Sovereign and open.',
    titleMuted: 'Own your data and your infrastructure.',
    body: [
      'Kortix is **open source**. Run it on Kortix Cloud, **in your VPC or on your own on-prem network**.',
      'Use **any model provider with your own keys**. Your data stays on infrastructure you choose.',
    ],
    cells: [
      { k: 'Open source', v: 'Read it, fork it, audit it.' },
      { k: 'Self-hosted', v: 'Your VPC or your own on-prem network.' },
      { k: 'Any model', v: 'Any provider, your own keys.' },
      { k: 'Secrets', v: 'Encrypted at rest with a key per project.' },
    ],
  },
] as const;

/** The three pillars: a short intro, then one full section per pillar. */
export function PillarsBand() {
  return (
    <div id="pillars" className="scroll-mt-16 pt-20 lg:pt-28">
      <Heading title="Multiplayer. Company as code. Sovereign." titleMuted="The AI OS your whole company owns." />
      {PILLARS.map((pillar) => (
        <FeatureSplit key={pillar.id} {...pillar} cols="lg:grid-cols-4" />
      ))}
    </div>
  );
}
