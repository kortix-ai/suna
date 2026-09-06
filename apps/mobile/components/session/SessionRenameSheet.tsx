/**
 * SessionRenameSheet — bottom sheet to rename a project session.
 * Ported from web's RenameSessionModal: PATCH /projects/:id/sessions/:sid
 * with { name }. Clearing the input reverts to the automatic title.
 */
import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { View, ActivityIndicator, Alert, Keyboard } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { BottomSheetModal, BottomSheetView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { haptics } from '@/lib/haptics';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { updateProjectSession, type ProjectSession } from '@/lib/projects/projects-client';
import { projectKeys } from '@/lib/projects/hooks';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';

const MAX_NAME_LENGTH = 120;

interface SessionRenameSheetProps {
  projectId: string;
  session: ProjectSession | null;
}

export const SessionRenameSheet = forwardRef<BottomSheetModal, SessionRenameSheetProps>(
  function SessionRenameSheet({ projectId, session }, ref) {
    const sheetBg = useSheetBackground();
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const insets = useSafeAreaInsets();
    const queryClient = useQueryClient();
    const theme = useThemeColors();

    const currentName = session?.custom_name ?? '';
    const [value, setValue] = useState(currentName);

    const fgColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
    const mutedColor = isDark ? withAlpha(THEME.dark.foreground, 0.4) : withAlpha(THEME.light.foreground, 0.4);
    const sheetPadding = insets.bottom + 16;

    // Own the sheet ref internally so dismiss works regardless of how the
    // parent's ref is shaped; expose it unchanged to the parent.
    const sheetRef = useRef<BottomSheetModal>(null);
    useImperativeHandle(ref, () => sheetRef.current!, []);

    const dismiss = useCallback(() => {
      sheetRef.current?.dismiss();
    }, []);

    const rename = useMutation({
      mutationFn: (name: string) => updateProjectSession(projectId, session!.session_id, { name }),
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) });
        haptics.success();
        dismiss();
      },
      onError: (err: Error) => {
        haptics.warning();
        Alert.alert('Rename failed', err.message || 'Could not rename the session.');
      },
    });

    const handleSave = useCallback(() => {
      if (!session || rename.isPending) return;
      const trimmed = value.trim();
      if (trimmed === currentName) {
        dismiss();
        return;
      }
      Keyboard.dismiss();
      rename.mutate(trimmed);
    }, [session, rename, value, currentName, dismiss]);


    return (
      <BottomSheetModal
        ref={sheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.4} />}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        // Seed on presentation only (from -1), and re-seed on dismiss so the
        // next open never flashes the previous open's draft for a frame.
        onAnimate={(from, to) => {
          if (from === -1 && to === 0) setValue(session?.custom_name ?? '');
        }}
        onDismiss={() => setValue(session?.custom_name ?? '')}
        backgroundStyle={{
          backgroundColor: sheetBg,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}>
        <BottomSheetView
          style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          {/* Header */}
          <View className="mb-5 flex-row items-center">
            <View
              className="mr-3 h-10 w-10 items-center justify-center rounded-xl"
              style={{
                backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.05),
              }}>
              <Ionicons name="pencil-outline" size={20} color={fgColor} />
            </View>
            <View className="flex-1">
              <Text className="font-roobert-semibold text-lg" style={{ color: fgColor }}>
                Rename session
              </Text>
              <Text
                className="mt-0.5 font-roobert text-xs"
                style={{ color: mutedColor }}
                numberOfLines={1}>
                Leave empty to use the automatic title
              </Text>
            </View>
          </View>

          {/* Input */}
          <BottomSheetTextInput
            value={value}
            onChangeText={setValue}
            placeholder={session?.name || 'Session name'}
            placeholderTextColor={isDark ? withAlpha(THEME.dark.foreground, 0.25) : withAlpha(THEME.light.foreground, 0.3)}
            autoFocus
            maxLength={MAX_NAME_LENGTH}
            returnKeyType="done"
            onSubmitEditing={handleSave}
            style={{
              backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04),
              borderWidth: 1,
              borderColor: isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.08),
              borderRadius: 14,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
              fontFamily: 'Roobert',
              color: fgColor,
              marginBottom: 20,
            }}
          />

          {/* Save */}
          <Button
            variant="ghost"
            onPress={handleSave}
            disabled={rename.isPending}
            className="h-auto items-center justify-center rounded-full active:bg-transparent active:opacity-70"
            style={{
              paddingVertical: 14,
              backgroundColor: theme.primary,
            }}>
            {rename.isPending ? (
              <ActivityIndicator size="small" color={theme.primaryForeground} />
            ) : (
              <Text
                className="font-roobert-medium text-[15px]"
                style={{ color: theme.primaryForeground }}>
                Save
              </Text>
            )}
          </Button>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);
