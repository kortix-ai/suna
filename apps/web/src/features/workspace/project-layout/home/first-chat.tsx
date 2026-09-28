'use client';

import {
  CheckCircleIcon,
  GrainsIcon,
  PlugsConnectedIcon,
  UserPlusIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useEffect, useId, useState, type ReactNode } from 'react';

import Loading from '@/components/ui/loading';
import { HubLink } from '@/features/accounts/hub/account-hub-location';
import { Slack } from '@/features/icon/icons/slack';
import { useSlackInstall, useSlackMode } from '@/hooks/channels/use-channels-installations';
import type { HubTarget } from '@/stores/account-panel-store';

import { useAuth } from '@/features/providers/auth-provider';
import { SESSION_TRANSCRIPT_CLASS } from '@/features/session/session-transcript-class';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';

import { firstNameOf } from './first-chat-name';

/**
 * "Your first chat with Kortix": what project home shows a new person instead
 * of its usual greeting, until they send their first message.
 *
 * It is laid out as a chat, not as the home hero. The welcome sits where the
 * first assistant message would, in the transcript column a session uses, and
 * the composer is docked at the bottom. Sending opens a real session with the
 * composer already where it stays, so nothing jumps.
 *
 * The welcome is static text, and it stays: it is never replaced by a
 * session. Every send from here — typed, "Recommend tools", or "Update
 * memory" — starts a new session and opens it; coming back to project home
 * shows this welcome again.
 *
 * The welcome reads as one short message: a greeting, one line of intro, then
 * the question as the label of the starter tiles it asks about. Two tiles act
 * in the product rather than filling the composer:
 * - "Invite teammate" opens the account hub's Access tab, only for someone who
 *   may manage members.
 * - "Connect Slack" runs the one-click Slack install in a popup and turns into
 *   a checked tile once the install lands.
 *
 * The welcome fades in once, over 300ms. It is opacity only, so reduced motion
 * needs no other variant.
 */
export function FirstChat({
  projectId,
  inviteTo,
  composer,
  busy,
  onRecommendTools,
  onUpdateMemory,
}: {
  projectId: string;
  /** Where "Invite teammate" opens; `null` hides the tile (no permission, or
   *  the project's account is still loading). */
  inviteTo: HubTarget | null;
  /** The docked composer. Project home owns its wiring. */
  composer: ReactNode;
  /** A send is in flight: the starters wait with the composer. */
  busy: boolean;
  onRecommendTools: () => void;
  onUpdateMemory: () => void;
}) {
  const t = useTranslations('firstChat');
  const { user } = useAuth();
  const name = firstNameOf(user?.user_metadata);
  const headingId = useId();
  const questionId = useId();

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section
          aria-labelledby={headingId}
          className={cn(
            SESSION_TRANSCRIPT_CLASS,
            // Below the floating sidebar toggle, and a little lower on wide
            // screens where the column has room to breathe.
            'flex flex-col gap-10 pt-16 pb-8 lg:pt-24',
            'transition-opacity duration-(--duration-slow) ease-out starting:opacity-0',
          )}
        >
          <div className="flex flex-col gap-3">
            <h1
              id={headingId}
              className="text-foreground text-2xl font-medium tracking-tight text-balance"
            >
              {name ? t('greeting', { name }) : t('greetingNoName')}
            </h1>
            <p className="text-muted-foreground max-w-prose text-base leading-7 text-pretty">
              {t('intro')}
            </p>
          </div>

          <div role="group" aria-labelledby={questionId} className="flex flex-col gap-4">
            <p id={questionId} className="text-foreground text-base font-medium">
              {t('question')}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <StarterTile
                icon={PlugsConnectedIcon}
                label={t('recommendTools')}
                disabled={busy}
                onClick={onRecommendTools}
              />
              <StarterTile
                icon={GrainsIcon}
                label={t('updateMemory')}
                disabled={busy}
                onClick={onUpdateMemory}
              />
              {inviteTo && (
                <HubLink to={inviteTo} className={tileClass}>
                  <TileBody
                    glyph={<UserPlusIcon className="size-4" />}
                    label={t('inviteTeammate')}
                  />
                </HubLink>
              )}
              <SlackTile projectId={projectId} />
            </div>
          </div>
        </section>
      </div>

      {composer}
    </div>
  );
}

const tileClass = cn(
  'border-border bg-popover text-foreground relative flex h-30 w-auto flex-col justify-between rounded-md border p-4 text-left',
  'transition-[background-color,border-color,scale] duration-(--duration-normal)',
  'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none',
  'hover:border-primary/20  cursor-pointer active:scale-[0.97] motion-reduce:active:scale-100',
  'disabled:pointer-events-none disabled:opacity-50',
  'aria-disabled:pointer-events-none',
);

/** The icon in its own chip at the top, the title at the bottom on one line. */
function TileBody({ glyph, label, badge }: { glyph: ReactNode; label: string; badge?: ReactNode }) {
  return (
    <>
      <span className="bg-muted text-foreground flex size-8 items-center justify-center rounded-sm">
        {glyph}
      </span>
      <span className="truncate text-sm leading-5 font-medium whitespace-nowrap">{label}</span>
      {badge && (
        <span aria-hidden className="absolute top-4 right-4">
          {badge}
        </span>
      )}
    </>
  );
}

/**
 * A square starter that fills the composer. The same tile shape as
 * onboarding's app grid, so the first screen after onboarding reads as its
 * continuation.
 */
function StarterTile({
  icon: Glyph,
  label,
  disabled,
  onClick,
}: {
  icon: Icon;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={tileClass}>
      <TileBody glyph={<Glyph className="size-4.5" aria-hidden />} label={label} />
    </button>
  );
}

/** How long a popup install may take before the tile stops waiting on it. */
const SLACK_WAIT_MS = 5 * 60_000;
const SLACK_POLL_MS = 2_500;

/**
 * One click installs Kortix into Slack: the popup opens inside the click, and
 * the tile polls the installation until it lands, then shows a check. With no
 * managed Slack app on this deployment (`oauth_available` false) the tile is
 * hidden; the custom-app setup lives on the Channels page.
 */
function SlackTile({ projectId }: { projectId: string }) {
  const t = useTranslations('firstChat');
  const mode = useSlackMode(projectId);
  const install = useSlackInstall(projectId);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const connected = Boolean(install.data);
  const waiting = waitingSince !== null && !connected;

  const refetch = install.refetch;
  useEffect(() => {
    if (!waiting) return;
    const poll = setInterval(() => void refetch(), SLACK_POLL_MS);
    const stop = setTimeout(() => setWaitingSince(null), SLACK_WAIT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [waiting, refetch]);

  const installUrl = mode.data?.oauth_available ? mode.data.install_url : null;
  if (!installUrl && !connected) return null;

  return (
    <button
      type="button"
      aria-disabled={connected || undefined}
      aria-busy={waiting || undefined}
      aria-label={connected ? t('slackConnected') : t('connectSlack')}
      onClick={() => {
        if (connected || !installUrl) return;
        window.open(installUrl, 'kortix-slack-install', 'width=640,height=780,noopener');
        setWaitingSince(Date.now());
      }}
      className={cn(tileClass, connected && 'border-primary/40 bg-primary/[0.05] cursor-default')}
    >
      <TileBody
        glyph={<Slack className="size-4" />}
        label={connected ? t('slackConnected') : t('connectSlack')}
        badge={
          waiting ? (
            // Inside a <button> the spinner defaults to `text-background`.
            <Loading variant="spokes" className="text-foreground! size-4" />
          ) : connected ? (
            <CheckCircleIcon weight="fill" className="text-foreground size-4" />
          ) : null
        }
      />
    </button>
  );
}
