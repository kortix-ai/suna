'use client';

import { CommandRow } from '@/features/marketing/v2/developer-kit';
import { CtaSection, HeroSection, ShowcaseSection } from '@/features/marketing/v2/page-kit';
import { Display, Lead, MAX_W, Section, SoftCard } from '@/features/marketing/v2/primitives';
import { RealVisual } from '@/features/marketing/v2/real-visual';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { desktopDownloadUrl } from '@/lib/desktop';
import { KORTIX_CLI_INSTALL_COMMAND } from '@/lib/kortix-cli';
import { useCallback } from 'react';

/** The `/download` route resolves the latest installer for each platform. */
const PLATFORMS: { name: string; platform: 'macos' | 'windows' | 'linux' }[] = [
  { name: 'macOS', platform: 'macos' },
  { name: 'Windows', platform: 'windows' },
  { name: 'Linux', platform: 'linux' },
];

/** Straight from the CLI reference in the docs. */
const CLI_COMMANDS: { command: string; effect: string }[] = [
  { command: 'kortix init my-app', effect: 'Scaffold a project with kortix.yaml and .kortix/.' },
  { command: 'kortix ship', effect: 'Lint the manifest, commit, push, and prompt for secrets.' },
  { command: 'kortix sessions new --wait', effect: 'Start a session on its own branch.' },
  { command: 'kortix sessions connect', effect: 'Attach your local coding agent to the sandbox.' },
  { command: 'kortix cr ls', effect: 'List the change requests waiting for review.' },
];

function SurfaceCards() {
  const { user } = useAuth();

  const start = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <SoftCard>
        <p className="text-foreground text-[1.125rem] font-medium">Web</p>
        <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.55]">
          Nothing to install. Open the browser and everything is already there.
        </p>
        <button
          type="button"
          onClick={start}
          className="bg-foreground text-background hover:bg-foreground/90 mt-6 inline-flex h-10 w-fit cursor-pointer items-center rounded-full px-5 text-[0.875rem] font-medium transition-colors"
        >
          Open Kortix
        </button>
      </SoftCard>

      <SoftCard>
        <p className="text-foreground text-[1.125rem] font-medium">CLI</p>
        <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.55]">
          kortix init, kortix sessions new, kortix ship — your company from the terminal.
        </p>
        <CommandRow command={KORTIX_CLI_INSTALL_COMMAND} className="mt-6" />
      </SoftCard>

      <SoftCard>
        <p className="text-foreground text-[1.125rem] font-medium">Desktop</p>
        <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.55]">
          The full command center, with native notifications.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          {PLATFORMS.map((entry) => (
            <a
              key={entry.platform}
              href={desktopDownloadUrl(entry.platform)}
              className="bg-foreground/[0.07] text-foreground hover:bg-foreground/10 inline-flex h-10 items-center rounded-full px-4 text-[0.875rem] font-medium transition-colors"
            >
              {entry.name}
            </a>
          ))}
        </div>
      </SoftCard>

      <SoftCard>
        <p className="text-foreground text-[1.125rem] font-medium">Mobile</p>
        <p className="text-muted-foreground mt-2 text-[0.9375rem] leading-[1.55]">
          Read what ran, approve a change request, and start a session from anywhere. Coming soon.
        </p>
      </SoftCard>
    </div>
  );
}

export default function DownloadPage() {
  return (
    <main className="bg-background">
      <HeroSection
        id="hero"
        heading="Kortix, everywhere you work."
        body="The command center in the browser, the CLI in your terminal, and your sessions in your pocket. Same projects, same agents, same permissions."
        visual="none"
      />

      <Section id="surfaces">
        <div className="mx-auto max-w-2xl text-center">
          <Display lines="Pick where you want to start." />
          <Lead className="mt-6">
            Nothing to migrate between them — it is one account and one set of projects.
          </Lead>
        </div>
        <SurfaceCards />
      </Section>

      <ShowcaseSection
        id="mobile"
        heading="Your sessions in your pocket."
        body="Start a session, read what came back, and connect the tools it needs, from your phone. Coming soon."
        visual="none"
      />

      <Section id="cli" tone="muted">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <Display lines="One curl and you are running." />
            <Lead className="mt-6">
              The CLI installs in one line, scaffolds a project, starts sessions, and attaches your
              local coding agent to any Kortix sandbox. The same binary is pre-authenticated inside
              every sandbox.
            </Lead>
            <CommandRow command={KORTIX_CLI_INSTALL_COMMAND} className="mt-8" />
            <dl className="mt-8">
              {CLI_COMMANDS.map((entry) => (
                <div key={entry.command} className="border-border border-t py-4">
                  <dt className="text-foreground font-mono text-[0.875rem]">{entry.command}</dt>
                  <dd className="text-muted-foreground mt-1.5 text-[0.9375rem] leading-[1.5]">
                    {entry.effect}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <RealVisual name="CliDemo" />
          </div>
        </div>
      </Section>

      <CtaSection
        id="cta"
        heading="Get the app. Start a session."
        body="It is the same account and the same projects on every surface."
      />
    </main>
  );
}
