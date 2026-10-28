'use client';

import { CodeTabs, type CodeTab } from '@/features/marketing/kit/code-tabs';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Block, CellGrid, Heading, KeyRows, PageFrame, PageHero } from '@/features/marketing/kit/page-frame';
import Link from 'next/link';

import { ArchitectureDiagram, CROSSINGS, CrossingMark, PARTS } from './architecture-diagram';
import { MANIFEST } from './content';

// Facts: framework/content.ts (the manifest gate), the docs sections
// "kortix.yaml reference", "Computers", "Automations", "SDK" and "Kortix UI".
// The SDK samples use only calls from the verified "Your first session" and
// "The thread alone" samples in content/docs/developers.mdx.

/** A kortix.yaml excerpt: MANIFEST lines [from, to), with `focus` given in
 *  MANIFEST line indexes so each range reads against the whole file. */
function excerpt(from: number, to: number, focus: readonly [number, number]): CodeTab['panel'] {
  return { title: 'kortix.yaml', lang: 'yaml', lines: MANIFEST.slice(from, to), focus: [focus[0] - from, focus[1] - from] };
}

const TABS: readonly CodeTab[] = [
  {
    id: 'agents',
    k: 'Declare your agents',
    v: 'One agent per job, grouped by team: engineering, marketing, sales. Each is a Markdown prompt and one entry that names its tools, connectors and skills. Access is deny-by-default.',
    // The three team agents (MANIFEST 40–63) under the `agents:` key.
    panel: { title: 'kortix.yaml', lang: 'yaml', lines: [MANIFEST[33], ...MANIFEST.slice(40, 64)], focus: [1, 25] },
  },
  {
    id: 'connectors',
    k: 'Connect your tools',
    v: 'GitHub, LinkedIn, HubSpot and 3,000+ more. Credentials stay in Kortix. A rule can hold an action, such as a LinkedIn post, until a person approves it.',
    panel: excerpt(7, 24, [10, 24]),
  },
  {
    id: 'triggers',
    k: 'Run them 24/7',
    v: 'A new GitHub issue, an inbound lead from your website, or a schedule starts the right agent with nobody at the keyboard.',
    panel: excerpt(65, MANIFEST.length, [65, MANIFEST.length]),
  },
  {
    id: 'secrets',
    k: 'Keep secrets out of the repo',
    v: 'kortix.yaml names the secrets a project needs, such as the ones that sign its webhooks. The values live encrypted in Kortix.',
    panel: excerpt(0, 15, [7, 9]),
  },
  {
    id: 'ship',
    k: 'Ship it',
    v: 'kortix init scaffolds the project. kortix ship pushes the repository and brings it live in the cloud.',
    panel: {
      title: 'terminal',
      lang: 'sh',
      lines: ['$ curl -fsSL https://kortix.com/install | bash', '$ kortix init', '$ kortix ship'],
    },
  },
];

// Facts: docs/guide.mdx "How it works", "Agents" (an agent acts as itself,
// personal accounts stay personal), "Security" and "Audit log".
const ISOLATION = [
  {
    id: 'sessions',
    k: 'Nothing leaks between sessions',
    v: 'A session never touches your laptop or another session. Its files, terminal and browser are its own.',
  },
  {
    id: 'identity',
    k: 'The agent is the identity',
    v: 'A session runs with the agent’s permissions, not your role. An agent can never give itself a permission it does not hold.',
  },
  {
    id: 'personal',
    k: 'Personal stays personal',
    v: 'Your own folder, private accounts and personal secrets reach only private sessions you started. Shared sessions and scheduled runs get none of them.',
  },
  {
    id: 'audit',
    k: 'Every action is on record',
    v: 'The audit log records who did what, whether it was allowed, and the person an agent acted for.',
  },
];

const CROSSING_ROWS = CROSSINGS.map((c) => ({
  id: String(c.n),
  k: (
    <span className="flex items-center gap-3">
      <CrossingMark n={c.n} />
      {c.k}
    </span>
  ),
  v: c.v,
}));

const LOOPS = [
  { id: 'cron', k: 'Schedules', v: 'Cron, every few minutes, or once at a set time.' },
  { id: 'webhook', k: 'Webhooks', v: 'Signed requests from any system start a session.' },
  { id: 'events', k: 'App events', v: 'Your own Apps post events that start agents.' },
  { id: 'goals', k: 'Goals', v: 'An agent owns an objective until a separate check confirms it.' },
  { id: 'reminders', k: 'Reminders', v: 'A session wakes itself later and continues with its history.' },
];

const SDK_SAMPLE = `import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: 'https://api.kortix.com/v1',
  getToken: async () => process.env.KORTIX_API_KEY ?? null,
});

const [project] = await kortix.projects.list();
if (!project) throw new Error('No project.');
const projectId = project.project_id;

const { session_id } = await kortix
  .project(projectId)
  .sessions.create({ name: 'Nightly report' });
const session = kortix.session(projectId, session_id);
await session.ensureReady();
await session.send('Summarize yesterday’s orders.');`;

const UI_SAMPLE = `import { useSession } from '@kortix/sdk/react';
import { SessionThread } from '@kortix/ui/session';

type Props = { projectId: string; sessionId: string };

export function Chat({ projectId, sessionId }: Props) {
  const session = useSession(projectId, sessionId);
  return <SessionThread session={session} />;
}`;

function Code({ title, code }: { title: string; code: string }) {
  return (
    <div className="bg-background flex min-w-0 flex-col">
      <p className="text-muted-foreground border-b px-4 py-3 font-mono text-xs lg:px-6">{title}</p>
      <pre className="text-foreground overflow-x-auto p-4 font-mono text-xs leading-relaxed lg:p-6">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function FrameworkPage() {
  return (
    <PageFrame>
      <PageHero
        title="The Kortix framework."
        titleMuted="A backend for agents. Everything is code."
        sub="The workspace is how your team uses Kortix. Underneath, a project is a git repository: kortix.yaml declares the agents, skills, tools and triggers, every session runs the open-source pi coding agent on its own computer, and @kortix/sdk and @kortix/ui let you build your own experience on top."
        actions={
          <>
            <MarketingButton size="md" className="hit-area-y-1" asChild>
              <Link href="/docs/developers#kortixyaml-reference">Read the kortix.yaml reference</Link>
            </MarketingButton>
            <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
              <a href="https://github.com/kortix-ai/suna" target="_blank" rel="noreferrer">
                View on GitHub
              </a>
            </MarketingButton>
          </>
        }
      />

      <Block id="architecture">
        <Heading
          title="How it fits together."
          titleMuted="Clients, one API, a computer per session, and Drive."
          sub="A client calls the Kortix API. The API starts each session on its own cloud computer, between the project repository and the LLM gateway, with Drive folders open inside it."
        />
        <Band className="mt-12">
          <ArchitectureDiagram />
        </Band>
        <div className="mt-12">
          <KeyRows rows={PARTS} />
        </div>
      </Block>

      <Block id="files">
        <Heading title="Everything is a file." titleMuted="Your company, versioned like software." />
        <Band className="mt-12">
          <CodeTabs label="The Kortix framework" tabs={TABS} />
        </Band>
      </Block>

      <Block id="isolation">
        <Heading
          title="Every agent works on its own computer."
          titleMuted="Its edge is where policy holds."
          sub="Work leaves the session computer in six ways. Each one is checked outside the agent’s reach, and the numbers match the diagram above."
        />
        <div className="mt-10">
          <KeyRows rows={CROSSING_ROWS} />
        </div>
        <Band className="mt-12">
          <CellGrid items={ISOLATION} cols="lg:grid-cols-4" />
        </Band>
      </Block>

      <Block id="compose">
        <Heading
          title="Compose your own experience."
          titleMuted="The workspace is one client. Build yours."
          sub="@kortix/sdk is one typed client for projects, sessions and the live event stream, for servers and browsers. @kortix/ui is the same React components the Kortix web app is built from."
          actions={
            <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
              <Link href="/docs/developers#sdk">Read the SDK docs</Link>
            </MarketingButton>
          }
        />
        <Band className="mt-12">
          <div className="bg-border grid grid-cols-1 gap-px xl:grid-cols-2">
            <Code title="nightly-report.mts · @kortix/sdk" code={SDK_SAMPLE} />
            <Code title="chat.tsx · @kortix/ui" code={UI_SAMPLE} />
          </div>
        </Band>
      </Block>

      <div className="pb-20 lg:pb-28">
        <Block id="loops">
          <Heading title="Runs 24/7." titleMuted="Agent loops with nobody at the keyboard." />
          <Band className="mt-12">
            <CellGrid items={LOOPS} cols="lg:grid-cols-5" />
          </Band>
        </Block>
      </div>
    </PageFrame>
  );
}
