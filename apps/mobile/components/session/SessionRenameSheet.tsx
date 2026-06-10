/**
 * SessionRenameSheet — bottom sheet to rename a project session.
 * Ported from web's RenameSessionDialog: PATCH /projects/:id/sessions/:sid
 * with { name }. Clearing the input reverts to the automatic title.
 */
import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { View, TouchableOpacity, ActivityIndicator, Alert, Keyboard } from 'react-native';
import { Text } from '@/components/ui/text';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getSheetBg } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import {
  updateProjectSession,
  type ProjectSession,
} from '@/lib/projects/projects-client';
import { projectKeys } from '@/lib/projects/hooks';

const MAX_NAME_LENGTH = 120;

interface SessionRenameSheetProps {
  projectId: string;
  session: ProjectSession | null;
}

export const SessionRenameSheet = forwardRef<BottomSheetModal, SessionRenameSheetProps>(
  function SessionRenameSheet({ projectId, session }, ref) {
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const insets = useSafeAreaInsets();
    const queryClient = useQueryClient();

    const currentName = session?.custom_name ?? '';
    const [value, setValue] = useState(currentName);

    const fgColor = isDark ? '#F8F8F8' : '#121215';
    const mutedColor = isDark ? 'rgba(248, 248, 248, 0.4)' : 'rgba(18, 18, 21, 0.4)';
    const sheetPadding = insets.bottom + 16;

    // Own the sheet ref internally so dismiss works regardless of how the
    // parent's ref is shaped; expose it unchanged to the parent.
    const sheetRef = useRef<BottomSheetModal>(null);
    useImperativeHandle(ref, () => sheetRef.current!, []);

    const dismiss = useCallback(() => {
      sheetRef.current?.dismiss();
    }, []);

    const rename = useMutation({
      mutationFn: (name: string) =>
        updateProjectSession(projectId, session!.session_id, { name }),
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

    const renderBackdrop = useCallback(
      (props: BottomSheetBackdropProps) => (
        <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />
      ),
      [],
    );

    return (
      <BottomSheetModal
        ref={sheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        // Seed on presentation only (from -1), and re-seed on dismiss so the
        // next open never flashes the previous open's draft for a frame.
        onAnimate={(from, to) => { if (from === -1 && to === 0) setValue(session?.custom_name ?? ''); }}
        onDismiss={() => setValue(session?.custom_name ?? '')}
        backgroundStyle={{
          backgroundColor: getSheetBg(isDark),
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          {/* Header */}
          <View className="flex-row items-center mb-5">
            <View
              className="w-10 h-10 rounded-xl items-center justify-center mr-3"
              style={{
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.05)',
              }}
            >
              <Ionicons name="pencil-outline" size={20} color={fgColor} />
            </View>
            <View className="flex-1">
              <Text className="text-lg font-roobert-semibold" style={{ color: fgColor }}>
                Rename session
              </Text>
              <Text className="text-xs font-roobert mt-0.5" style={{ color: mutedColor }} numberOfLines={1}>
                Leave empty to use the automatic title
              </Text>
            </View>
          </View>

          {/* Input */}
          <BottomSheetTextInput
            value={value}
            onChangeText={setValue}
            placeholder={session?.name || 'Session name'}
            placeholderTextColor={isDark ? 'rgba(248, 248, 248, 0.25)' : 'rgba(18, 18, 21, 0.3)'}
            autoFocus
            maxLength={MAX_NAME_LENGTH}
            returnKeyType="done"
            onSubmitEditing={handleSave}
            style={{
              backgroundColor: isDark ? 'rgba(248, 248, 248, 0.06)' : 'rgba(18, 18, 21, 0.04)',
              borderWidth: 1,
              borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.08)',
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
          <TouchableOpacity
            onPress={handleSave}
            disabled={rename.isPending}
            activeOpacity={0.7}
            className="rounded-full items-center justify-center"
            style={{
              paddingVertical: 14,
              backgroundColor: isDark ? '#F8F8F8' : '#121215',
              opacity: rename.isPending ? 0.6 : 1,
            }}
          >
            {rename.isPending ? (
              <ActivityIndicator size="small" color={isDark ? '#121215' : '#F8F8F8'} />
            ) : (
              <Text className="text-[15px] font-roobert-medium" style={{ color: isDark ? '#121215' : '#F8F8F8' }}>
                Save
              </Text>
            )}
          </TouchableOpacity>
        </BottomSheetView>
      </BottomSheetModal>
    );
  },
);
