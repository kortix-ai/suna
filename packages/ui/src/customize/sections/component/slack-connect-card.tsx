'use client';

import { useTranslations } from '../../../i18n';
/**
 * The Slack connect hero — what `channels-view.tsx` shows when Slack is not
 * connected yet, in place of a table row whose every cell was empty.
 *
 * The old view never told you what connecting bought you: the explanation
 * arrived only after you had installed. So the payoff moves in front of the
 * decision: `ChannelConnectHero` with a mock of a Slack channel where a
 * teammate @mentions the agent and it answers.
 */

import { Kortix } from '../../../internal/icons/kortix';
import { Slack } from '../../../internal/icons/slack';
import { ChannelConnectHero } from './channel-connect-hero';
import { SlackByoWizard } from './slack-byo-wizard';
import type { CSSProperties } from 'react';
import { useState } from 'react';

/**
 * Slack's own colours, so the mock reads as Slack at a glance: the aubergine
 * sidebar, the active-channel blue, the mention pill (Slack's light and dark
 * blues, picked by `light-dark()`), a default avatar, and the white of the
 * sidebar text, which stays white in both themes.
 */
const SLACK_SIDEBAR = '#3f0e40';
const SLACK_ACTIVE = '#1164a3';
const SLACK_MENTION = 'light-dark(#1264a3, #1d9bd1)';
const SLACK_MENTION_FILL = '#1d9bd11a';
const SLACK_AVATAR = '#e8912d';
const SLACK_ON_SIDEBAR = '#ffffff';
const SLACK_UI = {
  '--slack-sidebar': SLACK_SIDEBAR,
  '--slack-active': SLACK_ACTIVE,
  '--slack-mention': SLACK_MENTION,
  '--slack-mention-fill': SLACK_MENTION_FILL,
  '--slack-avatar': SLACK_AVATAR,
  '--slack-on-sidebar': SLACK_ON_SIDEBAR,
} as CSSProperties;

export function SlackConnectCard({
  projectId,
  oauthInstallUrl,
  canWrite,
}: {
  projectId: string;
  oauthInstallUrl: string | null;
  canWrite: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <>
      <ChannelConnectHero
        logo={<Slack className="size-5 shrink-0" />}
        title={tI18nComplete.raw('text89e9e20668f3')}
        lede={
          oauthInstallUrl
            ? tI18nComplete.raw('textadb4acada861')
            : tI18nComplete.raw('text4a79cdb7ab5e')
        }
        preview={<SlackChannelMock />}
        canWrite={canWrite}
        oneClickUrl={oauthInstallUrl}
        oneClickLabel={tI18nComplete.raw('text3357cd3d0cee')}
        ownAppLabel={tI18nComplete.raw('text260f0001800b')}
        setupLabel={tI18nComplete.raw('text68382ef84e6c')}
        readOnlyNote={tI18nComplete.raw('text581144514350')}
        onOwnApp={() => setWizardOpen(true)}
      />
      <SlackByoWizard projectId={projectId} open={wizardOpen} onOpenChange={setWizardOpen} />
    </>
  );
}

/**
 * A Slack channel at a glance: the aubergine sidebar as a skeleton, then
 * `#launch` with Slack's message anatomy — a rounded-square avatar, a bold
 * name, a small timestamp, the blue mention pill, and the `APP` tag on the
 * agent's reply. The composer at the bottom is a skeleton too.
 */
function SlackChannelMock() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex flex-1" style={SLACK_UI}>
      <div className="flex w-28 shrink-0 flex-col gap-2.5 bg-(--slack-sidebar) px-3 py-4">
        <span className="mb-1.5 h-2.5 w-16 rounded-full bg-(--slack-on-sidebar)/50" />
        <span className="h-2 w-14 rounded-full bg-(--slack-on-sidebar)/20" />
        <span className="h-2 w-18 rounded-full bg-(--slack-on-sidebar)/20" />
        <span className="-mx-1.5 flex h-6 items-center rounded-md bg-(--slack-active) px-1.5">
          <span className="h-2 w-12 rounded-full bg-(--slack-on-sidebar)/80" />
        </span>
        <span className="h-2 w-16 rounded-full bg-(--slack-on-sidebar)/20" />
        <span className="h-2 w-10 rounded-full bg-(--slack-on-sidebar)/20" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <p className="text-foreground border-b px-5 py-3 text-sm font-semibold">{tI18nComplete.raw('textd3d6fcf27034')}</p>
        <div className="flex flex-1 flex-col gap-4 px-5 py-4">
          <div className="flex gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-(--slack-avatar) text-sm font-semibold text-(--slack-on-sidebar)">
              M
            </span>
            <div className="min-w-0 text-sm">
              <p className="flex items-baseline gap-2">
                <span className="text-foreground font-semibold">{tI18nComplete.raw('textc6c8dad55129')}</span>
                <span className="text-muted-foreground text-xs tabular-nums">{tI18nComplete.raw('text9a059d44c8e5')}</span>
              </p>
              <p className="text-foreground">
                <span className="rounded-xs bg-(--slack-mention-fill) px-0.5 text-(--slack-mention)">
                  {tI18nComplete.raw('text9bfa706b0569')}
                </span>{' '}
                {tI18nComplete.raw('text675d4a4174ba')}
              </p>
            </div>
          </div>
          <div className="flex gap-2.5">
            <span className="bg-background flex size-9 shrink-0 items-center justify-center rounded-lg border">
              <Kortix className="size-4" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="flex items-baseline gap-2">
                <span className="text-foreground font-semibold">Kortix</span>
                <span className="bg-muted text-muted-foreground rounded-xs px-1 text-xs font-semibold">
                  APP
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">{tI18nComplete.raw('text9a059d44c8e5')}</span>
              </p>
              <p className="text-foreground text-pretty">
                {tI18nComplete.raw('textbd52d3eb5ed1')}
              </p>
            </div>
          </div>
        </div>
        <div className="mx-5 mb-4 flex h-9 items-center rounded-lg border px-3">
          <span className="bg-muted h-2 w-28 rounded-full" />
        </div>
      </div>
    </div>
  );
}
