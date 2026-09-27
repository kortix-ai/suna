/**
 * ConnectorAuthSheet — the hand-off before opening the browser to connect an
 * app the agent asked for mid-chat (COR-158, connector remainder). Sibling of
 * `ConnectProviderSheet` (COR-125/COR-158 Task 9), not a generalization of it:
 * the two connect fundamentally different things (a model provider via a
 * static web URL vs. a project connector via a fresh Pipedream round trip
 * per attempt), so forcing one component to own both async shapes would have
 * meant branching its `run` callback on a "kind" flag instead of the two
 * sheets just being two thin wrappers around the same shared primitive. What
 * IS shared, and reused rather than duplicated: the visual shell (two 56pt
 * tiles joined by a dashed connector, title, one muted line, Continue ↗ / Not
 * now) and the close-then-open dismiss dance (`useHandoffDismiss`,
 * `handoff-sheet.ts`).
 *
 * Continue tries the project's own Pipedream connect flow first — the
 * `pipedreamConnect`/`pipedreamFinalize` round trip
 * (`lib/projects/projects-client.ts`), which mints a URL that
 * supports a `kortix://` redirect (`WebBrowser.openAuthSessionAsync` auto-
 * dismisses on it) — and falls back to the agent's own `connect_url` (a
 * `/connect/<token>` public web page with no redirect support, so it opens
 * plain, via `openBrowserAsync`) only when that project-scoped connect can't
 * start (the connector isn't declared as a Pipedream app for this project, or
 * the request itself fails).
 *
 * One instance lives in `SessionPage`, shared by every `ConnectorConnectRow`
 * in the transcript via `ConnectorHandoffContext` — exactly like
 * `ConnectProviderSheet` is shared by every "Connect provider" entry point.
 */
import * as React from 'react';
import { Image, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useColorScheme } from 'nativewind';
import { useQueryClient } from '@tanstack/react-query';

import { KortixLogo } from '@/components/kortix/KortixLogo';
import { Sheet, SheetBody, type SheetRef } from '@/components/kortix/sheet';
import { useToast } from '@/components/kortix/toast-provider';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ArrowUpRightIcon, PlugIcon } from '@/lib/icons';
import { projectKeys } from '@/lib/projects/hooks';
import { listConnectors, pipedreamConnect, pipedreamFinalize } from '@/lib/projects/projects-client';
import { openBrowserUntilClosed } from '@/lib/utils/open-browser';
import {
  connectorHandoffCopy,
  connectorHandoffToast,
  isConnectorConnected,
} from '@/lib/session/connector-handoff';
import { useHandoffDismiss } from './handoff-sheet';
import type { ConnectorHandoffRequest } from './tool/shared/connector-handoff-context';

const TILE_SIZE = 56;

// App deep links so the connect browser auto-dismisses back to the app
// (`openAuthSessionAsync` returns when it sees this scheme) instead of
// stranding the user on Pipedream's web success page. `kortix://connectors`
// is a browser-return root (`isBrowserReturnPath`, `lib/session/connect-model.ts`).
const CONNECT_RETURN_URL = 'kortix://connectors';
const CONNECT_SUCCESS_URI = 'kortix://connectors/success';
const CONNECT_ERROR_URI = 'kortix://connectors/error';

export interface ConnectorAuthSheetProps {
  /** The row currently asking to connect. Null between requests — the sheet
   *  stays mounted, so its body just has nothing to show until one arrives. */
  request: ConnectorHandoffRequest | null;
}

export const ConnectorAuthSheet = React.forwardRef<SheetRef, ConnectorAuthSheetProps>(
  ({ request }, ref) => {
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const toast = useToast();
    const queryClient = useQueryClient();
    const sheetRef = React.useRef<SheetRef>(null);
    const [logoFailed, setLogoFailed] = React.useState(false);

    // A fresh request can arrive while a stale logo is still cached in state.
    React.useEffect(() => {
      setLogoFailed(false);
    }, [request?.logoUri]);

    const { requestContinue, handleDismiss } = useHandoffDismiss(async () => {
      if (!request) return;
      const { projectId, slug, label, fallbackConnectUrl } = request;
      let connected = false;

      try {
        const started = await pipedreamConnect(projectId, slug, {
          successRedirectUri: CONNECT_SUCCESS_URI,
          errorRedirectUri: CONNECT_ERROR_URI,
        });
        if (started.connectUrl) {
          // `openAuthSessionAsync` auto-dismisses once Pipedream redirects to
          // our scheme.
          const result = await WebBrowser.openAuthSessionAsync(
            started.connectUrl,
            CONNECT_RETURN_URL,
          );
          if (result.type === 'success' && !/[?&]error=|\/error(?:$|[/?])/.test(result.url)) {
            const finalized = await pipedreamFinalize(projectId, slug).catch(() => null);
            connected = finalized?.connected ?? false;
          }
        } else {
          await openBrowserUntilClosed(fallbackConnectUrl);
        }
      } catch {
        // The project-scoped connect couldn't even start (connector isn't a
        // declared Pipedream app for this project, network failure, …) — the
        // agent's own link is the fallback, opened plain since it carries no
        // redirect the browser can detect.
        try {
          await openBrowserUntilClosed(fallbackConnectUrl);
        } catch {
          // The browser trip itself failed to open; the status re-check below
          // still runs, in case the connector was completed another way.
        }
      }

      if (!connected) {
        try {
          const rows = await listConnectors(projectId);
          connected = isConnectorConnected(rows.connectors.find((row) => row.slug === slug));
        } catch {
          // Leave `connected` false — the row keeps offering Connect.
        }
      }

      queryClient.invalidateQueries({ queryKey: projectKeys.connectors(projectId) });
      toast[connected ? 'success' : 'error'](connectorHandoffToast(label, connected));
    });

    React.useImperativeHandle(ref, () => ({
      open: () => sheetRef.current?.open(),
      close: () => sheetRef.current?.close(),
    }));

    const handleContinue = React.useCallback(() => {
      requestContinue(sheetRef);
    }, [requestContinue]);

    const copy = request ? connectorHandoffCopy(request.label) : null;
    const showLogo = !!request?.logoUri && !logoFailed;

    return (
      <Sheet ref={sheetRef} enablePanDownToClose onDismiss={handleDismiss}>
        <SheetBody className="items-center pt-2">
          <View className="flex-row items-center">
            <View
              className="items-center justify-center overflow-hidden rounded-2xl bg-secondary"
              style={{ width: TILE_SIZE, height: TILE_SIZE }}>
              {showLogo ? (
                <Image
                  source={{ uri: request!.logoUri! }}
                  resizeMode="contain"
                  onError={() => setLogoFailed(true)}
                  style={{ width: TILE_SIZE, height: TILE_SIZE }}
                />
              ) : (
                <Icon as={PlugIcon} size={24} className="text-foreground" />
              )}
            </View>
            <View className="mx-3 w-6 border-t border-dashed border-border" />
            <View
              className="items-center justify-center rounded-2xl bg-foreground"
              style={{ width: TILE_SIZE, height: TILE_SIZE }}>
              {/* Same inverted-fill rule as `ConnectProviderSheet`'s tile. */}
              <KortixLogo size={24} color={isDark ? 'light' : 'dark'} />
            </View>
          </View>
          <Text variant="large" className="mt-5 text-center">
            {copy?.title ?? 'Connect'}
          </Text>
          <Text variant="muted" className="mt-2 text-center">
            {copy?.body ?? "Sign in on kortix.com. You come back to this chat when it's done."}
          </Text>
          <View className="mt-6 w-full" style={{ gap: 10 }}>
            <Button size="lg" className="rounded-full" onPress={handleContinue}>
              {/* Label left, arrow right: the spread lives on a wrapper, never
                  as a class on the Button (Button takes rounded-full only). */}
              <View className="flex-1 flex-row items-center justify-between">
                <Text>Continue</Text>
                <Icon as={ArrowUpRightIcon} size={18} />
              </View>
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="rounded-full"
              onPress={() => sheetRef.current?.close()}>
              <Text>Not now</Text>
            </Button>
          </View>
        </SheetBody>
      </Sheet>
    );
  },
);
ConnectorAuthSheet.displayName = 'ConnectorAuthSheet';
