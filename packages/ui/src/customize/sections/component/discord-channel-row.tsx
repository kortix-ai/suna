'use client';

/**
 * Discord as a channel row: "Add to Discord" installs the Kortix Discord app in
 * one server for this project (Discord's own page picks the server), the
 * allowed users dialog is `ChannelAccessPanel`, and disconnect removes the
 * server. On a deployment without the Kortix Discord app the row says so and
 * offers no action.
 */
import { CHANNELS } from '@kortix/shared/channel-descriptors';
import { useState } from 'react';
import { useTranslations } from '../../../i18n';
import {
  useDisconnectDiscord,
  useDiscordInstall,
  useDiscordMode,
} from '../../../internal/hooks/channels/use-channels-installations';
import { Button } from '../../../primitives/button';
import { CountBadge } from '../../../primitives/count-badge';
import { Modal, ModalContent } from '../../../primitives/modal';
import { errorToast, successToast } from '../../../primitives/toast';
import { ChannelAccessPanel } from './channel-access-panel';
import { DiscordThreadMock } from './channel-mocks';
import { ChannelDisconnectButton, ChannelRow } from './channel-row';

const DISCORD = CHANNELS.discord;

export function DiscordChannelRow({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const tPages = useTranslations('connectorPages');
  const { data: mode } = useDiscordMode(projectId);
  const { data: install } = useDiscordInstall(projectId);
  const disconnect = useDisconnectDiscord();
  const [usersOpen, setUsersOpen] = useState(false);
  const installUrl = mode?.available ? mode.install_url : null;

  return (
    <>
      <ChannelRow
        app="discord"
        name={DISCORD.label}
        connected={Boolean(install)}
        detail={install?.guild_name ?? null}
        hero={{
          title: tPages('discordHeroTitle'),
          connectedTitle: tPages('channelConnectedTitle', { name: DISCORD.label }),
          ...(install ? {} : { lede: mode && !mode.available ? tPages('discordUnavailable') : tPages('discordHeroLede') }),
          preview: <DiscordThreadMock />,
        }}
        pitch={tPages('discordPitch')}
        actions={
          !canWrite ? null : install ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setUsersOpen(true)}>
                {t.raw('text2c3059c25723')}
                {install.access_request_count ? <CountBadge count={install.access_request_count} tone="waiting" /> : null}
              </Button>
              <ChannelDisconnectButton
                pending={disconnect.isPending}
                onConfirm={(done) =>
                  disconnect.mutate(projectId, {
                    onSuccess: () => {
                      done();
                      successToast(tPages('discordDisconnected'));
                    },
                    onError: (error) => errorToast(error.message),
                  })
                }
              />
            </>
          ) : installUrl ? (
            <Button asChild className="transition-transform active:scale-96">
              <a href={installUrl}>{tPages('discordAddToDiscord')}</a>
            </Button>
          ) : null
        }
      />
      <Modal open={usersOpen} onOpenChange={setUsersOpen}>
        <ModalContent>
          {usersOpen ? <ChannelAccessPanel projectId={projectId} platform="discord" onDone={() => setUsersOpen(false)} /> : null}
        </ModalContent>
      </Modal>
    </>
  );
}
