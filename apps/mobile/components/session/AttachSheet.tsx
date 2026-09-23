/**
 * AttachSheet — what the composer's `+` opens, on project home and in a
 * thread: one row of three tiles, Camera · Photos · Files. No title.
 *
 * A tile closes the sheet, and the source opens when the sheet has gone
 * (`onDismiss`) — never two overlays at once, and no native chooser in
 * between. `children` render under the tiles (the thread's AutoContinue row);
 * they close the sheet the same way through `closeThen`.
 *
 * Layout is `PickerSheet`'s: 16pt sides, 4pt under the handle, 16pt between
 * blocks, bottom `max(insets.bottom, 16) + 8`.
 */
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Sheet, type SheetRef } from '@/components/kortix/sheet';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { CameraIcon, FilesIcon, ImageIcon, type AppIcon } from '@/lib/icons';
import { ATTACH_SOURCES, type AttachSource, type AttachSourceId } from '@/lib/session/attach-sources';
import type { AttachedFile } from '@/lib/session/attachments';
import { useAttachmentPicker } from './useAttachmentPicker';
import { usePressScale } from './use-press-scale';

const SOURCE_ICONS: Record<AttachSourceId, AppIcon> = {
  camera: CameraIcon,
  photos: ImageIcon,
  files: FilesIcon,
};

export interface AttachSheetRef extends SheetRef {
  /** Closes the sheet, then runs `action` once it has gone. */
  closeThen: (action: () => void) => void;
}

export interface AttachSheetProps {
  onPick: (files: AttachedFile[]) => void;
  /** More blocks under the tiles. */
  children?: React.ReactNode;
}

export const AttachSheet = React.forwardRef<AttachSheetRef, AttachSheetProps>(
  ({ onPick, children }, ref) => {
    const sheetRef = React.useRef<SheetRef>(null);
    const afterCloseRef = React.useRef<(() => void) | null>(null);
    const insets = useSafeAreaInsets();
    const [cameraDenied, setCameraDenied] = React.useState(false);

    const showCameraDenied = React.useCallback(() => setCameraDenied(true), []);
    const openSource = useAttachmentPicker(onPick, showCameraDenied);

    const closeThen = React.useCallback((action: () => void) => {
      afterCloseRef.current = action;
      sheetRef.current?.close();
    }, []);

    React.useImperativeHandle(
      ref,
      () => ({
        open: () => {
          afterCloseRef.current = null;
          sheetRef.current?.open();
        },
        close: () => sheetRef.current?.close(),
        closeThen,
      }),
      [closeThen],
    );

    const handleDismiss = React.useCallback(() => {
      const action = afterCloseRef.current;
      afterCloseRef.current = null;
      action?.();
    }, []);

    return (
      <>
        <Sheet ref={sheetRef} enablePanDownToClose onDismiss={handleDismiss}>
          <View
            className="gap-4 px-4 pt-1"
            style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
            <View className="flex-row gap-2">
              {ATTACH_SOURCES.map((source) => (
                <SourceTile
                  key={source.id}
                  source={source}
                  onPress={() => closeThen(() => openSource(source.id))}
                />
              ))}
            </View>
            {children}
          </View>
        </Sheet>

        <AlertDialog open={cameraDenied} onOpenChange={setCameraDenied}>
          <AlertDialogContent className="rounded-3xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Camera access is off</AlertDialogTitle>
              <AlertDialogDescription>
                Turn on Camera for Kortix in Settings to take a photo.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button variant="secondary" size="lg" className="rounded-full">
                  <Text>Cancel</Text>
                </Button>
              </AlertDialogCancel>
              <Button
                size="lg"
                className="rounded-full"
                onPress={() => {
                  setCameraDenied(false);
                  void Linking.openSettings();
                }}>
                <Text>Open Settings</Text>
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  },
);
AttachSheet.displayName = 'AttachSheet';

/** One source: 24pt icon over its label on a `bg-secondary` tile, a third of the row. */
function SourceTile({ source, onPress }: { source: AttachSource; onPress: () => void }) {
  const { onPressIn, onPressOut, animatedStyle } = usePressScale(0.96);

  return (
    <Reanimated.View className="flex-1" style={animatedStyle}>
      <Pressable
        onPress={() => {
          haptics.tap();
          onPress();
        }}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        accessibilityRole="button"
        accessibilityLabel={source.label}
        accessibilityHint={source.hint}
        className="min-h-24 items-center justify-center gap-2 rounded-2xl bg-secondary px-2 py-4">
        <Icon as={SOURCE_ICONS[source.id]} size={24} className="text-foreground" />
        <Text variant="small" numberOfLines={1}>
          {source.label}
        </Text>
      </Pressable>
    </Reanimated.View>
  );
}
