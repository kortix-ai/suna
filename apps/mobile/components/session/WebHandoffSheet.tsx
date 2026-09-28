/**
 * WebHandoffSheet — the generic "continue on the web app" hand-off sheet
 * (KRTX-249). A title, one short line of body copy, and a primary Continue
 * pill that closes the sheet first, then runs the hand-off (`run`) — Paper
 * board 08's close-then-open rule ("never two overlays"), via
 * `useHandoffDismiss`, the same primitive `ConnectProviderSheet` and
 * `ConnectorAuthSheet` use. A secondary "Not now" pill closes without
 * running anything; `onCancel` fires then (Not now, a swipe) and never
 * after Continue — the project switcher uses it to come back.
 *
 * Handle only, no icon artwork — `ConnectProviderSheet` keeps its own
 * dual-tile graphic and arrow-trailing Continue button, which are specific to
 * that flow; this sheet is the plain shell for every other web hand-off.
 *
 * First use: project Settings → Customize → Connectors ("Customize in the
 * web app" / "Connectors are set up on kortix.com." / "Continue" opens the
 * connectors web flow). Task 3 (KRTX-246, project/account creation and the
 * GitHub import flow) reuses it with its own copy and `run`.
 */
import * as React from 'react';
import { View } from 'react-native';

import { Sheet, SheetBody, type SheetRef } from '@/components/kortix/sheet';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useHandoffDismiss } from './handoff-sheet';

export interface WebHandoffSheetProps {
  title: string;
  /** One short line of body copy under the title. */
  line: string;
  continueLabel?: string;
  /** Secondary pill label; closes the sheet without running the hand-off. */
  notNowLabel?: string;
  /** Runs once the sheet has fully closed after Continue — never while the sheet is still visible. */
  run: () => void | Promise<void>;
  /** Fires once the sheet has fully closed without Continue (Not now, a swipe). */
  onCancel?: () => void;
}

export const WebHandoffSheet = React.forwardRef<SheetRef, WebHandoffSheetProps>(
  ({ title, line, continueLabel = 'Continue', notNowLabel = 'Not now', run, onCancel }, ref) => {
    const sheetRef = React.useRef<SheetRef>(null);
    const { requestContinue, handleDismiss } = useHandoffDismiss(run, onCancel);

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
          <Text variant="large" className="text-center">
            {title}
          </Text>
          <Text variant="muted" className="mt-2 text-center">
            {line}
          </Text>
          <View className="mt-6 w-full" style={{ gap: 10 }}>
            <Button size="lg" className="rounded-full" onPress={handleContinue}>
              <Text>{continueLabel}</Text>
            </Button>
            <Button variant="secondary" size="lg" className="rounded-full" onPress={() => sheetRef.current?.close()}>
              <Text>{notNowLabel}</Text>
            </Button>
          </View>
        </SheetBody>
      </Sheet>
    );
  },
);
WebHandoffSheet.displayName = 'WebHandoffSheet';
