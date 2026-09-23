/**
 * ConnectProviderSheet — the handoff before the composer's model picker sends
 * the user to the browser to connect a provider (COR-125/COR-158 Task 9).
 *
 * Handle only, no title row: two 56pt tiles (a plug icon on `bg-secondary`,
 * the Kortix symbol on `bg-foreground`, joined by a dashed connector) over a
 * title and one muted line, then a primary "Continue" pill (opens
 * `/projects/:id/customize/models` in the in-app browser) and a ghost
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
import { KortixLogo } from '@/components/kortix/KortixLogo';
import { Sheet, SheetBody, type SheetRef } from '@/components/kortix/sheet';
import { useToast } from '@/components/kortix/toast-provider';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ArrowUpRightIcon, PlugIcon } from '@/lib/icons';
import { projectModelsWebUrl } from '@/lib/session/connect-model';
import { useHandoffDismiss } from './handoff-sheet';

const TILE_SIZE = 56;

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
        await WebBrowser.openBrowserAsync(projectModelsWebUrl(KORTIX_WEB_URL, projectId));
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
        <SheetBody className="items-center pt-2">
          <View className="flex-row items-center">
            <View
              className="items-center justify-center rounded-2xl bg-secondary"
              style={{ width: TILE_SIZE, height: TILE_SIZE }}>
              <Icon as={PlugIcon} size={24} className="text-foreground" />
            </View>
            <View className="mx-3 w-6 border-t border-dashed border-border" />
            <View
              className="items-center justify-center rounded-2xl bg-foreground"
              style={{ width: TILE_SIZE, height: TILE_SIZE }}>
              {/* Inverted-fill tile: `foreground`/`background` swap per theme,
                  so the symbol variant swaps the other way to stay legible —
                  white on light theme's dark tile, dark on dark theme's light
                  tile (`KortixLogo` has no token color, so the variant is
                  picked here). */}
              <KortixLogo size={24} color={isDark ? 'light' : 'dark'} />
            </View>
          </View>
          <Text variant="large" className="mt-5 text-center">
            Connect a model provider
          </Text>
          <Text variant="muted" className="mt-2 text-center">
            Add a provider on kortix.com. You come back here when you're done.
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
ConnectProviderSheet.displayName = 'ConnectProviderSheet';
