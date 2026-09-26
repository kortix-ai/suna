/**
 * ConnectorConnectRow — the in-chat "this needs connecting" row (COR-158,
 * connector remainder). Mounted by `ConnectorCallTool`
 * (`connector-tools.tsx`) whenever a `kortix-connectors_call` denial names an
 * unconnected app (`connectorConnectNeed`, `lib/session/connector-handoff.ts`).
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
import { Image, View } from 'react-native';
import { useColorScheme } from 'nativewind';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { PlugIcon } from '@/lib/icons';
import { useConnectors } from '@/lib/projects/hooks';
import { isConnectorConnected } from '@/lib/session/connector-handoff';
import { THEME } from '@/lib/utils/theme';
import { ConnectorHandoffContext } from '../shared/connector-handoff-context';
import { RESULT_ROW_TILE } from '../shared/result-row';
import { TURN_TYPE, useTurnPalette } from '../shared/styles';

export interface ConnectorConnectRowProps {
  slug: string;
  label: string;
  /** The agent's own `connect_url` — the `ConnectorAuthSheet` fallback. */
  fallbackConnectUrl: string;
}

export function ConnectorConnectRow({ slug, label, fallbackConnectUrl }: ConnectorConnectRowProps) {
  const palette = useTurnPalette();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const handoff = React.useContext(ConnectorHandoffContext);
  const { data: connectors } = useConnectors(handoff?.projectId ?? null);
  const [imgFailed, setImgFailed] = React.useState(false);

  // No handoff context mounted (defensive — `SessionPage` always provides
  // one): nothing this row could do, so it renders nothing rather than a dead
  // button.
  if (!handoff?.projectId) return null;

  const connector = connectors?.connectors.find((row) => row.slug === slug);
  const connected = isConnectorConnected(connector);
  const logoUri = connector?.iconUrl ?? null;
  const showLogo = !!logoUri && !imgFailed;

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
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 10,
        borderRadius: 12,
        backgroundColor: theme.card,
      }}>
      <View
        style={{
          width: RESULT_ROW_TILE,
          height: RESULT_ROW_TILE,
          borderRadius: 8,
          overflow: 'hidden',
          backgroundColor: theme.secondary,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        {showLogo ? (
          <Image
            source={{ uri: logoUri! }}
            resizeMode="contain"
            onError={() => setImgFailed(true)}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <Icon as={PlugIcon} size={20} color={palette.mutedForeground} />
        )}
      </View>

      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={[TURN_TYPE.sm, { color: palette.foreground }]}>
          {label}
        </Text>
        <Text
          numberOfLines={1}
          style={[TURN_TYPE.xs, { color: connected ? palette.success : palette.mutedForeground }]}>
          {connected ? 'Connected' : 'Needs connecting'}
        </Text>
      </View>

      {connected ? null : (
        <Button size="sm" onPress={connect}>
          <Text>Connect</Text>
        </Button>
      )}
    </View>
  );
}
