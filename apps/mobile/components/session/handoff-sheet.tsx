/**
 * The "Continue closes the sheet first, then the hand-off runs" pattern —
 * Paper board 08's close-then-open rule ("never two overlays"), factored out
 * of `ConnectProviderSheet` so `ConnectorAuthSheet` (COR-158's connector
 * hand-off) reuses it instead of duplicating the pendingRef dance.
 *
 * `run` fires from the sheet's own `onDismiss`, once, and ONLY when the
 * dismiss followed a Continue tap — a swipe-to-close or "Not now" never fires
 * it. The sheet component itself stays mounted the whole time (a permanent
 * sibling of the composer), so `run`'s closures over its own props are
 * unaffected by the *modal* dismissing — only `pendingRef` distinguishes the
 * two kinds of dismiss.
 *
 * `onCancel` (optional) fires from the same `onDismiss` when the dismiss did
 * NOT follow Continue — "Not now", a swipe, the backdrop — so a caller that
 * closed its own sheet to show this one can bring it back.
 */
import * as React from 'react';
import { View } from 'react-native';

import { SheetBody, type SheetRef } from '@/components/kortix/sheet';
import { KortixLogo } from '@/components/kortix/KortixLogo';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ArrowUpRightIcon } from '@/lib/icons';
import { haptics } from '@/lib/haptics';

export function useHandoffDismiss(run: () => void | Promise<void>, onCancel?: () => void) {
  // Set only by Continue, read (and cleared) once by `handleDismiss`.
  const pendingRef = React.useRef(false);

  const requestContinue = React.useCallback(
    (sheetRef: React.RefObject<SheetRef | null>) => {
      haptics.tap();
      // Close first — the hand-off runs only once this sheet is fully gone
      // (`handleDismiss`), so the two are never on screen together.
      pendingRef.current = true;
      sheetRef.current?.close();
    },
    [],
  );

  const handleDismiss = React.useCallback(async () => {
    if (!pendingRef.current) {
      onCancel?.();
      return;
    }
    pendingRef.current = false;
    await run();
  }, [run, onCancel]);

  return { requestContinue, handleDismiss };
}

export const TILE_SIZE = 56;

export function HandoffShell({ leadingTile, title, body, onContinue, onClose, notNowVariant, isDark }: {
  leadingTile: React.ReactNode;
  title: string;
  body: string;
  onContinue: () => void;
  onClose: () => void;
  notNowVariant: 'secondary' | 'ghost';
  isDark: boolean;
}) {
  return (
        <SheetBody className="items-center pt-2">
          <View className="flex-row items-center">
            {leadingTile}
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
            {title}
          </Text>
          <Text variant="muted" className="mt-2 text-center">
            {body}
          </Text>
          <View className="mt-6 w-full" style={{ gap: 10 }}>
            <Button size="lg" className="rounded-full" onPress={onContinue}>
              {/* Label left, arrow right: the spread lives on a wrapper, never
                  as a class on the Button (Button takes rounded-full only). */}
              <View className="flex-1 flex-row items-center justify-between">
                <Text>Continue</Text>
                <Icon as={ArrowUpRightIcon} size={18} />
              </View>
            </Button>
            <Button
              variant={notNowVariant}
              size="lg"
              className="rounded-full"
              onPress={onClose}>
              <Text>Not now</Text>
            </Button>
          </View>
        </SheetBody>
  );
}
