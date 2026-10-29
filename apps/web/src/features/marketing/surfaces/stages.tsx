import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { PlusIcon } from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';
import { localizeMarketingContent } from './parts';

import { SlackWindow, TeamsWindow } from './chat';
import type { SurfaceId } from './content';
import { DesktopFrame, PhoneFrame, TerminalFrame } from './frames';
import { PermissionCard, QuickEntryBar, StepsFold, UserBubble } from './parts';

/*
 * One hero visual per surface page: Kortix as it looks on that surface,
 * drawn at real text size so it stays readable at 390 px. Every one shows the
 * same Arcadia session (parts.tsx).
 */

const SESSIONS = [
  { title: 'Billing webhook retry', unread: false, active: true },
  { title: 'Weekly pipeline summary', unread: true },
  { title: 'Churned accounts, October', unread: true },
  { title: 'Onboarding checklist', unread: false },
] as const;

/** The Kortix app in a native window, with Quick Entry open over it. */
function DesktopStage() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { PROMPT, RESULT } = localizeMarketingContent(tMarketing);

  return (
    <div className="relative flex w-full max-w-6xl flex-col items-center">
      <DesktopFrame title="Kortix · Arcadia">
        <div className="grid grid-cols-1 md:grid-cols-[15rem_1fr]">
          <aside className="bg-card hidden flex-col gap-4 border-r p-3 md:flex">
            <span className="text-foreground flex items-center gap-2 px-2 pt-1 text-sm font-medium">
              <KortixLogo size={14} variant="symbol" />
              Arcadia
            </span>
            <span className="text-foreground flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
              <PlusIcon aria-hidden className="size-3.5" />
              New session
            </span>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground px-2 text-xs">Sessions</span>
              <ul className="flex flex-col">
                {SESSIONS.map((s) => (
                  <li
                    key={s.title}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm',
                      'active' in s ? 'bg-muted text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span className="truncate">{s.title}</span>
                    {s.unread ? (
                      <span
                        aria-label="Unread"
                        className="bg-foreground size-1.5 shrink-0 rounded-full"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </aside>
          <div className="flex min-w-0 flex-col gap-5 px-5 pt-5 pb-28 sm:px-10 sm:pt-8 md:pb-36">
            <span className="text-foreground text-sm font-medium">Billing webhook retry</span>
            <UserBubble>{PROMPT}</UserBubble>
            <StepsFold count={5} />
            <p className="text-foreground max-w-xl text-sm text-pretty">{RESULT}</p>
            <span className="bg-card text-foreground flex w-fit max-w-full items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <span className="text-muted-foreground font-mono text-xs">#12</span>
              <span className="truncate">Stop retrying webhooks on a 4xx</span>
              <span className="text-muted-foreground shrink-0 text-xs">2 files</span>
            </span>
          </div>
        </div>
      </DesktopFrame>
      {/* Quick Entry floats over the lower half of the window, as it floats over any app. */}
      <div className="relative -mt-20 w-full px-3 sm:-mt-24 sm:px-10">
        <div className="mx-auto max-w-2xl">
          <QuickEntryBar text="Draft the weekly pipeline summary from this week’s deals" />
        </div>
      </div>
    </div>
  );
}

/** The phone, with a session that waits on a permission. */
function MobileStage() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { PROMPT } = localizeMarketingContent(tMarketing);

  return (
    <PhoneFrame title="Billing webhook retry">
      <UserBubble>{PROMPT}</UserBubble>
      <StepsFold count={3} />
      <p className="text-foreground text-sm text-pretty">
        The fix is in. I want to run the billing tests to prove it.
      </p>
      <PermissionCard tool="bash" input="bun test src/billing" />
    </PhoneFrame>
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
