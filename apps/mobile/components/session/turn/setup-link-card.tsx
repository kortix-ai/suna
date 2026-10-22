/**
 * SetupLinkCard — the row a setup link in assistant prose becomes
 * (`splitSetupLinks`, `lib/markdown/setup-links.ts`). Web's `SetupLinkButton`,
 * with web's words: "Connect {app} to {project}" · "Waiting for you" · Connect.
 *
 * A connect link names its app, logo, and project through the public
 * `GET /setup-links/connectors/:token`; until that answers, the agent's own
 * label stands over a skeleton tile. Connect opens the transcript's one
 * `ConnectorAuthSheet`.
 *
 * Status is the link's own, as on web: "Waiting for you" until an account
 * lands after the link was minted. The link's GET reports that
 * (`ConnectorSetupLinkInfo.connected`), so the card stays "Connected" after an
 * app restart. It is never read from the project's connector list: a link asks
 * for an account even when the app already has one, so that list would call a
 * link nobody has acted on "Connected".
 *
 * A secret link opens its `/secret-intake/<token>` page in the in-app browser.
 * The app has no secret form of its own.
 */
import * as React from 'react';
import { View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getConnectorSetupLink } from '@kortix/sdk';

import { API_URL } from '@/api/config';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { KeyIcon } from '@/lib/icons';
import type { SetupLinkKind } from '@/lib/markdown/setup-links';
import { openLink } from '@/lib/utils/open-link';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { ConnectorAppMark } from '../connector-handshake';
import { ConnectorHandoffContext } from '../tool/shared/connector-handoff-context';
import { RESULT_ROW_TILE } from '../tool/shared/result-row';
import { ConnectRowShell } from '../tool/tools/connector-connect-row';

export interface SetupLinkCardProps {
  kind: SetupLinkKind;
  /** Null while the link's URL is still streaming. */
  token: string | null;
  href: string | null;
  /** What the agent's text names. May be empty. */
  label: string;
}

export function SetupLinkCard({ kind, token, href, label }: SetupLinkCardProps) {
  const handoff = React.useContext(ConnectorHandoffContext);
  const queryClient = useQueryClient();
  // Links connected from a card in this app run, kept in the query cache: the
  // transcript recycles its rows while the browser is open, and the card that
  // comes back must read "Connected", not the one that asked.
  const settledKey = ['setup-link', 'settled', token];
  const settledHere =
    useQuery({ queryKey: settledKey, queryFn: () => false, enabled: false, gcTime: Infinity }).data === true;
  // One request per link: every card that shows the token shares the query.
  const info = useQuery({
    queryKey: ['setup-link', 'connector', token],
    queryFn: () => getConnectorSetupLink(token!, { backendUrl: API_URL }),
    enabled: kind === 'connector' && token !== null,
    // The name and logo never change, but `connected` does: a card mounted a
    // minute later asks again. The public route allows 30 requests per token
    // per minute.
    staleTime: 60_000,
    retry: 1,
  });
  // The link's own answer survives an app restart; `settledHere` covers the
  // moment after a connect, and a server that does not report it.
  const settled = settledHere || info.data?.connected === true;

  const pending = token === null || href === null;

  if (kind === 'secret') {
    return (
      <ConnectRowShell
        media={
          <View
            className="items-center justify-center"
            style={{
              width: RESULT_ROW_TILE,
              height: RESULT_ROW_TILE,
              borderRadius: 8,
              backgroundColor: withAlpha(THEME.accent.orange, 0.15),
            }}>
            <Icon as={KeyIcon} size={20} weight="fill" color={THEME.accent.orange} />
          </View>
        }
        title={label || 'Enter credentials'}
        status={pending ? 'Preparing link…' : 'Waiting for you'}
        action={
          <Button size="sm" disabled={pending} onPress={() => href && openLink(href).catch(() => {})}>
            <Text>Add secret</Text>
          </Button>
        }
      />
    );
  }

  const link = info.data;
  const app = link?.name?.trim() || link?.app?.trim() || link?.slug || label;
  // The API answers "this project" for a project it cannot name.
  const named = link?.project_name?.trim();
  const project = named && named !== 'this project' ? named : null;
  const title = !app ? 'Connect app' : project ? `Connect ${app} to ${project}` : `Connect ${app}`;

  const connect = () => {
    if (pending) return;
    const projectId = link?.project_id ?? handoff?.projectId;
    if (!handoff || !projectId) {
      openLink(href).catch(() => {});
      return;
    }
    handoff.requestConnect({
      projectId,
      // An unknown slug fails the project-scoped connect, and the sheet opens
      // the link's own page instead.
      slug: link?.slug ?? '',
      label: app || 'app',
      projectName: project,
      logoUri: link?.icon_url ?? null,
      fallbackConnectUrl: href,
      onSettled: (connected) => {
        if (connected) queryClient.setQueryData(settledKey, true);
      },
    });
  };

  return (
    <ConnectRowShell
      media={
        <ConnectorAppMark
          name={app}
          iconUrl={pending || info.isLoading ? undefined : (link?.icon_url ?? null)}
          size={RESULT_ROW_TILE}
          radius={8}
          connected={settled}
        />
      }
      title={title}
      titleLines={2}
      status={pending ? 'Preparing link…' : settled ? 'Connected' : 'Waiting for you'}
      statusTone={settled ? 'success' : 'muted'}
      action={
        settled ? null : (
          <Button size="sm" disabled={pending} onPress={connect}>
            <Text>Connect</Text>
          </Button>
        )
      }
    />
  );
}
