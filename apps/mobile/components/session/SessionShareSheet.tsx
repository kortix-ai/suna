/**
 * SessionShareSheet — bottom sheet to set who can see/open a session.
 * Ported from web's ShareSessionModal + SharingPicker:
 * PUT /projects/:id/sessions/:sid/sharing with
 *   { mode: 'project' } | { mode: 'private', ownerId } | { mode: 'members', memberIds }.
 * Members come from the same project-access list the Members page uses.
 */
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { View, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
// Use react-native-gesture-handler's Pressable (not RN's own) for correct
// Android touch handling nested inside a BottomSheet's pan gesture — the
// same underlying gesture system @gorhom/bottom-sheet's legacy touchables
// module re-exported, without importing that retired module.
import { Pressable } from 'react-native-gesture-handler';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { haptics } from '@/lib/haptics';
import {
  setProjectSessionSharing,
  type ProjectSession,
  type SessionSharing,
} from '@/lib/projects/projects-client';
import { projectKeys, useProjectAccess } from '@/lib/projects/hooks';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';

type ShareMode = 'project' | 'private' | 'members';

const MODE_OPTIONS: Array<{
  mode: ShareMode;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  description: string;
}> = [
  {
    mode: 'private',
    icon: 'lock-closed-outline',
    label: 'Only you',
    description: 'Private to you',
  },
  {
    mode: 'project',
    icon: 'globe-outline',
    label: 'Whole team',
    description: 'Everyone in this project',
  },
  {
    mode: 'members',
    icon: 'people-outline',
    label: 'Select members',
    description: 'Only the members you pick',
  },
];

interface SessionShareSheetProps {
  projectId: string;
  session: ProjectSession | null;
}

export const SessionShareSheet = forwardRef<BottomSheetModal, SessionShareSheetProps>(
  function SessionShareSheet({ projectId, session }, ref) {
    const sheetBg = useSheetBackground();
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const insets = useSafeAreaInsets();
    const theme = useThemeColors();
    const queryClient = useQueryClient();

    const [mode, setMode] = useState<ShareMode>('private');
    const [memberIds, setMemberIds] = useState<string[]>([]);
    // Group grants have no picker UI here (web drops them too), but round-trip
    // them so saving member changes never silently revokes group access.
    const [groupIds, setGroupIds] = useState<string[]>([]);
    // Only fetch the member list while the sheet is open — this component is
    // permanently mounted on the project screen (web fetches on dialog open).
    const [open, setOpen] = useState(false);
    // Pin the Kortix session id when the sheet opens so Save still works if the
    // parent briefly clears activeProjectSession while this modal is up.
    const sessionIdRef = useRef<string | null>(null);

    const access = useProjectAccess(open ? projectId : null);
    const members = access.data?.members ?? [];
    const viewerUserId = access.data?.viewer_user_id;

    const fgColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
    const mutedColor = isDark ? withAlpha(THEME.dark.foreground, 0.4) : withAlpha(THEME.light.foreground, 0.4);
    const border = isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.08);
    const sheetPadding = insets.bottom + 16;

    // Selected members first, like the web picker.
    const sortedMembers = useMemo(() => {
      const sel = new Set(memberIds);
      return [...members].sort((a, b) => Number(sel.has(b.user_id)) - Number(sel.has(a.user_id)));
    }, [members, memberIds]);

    const sheetRef = useRef<BottomSheetModal>(null);
    useImperativeHandle(
      ref,
      () => ({
        present: (...args) => sheetRef.current?.present(...args),
        dismiss: (...args) => sheetRef.current?.dismiss(...args),
        snapToIndex: (...args) => sheetRef.current?.snapToIndex(...args),
        snapToPosition: (...args) => sheetRef.current?.snapToPosition(...args),
        expand: (...args) => sheetRef.current?.expand(...args),
        collapse: (...args) => sheetRef.current?.collapse(...args),
        close: (...args) => sheetRef.current?.close(...args),
        forceClose: (...args) => sheetRef.current?.forceClose(...args),
      }),
      [],
    );

    const dismiss = useCallback(() => {
      sheetRef.current?.dismiss();
    }, []);

    // Seed mode/members from the session's current sharing on each open.
    const seedFromSession = useCallback(() => {
      sessionIdRef.current = session?.session_id ?? null;
      const sharing = session?.sharing;
      if (sharing?.mode === 'members') {
        setMode('members');
        setMemberIds(sharing.memberIds ?? []);
        setGroupIds(sharing.groupIds ?? []);
      } else if (sharing?.mode === 'project') {
        setMode('project');
        setMemberIds([]);
        setGroupIds([]);
      } else {
        setMode('private');
        setMemberIds([]);
        setGroupIds([]);
      }
    }, [session]);

    const save = useMutation({
      mutationFn: () => {
        const sessionId = sessionIdRef.current ?? session?.session_id;
        if (!sessionId) {
          throw new Error('No session selected. Close and try again.');
        }
        const intent: SessionSharing =
          mode === 'project'
            ? { mode: 'project' }
            : mode === 'members'
              ? { mode: 'members', memberIds, groupIds }
              : { mode: 'private', ownerId: '' }; // ownerId resolved server-side (web parity)
        return setProjectSessionSharing(projectId, sessionId, intent);
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) });
        haptics.success();
        dismiss();
      },
      onError: (err: Error) => {
        haptics.warning();
        Alert.alert('Sharing failed', err.message || 'Could not update session sharing.');
      },
    });

    const incomplete = mode === 'members' && memberIds.length === 0;

    const handleSave = useCallback(() => {
      if (save.isPending || incomplete) return;
      const sessionId = sessionIdRef.current ?? session?.session_id;
      if (!sessionId) {
        haptics.warning();
        Alert.alert('Sharing failed', 'No session selected. Close and try again.');
        return;
      }
      haptics.tap();
      save.mutate();
    }, [save, incomplete, session?.session_id]);

    const toggleMember = useCallback((userId: string) => {
      haptics.selection();
      setMemberIds((ids) =>
        ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId],
      );
    }, []);


    return (
      <BottomSheetModal
        ref={sheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.4} />}
        onChange={(index) => setOpen(index >= 0)}
        onAnimate={(from, to) => {
          if (from === -1 && to === 0) seedFromSession();
        }}
        onDismiss={seedFromSession}
        backgroundStyle={{
          backgroundColor: sheetBg,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}>
        {/* Single scrollable child — required for enableDynamicSizing to size
            correctly and keep the primary action visible at the bottom. */}
        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: 24,
            paddingTop: 8,
            paddingBottom: sheetPadding,
          }}>
          {/* Header */}
          <View className="mb-5 flex-row items-center">
            <View
              className="mr-3 h-10 w-10 items-center justify-center rounded-xl"
              style={{
                backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.05),
              }}>
              <Ionicons name="share-outline" size={20} color={fgColor} />
            </View>
            <View className="flex-1">
              <Text className="font-roobert-semibold text-lg" style={{ color: fgColor }}>
                Share session
              </Text>
              <Text
                className="mt-0.5 font-roobert text-xs"
                style={{ color: mutedColor }}
                numberOfLines={2}>
                Sessions are private to you by default. Share read/continue access with your team.
              </Text>
            </View>
          </View>

          {/* Mode options */}
          {MODE_OPTIONS.map((opt) => {
            const on = mode === opt.mode;
            const optionBg = isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.03);
            return (
              <Pressable
                key={opt.mode}
                onPress={() => {
                  haptics.selection();
                  setMode(opt.mode);
                }}
                style={({ pressed }) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderRadius: 16,
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    marginBottom: 8,
                    borderWidth: 1,
                    borderColor: on ? theme.primary : border,
                    backgroundColor: on ? optionBg : 'transparent',
                  },
                  pressed && { opacity: 0.7 },
                ]}>
                <Ionicons name={opt.icon} size={19} color={on ? theme.primary : mutedColor} />
                <View style={{ marginLeft: 12, flex: 1 }}>
                  <Text className="font-roobert-medium text-[15px]" style={{ color: fgColor }}>
                    {opt.label}
                  </Text>
                  <Text className="mt-0.5 font-roobert text-xs" style={{ color: mutedColor }}>
                    {opt.description}
                  </Text>
                </View>
                {on && <Ionicons name="checkmark" size={18} color={theme.primary} />}
              </Pressable>
            );
          })}

          {/* Member picker (members mode) */}
          {mode === 'members' && (
            <View
              className="mb-2 rounded-2xl"
              style={{ borderWidth: 1, borderColor: border, overflow: 'hidden' }}>
              {access.isLoading ? (
                <View style={{ paddingVertical: 28, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={mutedColor} />
                </View>
              ) : members.length === 0 ? (
                <Text
                  className="text-center font-roobert text-sm"
                  style={{ color: mutedColor, paddingVertical: 24 }}>
                  No other members in this project yet.
                </Text>
              ) : (
                sortedMembers.map((m) => {
                  const on = memberIds.includes(m.user_id);
                  const isViewer = m.user_id === viewerUserId;
                  return (
                    <Pressable
                      key={m.user_id}
                      onPress={() => toggleMember(m.user_id)}
                      style={({ pressed }) => [
                        {
                          flexDirection: 'row',
                          alignItems: 'center',
                          paddingHorizontal: 16,
                          paddingVertical: 12,
                          borderBottomWidth: 1,
                          borderBottomColor: border,
                        },
                        pressed && { opacity: 0.7 },
                      ]}>
                      <View
                        className="mr-3 h-8 w-8 items-center justify-center rounded-full"
                        style={{
                          backgroundColor: isDark
                            ? withAlpha(THEME.dark.foreground, 0.08)
                            : withAlpha(THEME.light.foreground, 0.06),
                        }}>
                        <Text className="font-roobert-medium text-xs" style={{ color: fgColor }}>
                          {(m.email ?? m.user_id).slice(0, 1).toUpperCase()}
                        </Text>
                      </View>
                      <Text
                        className="flex-1 font-roobert text-sm"
                        style={{ color: fgColor }}
                        numberOfLines={1}>
                        {m.email ?? m.user_id}
                        {isViewer ? ' (you)' : ''}
                      </Text>
                      <Ionicons
                        name={on ? 'checkbox' : 'square-outline'}
                        size={20}
                        color={on ? theme.primary : mutedColor}
                      />
                    </Pressable>
                  );
                })
              )}
            </View>
          )}

          {incomplete && (
            <Text
              className="mb-2 font-roobert text-xs"
              style={{ color: isDark ? THEME.dark.destructive : THEME.light.destructive, paddingLeft: 4 }}>
              Pick at least one member, or choose another option.
            </Text>
          )}

          <Pressable
            onPress={handleSave}
            disabled={save.isPending || incomplete}
            style={({ pressed }) => [
              {
                marginTop: 8,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 9999,
                paddingVertical: 14,
                backgroundColor: theme.primary,
                opacity: save.isPending || incomplete ? 0.5 : 1,
              },
              pressed && { opacity: 0.7 },
            ]}>
            {save.isPending ? (
              <ActivityIndicator size="small" color={theme.primaryForeground} />
            ) : (
              <Text
                className="font-roobert-medium text-[15px]"
                style={{ color: theme.primaryForeground }}>
                Done
              </Text>
            )}
          </Pressable>
        </BottomSheetScrollView>
      </BottomSheetModal>
    );
  },
);
