'use client';

/**
 * The Slack connect hero — what `channels-view.tsx` shows when Slack is not
 * connected yet, in place of a table row whose every cell was empty.
 *
 * **The problem it solves.** The old view never told you what connecting
 * bought you. "Invite the bot to any channel and @mention it" rendered inside
 * an `InfoBanner` that only mounted once `install` was truthy — i.e. the
 * explanation arrived strictly after you had already committed. A first-time
 * admin was asked to authorise an OAuth app on the strength of the word
 * "Install" in a table cell.
 *
 * So the payoff moves in front of the decision: the `Slack × Kortix` cover
 * (`slack-connect-cover.tsx`, which delegates to the blog's own `BlogCover`),
 * three lines in plain language about what happens once it is on, and exactly
 * one primary button.
 *
 * **Two paths, one shape.** The managed Kortix Slack app (server has
 * `SLACK_CLIENT_ID`/`SECRET`/`SIGNING_SECRET`, surfaced as
 * `mode.oauth_available`) is a single click. Self-hosted installs without
 * those env vars have to create their own app. That used to be an
 * `EmptyState` — the component for "there is nothing here" — which framed a
 * fully supported path as a dead end. It now gets this same hero with the
 * wizard behind the primary button, so the self-hosted route reads as a
 * deliberate choice rather than a missing feature.
 */

import { Button } from '@/components/ui/button';
import { Slack } from '@/features/icon/icons/slack';
import { ChannelHintBadge } from '@/features/workspace/customize/sections/component/channel-row';
import { SlackByoWizard } from '@/features/workspace/customize/sections/component/slack-byo-wizard';
import { SlackConnectCover } from '@/features/workspace/customize/sections/component/slack-connect-cover';
import { CheckIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * What a non-technical admin gets, in their words. No "sandbox", no "session",
 * no "bot token" — those are our nouns, not theirs. The third line is the one
 * that closes it: nobody else on the team has to do anything.
 */
const SLACK_BENEFITS = [
  'Works in any channel you invite it to, public or private',
  'Replies in the thread as it works, so the team can follow along',
  'Nothing for your teammates to install',
];

export function SlackConnectCard({
  projectId,
  oauthInstallUrl,
  canWrite,
}: {
  projectId: string;
  oauthInstallUrl: string | null;
  canWrite: boolean;
}) {
  const [wizardOpen, setWizardOpen] = useState(false);
  // Narrow once so the JSX below never needs a non-null assertion on the URL.
  const oneClickUrl = oauthInstallUrl ?? null;
  const oneClick = oneClickUrl !== null;

  return (
    <>
      <div className="bg-popover overflow-hidden rounded-md border">
        {/* Flush to the panel edge, no tinted band and no inset. The cover used
            to be a hand-drawn thread mock that needed a band to separate it
            from the panel; `BlogCover` brings its own gradient and grain, so a
            band behind it would just be a second background fighting the first.
            The panel's own `overflow-hidden rounded-md` clips the top corners —
            the same full-bleed treatment `post-card.tsx` gives it. */}
        <div className="border-b overflow-hidden">
          <SlackConnectCover />
        </div>

        <div className="space-y-4 px-4 py-5">
          <div className="flex items-start gap-3">
            <span className="bg-muted/60 flex size-12 shrink-0 items-center justify-center rounded-md border">
              <Slack className="size-7 shrink-0" />
            </span>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-1.5">
                <h3 className="text-foreground text-sm font-medium">Slack</h3>
                {oneClick ? null : <ChannelHintBadge>Your own app</ChannelHintBadge>}
              </div>
              {/* text-pretty so a two-line lede never leaves one orphan word */}
              <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
                {oneClick
                  ? 'Mention your agent in Slack and it does the work there — no dashboard, no context switch.'
                  : 'This workspace connects through a Slack app you own. We walk you through creating it — about three minutes.'}
              </p>
            </div>
          </div>

          <ul className="space-y-1.5">
            {SLACK_BENEFITS.map((benefit) => (
              <li key={benefit} className="flex items-center gap-2">
                <CheckIcon className="text-muted-foreground size-3.5 shrink-0" />
                <span className="text-muted-foreground text-xs leading-relaxed">{benefit}</span>
              </li>
            ))}
          </ul>

          {canWrite ? (
            <div className="flex flex-wrap items-center gap-2">
              {oneClickUrl ? (
                <>
                  <Button
                    className="gap-1.5 transition-transform active:scale-[0.97]"
                    asChild
                  >
                    <Link href={oneClickUrl} target="_blank" rel="noopener noreferrer">
                      <Slack className="size-3.5 shrink-0" />
                      Add to Slack
                    </Link>
                  </Button>
                  <Button variant="ghost" onClick={() => setWizardOpen(true)}>
                    Use your own Slack app
                  </Button>
                </>
              ) : (
                <Button
                  className="gap-1.5 transition-transform active:scale-[0.97]"
                  onClick={() => setWizardOpen(true)}
                >
                  <Slack className="size-3.5 shrink-0" />
                  Set up Slack
                </Button>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">Ask a workspace admin to connect Slack.</p>
          )}
        </div>
      </div>

      <SlackByoWizard projectId={projectId} open={wizardOpen} onOpenChange={setWizardOpen} />
    </>
  );
}
