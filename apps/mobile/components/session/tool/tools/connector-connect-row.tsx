/**
 * ConnectorConnectRow — the in-chat "this needs connecting" row (COR-158,
 * connector remainder). Mounted by `ConnectorCallTool`
 * (`connector-tools.tsx`) whenever a `kortix-connectors_call` denial names an
 * unconnected app (`connectorConnectNeed`, `lib/session/connector-handoff.ts`).
 * A `/connect/<token>` link in the agent's prose draws the same shape
 * (`ConnectRowShell`) with its own status: `turn/setup-link-card.tsx`.
 *
 * `ResultRow`-styled, not `ResultRow` itself: `result-row.tsx` has no slot for
 * a trailing action button (only a chevron `onPress`), and this row's whole
 * point is the Connect button, not navigation. It borrows `RESULT_ROW_TILE`
 * so the tile reads as the same shape as every other transcript row, and
 * never changes it or its icon size.
 *
 * Live status, not a one-time echo of the denial: `useConnectors` reads the
 * project's connector list (`projectKeys.connectors`, 15 s stale time), and
 * `ConnectorAuthSheet` invalidates that query after every connect attempt, so
 * a connector the human connected elsewhere reads "Connected" here once the
 * query refetches, without re-running the tool call.
 */
import * as React from 'react';
import { View } from 'react-native';
import { useColorScheme } from 'nativewind';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useConnectors } from '@/lib/projects/hooks';
import { isConnectorConnected } from '@/lib/session/connector-handoff';
import { THEME } from '@/lib/utils/theme';
import { ConnectorAppMark } from '../../connector-handshake';
import { ConnectorHandoffContext } from '../shared/connector-handoff-context';
import { RESULT_ROW_TILE } from '../shared/result-row';
import { TURN_TYPE, useTurnPalette } from '../shared/styles';

/** The row's shape: a 40pt tile, a title over a status line, one action. */
export function ConnectRowShell({
  media,
  title,
  status,
  statusTone = 'muted',
  titleLines = 1,
  action,
}: {
  media: React.ReactNode;
  title: string;
  /** A connect link's title names the app and the project: it may wrap once. */
  titleLines?: number;
  status: string;
  statusTone?: 'muted' | 'success';
  action?: React.ReactNode;
}) {
  const palette = useTurnPalette();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 10,
        borderRadius: 12,
        backgroundColor: theme.card,
      }}>
      {media}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={titleLines} style={[TURN_TYPE.sm, { color: palette.foreground }]}>
          {title}
        </Text>
        <Text
          numberOfLines={1}
          style={[TURN_TYPE.xs, { color: statusTone === 'success' ? palette.success : palette.mutedForeground }]}>
          {status}
        </Text>
      </View>
      {action}
    </View>
  );
}

export interface ConnectorConnectRowProps {
  slug: string;
  label: string;
  /** The agent's own `connect_url` — the `ConnectorAuthSheet` fallback. */
  fallbackConnectUrl: string;
}

export function ConnectorConnectRow({ slug, label, fallbackConnectUrl }: ConnectorConnectRowProps) {
  const handoff = React.useContext(ConnectorHandoffContext);
  const { data: connectors, isLoading } = useConnectors(handoff?.projectId ?? null);

  // No handoff context mounted (defensive — `SessionPage` always provides
  // one): nothing this row could do, so it renders nothing rather than a dead
  // button.
  if (!handoff?.projectId) return null;

  const connector = connectors?.connectors.find((row) => row.slug === slug);
  const connected = isConnectorConnected(connector);
  const logoUri = connector?.iconUrl ?? null;

  const connect = () => {
    handoff.requestConnect({
      projectId: handoff.projectId!,
      slug,
      label,
      logoUri,
      fallbackConnectUrl,
    });
  };

  return (
    <ConnectRowShell
      media={
        <ConnectorAppMark
          name={label}
          iconUrl={isLoading ? undefined : logoUri}
          size={RESULT_ROW_TILE}
          radius={8}
          connected={connected}
        />
      }
      title={label}
      status={connected ? 'Connected' : 'Needs connecting'}
      statusTone={connected ? 'success' : 'muted'}
      action={
        connected ? null : (
          <Button size="sm" onPress={connect}>
            <Text>Connect</Text>
          </Button>
        )
      }
    />
  );
}
