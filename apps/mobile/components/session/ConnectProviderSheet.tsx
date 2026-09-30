/**
 * ConnectProviderSheet — the handoff before the composer's model picker sends
 * the user to the browser to connect a provider (COR-125/COR-158 Task 9).
 *
 * Handle only, no title row: two 56pt tiles (a plug icon on `bg-secondary`,
 * the Kortix symbol on `bg-foreground`, joined by a dashed connector) over a
 * title and one muted line, then a primary "Continue" pill (opens
 * `/projects/:id/customize/models?return_to=kortix://providers/connected` in
 * an in-app auth session that closes itself once a provider is connected)
 * and a secondary
 * "Not now".
 *
 * Every "Connect provider" / "Connect model" entry (`ModelPickerSheet`'s
 * empty state, project home, and the thread composer) opens this sheet
 * instead of leaving the app directly. `PickerSheet` dismisses the model
 * sheet first and opens this one only from its own `onDismiss` (never two
 * overlays at once) when the empty state's action is tapped.
 *
 * **Continue closes this sheet first, then opens the browser** (Paper board
 * 08: "back exactly where they were" — never the sheet still open behind or
 * after the browser), via `useHandoffDismiss` — the same close-then-open
 * primitive `ConnectorAuthSheet` (COR-158's in-chat connector hand-off)
 * reuses rather than duplicates. The component itself stays mounted the
 * whole time (a permanent sibling of the composer in
 * `ProjectHome`/`SessionPage`, like `ModelPickerSheet`), so the
 * browser/refetch/toast sequence runs from the sheet's own `onDismiss` — its
 * closures over `projectId` / `onRefetchModels` / `toast` are unaffected by
 * the *modal* dismissing.
 *
 * The sheet only ever opens from a "no models" state (the pill and the empty
 * state both gate on an empty catalog), so any model the refetch turns up
 * after the browser closes means the trip connected a provider.
 */
import * as React from 'react';
import { View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useColorScheme } from 'nativewind';

import { KORTIX_WEB_URL } from '@/lib/kortix-web';
import { Sheet, type SheetRef } from '@/components/kortix/sheet';
import { useToast } from '@/components/kortix/toast-provider';
import { Icon } from '@/components/ui/icon';
import { PlugIcon } from '@/lib/icons';
import {
  PROVIDER_CONNECTED_URI,
  PROVIDER_RETURN_URL,
  projectModelsWebUrl,
} from '@/lib/session/connect-model';
import { HandoffShell, TILE_SIZE, useHandoffDismiss } from './handoff-sheet';


export interface ConnectProviderSheetProps {
  projectId: string;
  /** Refetches the project's model catalog; resolves to the model count the
   *  project offers after the refetch. */
  onRefetchModels: () => Promise<number>;
}

export const ConnectProviderSheet = React.forwardRef<SheetRef, ConnectProviderSheetProps>(
  ({ projectId, onRefetchModels }, ref) => {
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const toast = useToast();
    const sheetRef = React.useRef<SheetRef>(null);

    const { requestContinue, handleDismiss } = useHandoffDismiss(async () => {
      try {
        // The page redirects to PROVIDER_CONNECTED_URI once the project has a
        // usable model; the auth session closes itself on that redirect. It
        // also resolves when the user closes the browser by hand (Android:
        // on return to the app), so the refetch below always runs after the
        // trip, never at launch.
        await WebBrowser.openAuthSessionAsync(
          projectModelsWebUrl(KORTIX_WEB_URL, projectId, PROVIDER_CONNECTED_URI),
          PROVIDER_RETURN_URL,
        );
      } catch {
        // The browser trip failed to open; still check in case something
        // changed (e.g. the provider was added another way).
      }
      const count = await onRefetchModels();
      if (count > 0) toast.success('Provider connected');
    });

    React.useImperativeHandle(ref, () => ({
      open: () => sheetRef.current?.open(),
      close: () => sheetRef.current?.close(),
    }));

    const handleContinue = React.useCallback(() => {
      requestContinue(sheetRef);
    }, [requestContinue]);

    return (
      <Sheet ref={sheetRef} enablePanDownToClose onDismiss={handleDismiss}>
        <HandoffShell
          leadingTile={<View className="items-center justify-center rounded-2xl bg-secondary" style={{ width: TILE_SIZE, height: TILE_SIZE }}><Icon as={PlugIcon} size={24} className="text-foreground" /></View>}
          title="Connect a model provider"
          body="Add a provider on kortix.com. You come back here when you're done."
          onContinue={handleContinue}
          onClose={() => sheetRef.current?.close()}
          notNowVariant="secondary"
          isDark={isDark}
        />
      </Sheet>
    );
  },
);
ConnectProviderSheet.displayName = 'ConnectProviderSheet';
