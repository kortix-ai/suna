import { useTranslations } from '@/i18n/use-translations';
import Image from 'next/image';
import type { ReactNode } from 'react';
import { localizeMarketingContent } from './parts';

import { SlackWindow, TeamsWindow } from './chat';
import type { SurfaceId } from './content';
import { DesktopShot, TerminalFrame } from './frames';

/*
 * One hero visual per surface page: Kortix as it looks on that surface.
 * Desktop and mobile are screenshots of the shipped apps; the CLI, Slack and
 * Teams are drawn at real text size so they stay readable at 390 px. Every
 * one shows the same synthetic Arcadia project (parts.tsx).
 */

/** The App Store listing frames (640x1385), in store order. */
const STORE_SHOTS = [
  { n: 1, alt: 'Kortix in your pocket: a session that turns reading notes into one small first step.' },
  { n: 2, alt: 'Start with one task: tell your agent what you want to get done.' },
  { n: 3, alt: 'Choose your model: open-source models and providers.' },
  { n: 4, alt: 'Connect your tools: connect an app such as Notion when your agent needs it.' },
  { n: 5, alt: 'Preview what is built: open a live app preview inside your session.' },
  { n: 6, alt: 'Your projects, one place: the session list with its status dots.' },
] as const;

/** The shipped desktop app on a real session. */
function DesktopStage() {
  return (
    <div className="w-full max-w-6xl">
      <DesktopShot />
    </div>
  );
}

/** The App Store listing: six frames, one row on desktop, a swipeable row on a phone. */
function MobileStage() {
  return (
    <ul className="flex w-full max-w-6xl snap-x snap-mandatory gap-4 overflow-x-auto lg:grid lg:grid-cols-6 lg:overflow-visible">
      {STORE_SHOTS.map(({ n, alt }) => (
        <li key={n} className="w-44 shrink-0 snap-center overflow-hidden rounded-md border lg:w-auto">
          <Image
            src={`/images/mobile-app/store-0${n}.webp`}
            alt={alt}
            width={640}
            height={1385}
            sizes="(min-width: 1024px) 180px, 176px"
            className="block h-auto w-full"
          />
        </li>
      ))}
    </ul>
  );
}

/** Real commands: install, sign in, one prompt, the change request, the merge. */
function CliStage() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { PROMPT, RESULT } = localizeMarketingContent(tMarketing);

  return (
    <div className="w-full max-w-4xl">
      <TerminalFrame
        title="~/arcadia"
        lines={[
          { kind: 'cmd', text: 'curl -fsSL https://kortix.com/install | bash' },
          { kind: 'cmd', text: 'kortix login' },
          { kind: 'note', text: 'your browser opens; approve the sign-in there' },
          { kind: 'gap' },
          { kind: 'cmd', text: `kortix chat --new -p "${PROMPT}"` },
          { kind: 'out', text: RESULT },
          { kind: 'gap' },
          { kind: 'cmd', text: 'kortix cr ls' },
          { kind: 'row', text: '#    STATUS    FROM → INTO         TITLE' },
          {
            kind: 'row',
            text: '#12  ● open    3f9a2c1e… → main    Stop retrying webhooks on a 4xx',
          },
          { kind: 'gap' },
          { kind: 'cmd', text: 'kortix cr merge 12' },
          { kind: 'ok', text: 'Merged CR #12 (fast-forward)  8c41d2e' },
        ]}
      />
    </div>
  );
}

const STAGES: Record<SurfaceId, () => ReactNode> = {
  desktop: () => <DesktopStage />,
  mobile: () => <MobileStage />,
  cli: () => <CliStage />,
  slack: function SlackStage() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { SLACK_THREAD } = localizeMarketingContent(tMarketing);
    return <SlackWindow messages={SLACK_THREAD} />;
  },
  teams: function TeamsStage() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { TEAMS_THREAD } = localizeMarketingContent(tMarketing);
    return <TeamsWindow messages={TEAMS_THREAD} />;
  },
};

export function SurfaceStage({ id }: { id: SurfaceId }) {
  const Stage = STAGES[id];
  return <Stage />;
}
