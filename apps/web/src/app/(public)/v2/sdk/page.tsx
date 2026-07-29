'use client';

import { type CodeTab, CodeWindow, DocLinks } from '@/features/marketing/v2/developer-kit';
import {
  CtaSection,
  GridSection,
  HeroSection,
  SplitSection,
} from '@/features/marketing/v2/page-kit';
import { MAX_W } from '@/features/marketing/v2/primitives';
import { VisualStage } from '@/features/marketing/v2/real-visual';
import { cn } from '@/lib/utils';

/**
 * Every snippet below is the shipped `@kortix/sdk` surface, taken from
 * apps/web/content/docs/sdk. Nothing here is illustrative.
 */
const TABS: CodeTab[] = [
  {
    name: 'install',
    language: 'bash',
    code: 'npm install @kortix/sdk',
  },
  {
    name: 'client.ts',
    language: 'ts',
    code: `import { createKortix } from '@kortix/sdk';

// Create an API key at User settings → API keys. It starts with
// kortix_pat_ and the SDK asks for it on every request — your host
// owns token storage and refresh.
export const kortix = createKortix({
  backendUrl: 'https://api.kortix.com/v1',
  getToken: async () => process.env.KORTIX_API_KEY!,
});`,
  },
  {
    name: 'session.ts',
    language: 'ts',
    code: `// Creating a session is a cheap platform call — no sandbox exists yet.
const created = await kortix.project(projectId).sessions.create();
const session = kortix.session(projectId, created.session_id);

// ensureReady() provisions or resumes the session's own sandbox.
await session.ensureReady();

// send() calls ensureReady() for you, then sends the message.
await session.send('Add a README');`,
  },
  {
    name: 'stream.ts',
    language: 'ts',
    code: `import { narrowChatEvent } from '@kortix/sdk';

// Connect the stream before you send, so no early events are missed.
const stream = await session.stream({
  onEvent: (event) => {
    const e = narrowChatEvent(event);
    if (!e) return;
    if (e.type === 'message.part.updated') process.stdout.write('.');
    if (e.type === 'session.error') console.error(e.error);
  },
});

await session.send('What files are in this repo?');`,
  },
];

const DOCS = [
  { name: 'SDK docs', href: '/docs/sdk' },
  { name: 'Auth', href: '/docs/sdk/auth' },
  { name: 'Sessions', href: '/docs/sdk/sessions' },
  { name: 'React hooks', href: '/docs/sdk/react' },
  { name: 'Full example', href: '/docs/sdk/example' },
];

export default function SdkPage() {
  return (
    <main className="bg-background">
      <HeroSection
        id="hero"
        heading="Kortix, as a typed client."
        body="One SDK for the Kortix API and the agent runtime. Create projects, start sessions, stream output, and open change requests from your own code."
        visual="none"
      >
        <div className={cn(MAX_W, 'mt-16')}>
          <VisualStage size="lg">
            <CodeWindow tabs={TABS} />
          </VisualStage>
          <DocLinks links={DOCS} className="mt-8" />
        </div>
      </HeroSection>

      <GridSection
        id="what-you-build"
        heading="Kortix as your backend."
        body="The web app is built on this API. There is no private surface you cannot reach."
        bullets={[
          'Start sessions. Create a session, send a prompt, pick the agent, and stream the result.',
          'Ship your own front end. Put your product in front of Kortix and let it do the work underneath.',
          'Service accounts. Machine identities with their own scoped permissions, separate from people.',
          'Everything the app does. Projects, agents, skills, connectors, secrets, triggers, and change requests.',
        ]}
        columns={2}
      />

      <SplitSection
        id="one-surface"
        heading="The SDK, the CLI, and MCP all speak to the same API."
        body="Pick whichever fits the job. The permissions, the audit trail, and the change-request gate are identical whichever door the work comes through."
        bullets={[
          'Same scoped tokens and same per-resource permissions',
          'Same isolation: one session, one sandbox, one branch',
          'Same review gate before anything reaches main',
          'Same behaviour on Kortix Cloud and self-hosted',
        ]}
        visual="CliDemo"
        tone="muted"
      />

      <CtaSection
        id="cta"
        heading="Install it and start a session."
        body="The docs cover the client, the auth model, and the streaming API."
      />
    </main>
  );
}
