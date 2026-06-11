/**
 * SessionShareSheet — bottom sheet to set who can see/open a session.
 * Ported from web's SessionShareDialog + SharingPicker:
 * PUT /projects/:id/sessions/:sid/sharing with
 *   { mode: 'project' } | { mode: 'private', ownerId } | { mode: 'members', memberIds }.
 * Members come from the same project-access list the Members page uses.
 */
import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getSheetBg, useThemeColors } from '@/lib/theme-colors';
import { haptics } from '@/lib/haptics';
import {
  setProjectSessionSharing,
  type ProjectSession,
  type SessionSharing,
} from '@/lib/projects/projects-client';
import { projectKeys, useProjectAccess } from '@/lib/projects/hooks';

type ShareMode = 'project' | 'private' | 'members';

const MODE_OPTIONS: Array<{
  mode: ShareMode;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  description: string;
}> = [
  { mode: 'private', icon: 'lock-closed-outline', label: 'Only you', description: 'Private to you' },
  { mode: 'project', icon: 'globe-outline', label: 'Whole team', description: 'Everyone in this project' },
  { mode: 'members', icon: 'people-outline', label: 'Select members', description: 'Only the members you pick' },
];

interface SessionShareSheetProps {
  projectId: string;
  session: ProjectSession | null;
}

export const SessionShareSheet = forwardRef<BottomSheetModal, SessionShareSheetProps>(
  function SessionShareSheet({ projectId, session }, ref) {
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

    const access = useProjectAccess(open ? projectId : null);
    const members = access.data?.members ?? [];
    const viewerUserId = access.data?.viewer_user_id;

    const fgColor = isDark ? '#F8F8F8' : '#121215';
    const mutedColor = isDark ? 'rgba(248, 248, 248, 0.4)' : 'rgba(18, 18, 21, 0.4)';
    const border = isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.08)';
    const sheetPadding = insets.bottom + 16;

    // Selected members first, like the web picker.
    const sortedMembers = useMemo(() => {
      const sel = new Set(memberIds);
      return [...members].sort((a, b) => Number(sel.has(b.user_id)) - Number(sel.has(a.user_id)));
    }, [members, memberIds]);

    // Own the sheet ref internally so dismiss works regardless of how the
    // parent's ref is shaped; expose it unchanged to the parent.
    const sheetRef = useRef<BottomSheetModal>(null);
    useImperativeHandle(ref, () => sheetRef.current!, []);

    const dismiss = useCallback(() => {
      sheetRef.current?.dismiss();
    }, []);

    // Seed mode/members from the session's current sharing on each open.
    const seedFromSession = useCallback(() => {
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
        const intent: SessionSharing =
          mode === 'project'
            ? { mode: 'project' }
            : mode === 'members'
              ? { mode: 'members', memberIds, groupIds }
              : { mode: 'private', ownerId: '' }; // ownerId resolved server-side (web parity)
        return setProjectSessionSharing(projectId, session!.session_id, intent);
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

    const toggleMember = useCallback((userId: string) => {
      haptics.selection();
      setMemberIds((ids) =>
        ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId],
      );
    }, []);

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
        onChange={(index) => setOpen(index >= 0)}
        // Seed on presentation only (from -1), and re-seed on dismiss so the
        // next open never flashes the previous open's state for a frame.
        onAnimate={(from, to) => { if (from === -1 && to === 0) seedFromSession(); }}
        onDismiss={seedFromSession}
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
        {/* Root scrollable (library-integrated): with enableDynamicSizing the
            sheet sizes to content and caps at the container height, keeping
            Save reachable on small screens — and a single scrollable means no
            gesture fight between the sheet pan and an inner list. */}
        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}
        >
          {/* Header */}
          <View className="flex-row items-center mb-5">
            <View
              className="w-10 h-10 rounded-xl items-center justify-center mr-3"
              style={{
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.05)',
              }}
            >
              <Ionicons name="share-outline" size={20} color={fgColor} />
            </View>
            <View className="flex-1">
              <Text className="text-lg font-roobert-semibold" style={{ color: fgColor }}>
                Share session
              </Text>
              <Text className="text-xs font-roobert mt-0.5" style={{ color: mutedColor }} numberOfLines={2}>
                Sessions are private to you by default. Share read/continue access with your team.
              </Text>
            </View>
          </View>

          {/* Mode options */}
          {MODE_OPTIONS.map((opt) => {
            const on = mode === opt.mode;
            return (
              <TouchableOpacity
                key={opt.mode}
                onPress={() => { haptics.selection(); setMode(opt.mode); }}
                activeOpacity={0.7}
                className="flex-row items-center rounded-2xl px-4 py-3 mb-2"
                style={{
                  borderWidth: 1,
                  borderColor: on ? theme.primary : border,
                  backgroundColor: on
                    ? (isDark ? 'rgba(248, 248, 248, 0.06)' : 'rgba(18, 18, 21, 0.03)')
                    : 'transparent',
                }}
              >
                <Ionicons name={opt.icon} size={19} color={on ? theme.primary : mutedColor} />
                <View className="flex-1 ml-3">
                  <Text className="text-[15px] font-roobert-medium" style={{ color: fgColor }}>
                    {opt.label}
                  </Text>
                  <Text className="text-xs font-roobert mt-0.5" style={{ color: mutedColor }}>
                    {opt.description}
                  </Text>
                </View>
                {on && <Ionicons name="checkmark" size={18} color={theme.primary} />}
              </TouchableOpacity>
            );
          })}

          {/* Member picker (members mode) */}
          {mode === 'members' && (
            <View
              className="rounded-2xl mb-2"
              style={{ borderWidth: 1, borderColor: border, overflow: 'hidden' }}
            >
              {access.isLoading ? (
                <View style={{ paddingVertical: 28, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={mutedColor} />
                </View>
              ) : members.length === 0 ? (
                <Text className="text-sm font-roobert text-center" style={{ color: mutedColor, paddingVertical: 24 }}>
                  No other members in this project yet.
                </Text>
              ) : (
                <>
                  {sortedMembers.map((m) => {
                    const on = memberIds.includes(m.user_id);
                    const isViewer = m.user_id === viewerUserId;
                    return (
                      <TouchableOpacity
                        key={m.user_id}
                        onPress={() => toggleMember(m.user_id)}
                        activeOpacity={0.7}
                        className="flex-row items-center px-4 py-3"
                        style={{ borderBottomWidth: 1, borderBottomColor: border }}
                      >
                        <View
                          className="w-8 h-8 rounded-full items-center justify-center mr-3"
                          style={{
                            backgroundColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.06)',
                          }}
                        >
                          <Text className="text-xs font-roobert-medium" style={{ color: fgColor }}>
                            {(m.email ?? m.user_id).slice(0, 1).toUpperCase()}
                          </Text>
                        </View>
                        <Text className="flex-1 text-sm font-roobert" style={{ color: fgColor }} numberOfLines={1}>
                          {m.email ?? m.user_id}{isViewer ? ' (you)' : ''}
                        </Text>
                        <Ionicons
                          name={on ? 'checkbox' : 'square-outline'}
                          size={20}
                          color={on ? theme.primary : mutedColor}
                        />
                      </TouchableOpacity>
                    );
                  })}
                </>
              )}
            </View>
          )}

          {incomplete && (
            <Text className="text-xs font-roobert mb-2" style={{ color: '#ef4444', paddingLeft: 4 }}>
              Pick at least one member, or choose another option.
            </Text>
          )}

          {/* Save */}
          <TouchableOpacity
            onPress={() => { if (!save.isPending && !incomplete && session) save.mutate(); }}
            disabled={save.isPending || incomplete}
            activeOpacity={0.7}
            className="rounded-full items-center justify-center mt-2"
            style={{
              paddingVertical: 14,
              backgroundColor: isDark ? '#F8F8F8' : '#121215',
              opacity: save.isPending || incomplete ? 0.5 : 1,
            }}
          >
            {save.isPending ? (
              <ActivityIndicator size="small" color={isDark ? '#121215' : '#F8F8F8'} />
            ) : (
              <Text className="text-[15px] font-roobert-medium" style={{ color: isDark ? '#121215' : '#F8F8F8' }}>
                Save
              </Text>
            )}
          </TouchableOpacity>
        </BottomSheetScrollView>
      </BottomSheetModal>
    );
  },
);
