'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * The Microsoft Teams connect hero — the Teams twin of `slack-connect-card.tsx`,
 * shown by `channels-view.tsx` while Teams is not connected.
 *
 * It replaced `teams-channel-panel.tsx`, a disclosure that stacked a heading,
 * a banner, a ghost button and a tenant-id form into one card. Now it is
 * `ChannelConnectHero` with a mock of a Teams channel. The managed install is
 * the one-click org-consent URL; the bring-your-own path is `TeamsByoWizard`.
 */

import { Kortix } from '@/features/icon/icons/kortix';
import { MicrosoftTeams } from '@/features/icon/icons/microsoft-teams';
import { ChannelConnectHero } from '@/features/workspace/customize/sections/component/channel-connect-hero';
import { TeamsByoWizard } from '@/features/workspace/customize/sections/component/teams-byo-wizard';
import type { TeamsMode } from '@/hooks/channels/use-teams-installations';
import type { CSSProperties } from 'react';
import { useState } from 'react';

/**
 * Teams' own colours, so the mock reads as Teams at a glance: the brand
 * purple (Teams' light and dark shades, picked by `light-dark()`) for the
 * active rail item, the Posts tab and the mention, and the pastel initials
 * avatar.
 */
const TEAMS_BRAND = 'light-dark(#5b5fc7, #7f85f5)';
const TEAMS_AVATAR = '#e5c7f0';
const TEAMS_AVATAR_TEXT = '#6b2a85';
const TEAMS_UI = {
  '--teams-brand': TEAMS_BRAND,
  '--teams-avatar': TEAMS_AVATAR,
  '--teams-avatar-text': TEAMS_AVATAR_TEXT,
} as CSSProperties;

export function TeamsConnectCard({
  projectId,
  mode,
  canWrite,
}: {
  projectId: string;
  mode: TeamsMode;
  canWrite: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [wizardOpen, setWizardOpen] = useState(false);
  const oneClickUrl = mode.available && !mode.byo ? mode.orgConsentUrl : null;

  return (
    <>
      <ChannelConnectHero
        logo={<MicrosoftTeams className="size-5 shrink-0" />}
        title={tI18nComplete.raw('textc1bd5ca19f5f')}
        lede={
          oneClickUrl
            ? tI18nComplete.raw('texta15b754f2e91')
            : tI18nComplete.raw('text7fd0fd8f2405')
        }
        preview={<TeamsChannelMock />}
        canWrite={canWrite}
        oneClickUrl={oneClickUrl}
        oneClickLabel={tI18nComplete.raw('text1fece1858ee9')}
        ownAppLabel={tI18nComplete.raw('texte2065cb79c86')}
        setupLabel={tI18nComplete.raw('texte2065cb79c86')}
        readOnlyNote={tI18nComplete.raw('text776fd1de4147')}
        onOwnApp={() => setWizardOpen(true)}
      />
      <TeamsByoWizard
        projectId={projectId}
        mode={mode}
        open={wizardOpen}
        onOpenChange={setWizardOpen}
      />
    </>
  );
}

/**
 * A Teams channel at a glance: the app rail and the channel list as
 * skeletons, then Launch's Posts tab with Teams' post anatomy — a card with a
 * round initials avatar, a bold name and timestamp, the purple mention, and
 * the agent's answer in the card's reply section. The composer is a skeleton.
 */
function TeamsChannelMock() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex flex-1" style={TEAMS_UI}>
      <div className="bg-muted/60 flex w-12 shrink-0 flex-col items-center gap-3 py-4">
        <span className="size-5 rounded-md bg-(--teams-brand)" />
        <span className="bg-muted-foreground/25 size-5 rounded-md" />
        <span className="bg-muted-foreground/25 size-5 rounded-md" />
        <span className="bg-muted-foreground/25 size-5 rounded-md" />
      </div>
      <div className="bg-muted/30 flex w-28 shrink-0 flex-col gap-3 border-e px-3 py-4">
        <span className="bg-muted-foreground/40 mb-1 h-2.5 w-14 rounded-full" />
        <span className="bg-muted-foreground/20 h-2 w-16 rounded-full" />
        <span className="bg-background -mx-1.5 flex h-6 items-center rounded-md border px-1.5">
          <span className="bg-muted-foreground/50 h-2 w-12 rounded-full" />
        </span>
        <span className="bg-muted-foreground/20 h-2 w-14 rounded-full" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-end gap-4 border-b px-4 pt-3">
          <p className="text-foreground pb-2.5 text-sm font-semibold">{tI18nComplete.raw('texta4b2d28ad49b')}</p>
          <p className="text-foreground border-b-2 border-(--teams-brand) pb-2 text-xs font-semibold">
            {tI18nComplete.raw('text2c2e44899866')}
          </p>
        </div>

        <div className="bg-muted/30 flex flex-1 flex-col justify-between gap-4 p-4">
          <div className="bg-background overflow-hidden rounded-md border shadow-xs">
            <div className="flex gap-2.5 p-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-(--teams-avatar) text-xs font-semibold text-(--teams-avatar-text)">
                M
              </span>
              <div className="min-w-0 text-sm">
                <p className="flex items-baseline gap-2">
                  <span className="text-foreground font-semibold">{tI18nComplete.raw('textc6c8dad55129')}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">{tI18nComplete.raw('text9a059d44c8e5')}</span>
                </p>
                <p className="text-foreground">
                  <span className="font-semibold text-(--teams-brand)">
                    Kortix
                  </span>{' '}
                  {tI18nComplete.raw('text5df6373cf99f')}
                </p>
              </div>
            </div>
            <div className="bg-muted/30 flex gap-2.5 border-t py-2.5 ps-6 pe-3">
              <span className="bg-background flex size-6 shrink-0 items-center justify-center rounded-full border">
                <Kortix className="size-3" />
              </span>
              <div className="min-w-0 text-sm">
                <p className="flex items-baseline gap-2">
                  <span className="text-foreground font-semibold">Kortix</span>
                  <span className="text-muted-foreground text-xs tabular-nums">{tI18nComplete.raw('text92dca4f34a6f')}</span>
                </p>
                <p className="text-foreground text-pretty">
                  {tI18nComplete.raw('textf4d1a9671f2f')}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-background flex h-9 items-center rounded-md border px-3">
            <span className="bg-muted h-2 w-24 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
