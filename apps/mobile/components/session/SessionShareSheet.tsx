/**
 * SessionShareSheet — bottom sheet to set who can open a session.
 * Ported from web's ShareSessionModal + SharingPicker:
 * PUT /projects/:id/sessions/:sid/sharing with
 *   { mode: 'project' } | { mode: 'private', ownerId } | { mode: 'members', memberIds }.
 * Members come from the same project-access list the Members page uses.
 *
 * Layout = the app's picker sheets (design.md §5 Model sheet): title, one
 * group of picker rows (icon · label · check), the member rows under it in
 * members mode, one primary pill. No descriptions.
 */
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { View, useWindowDimensions } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Avatar } from '@/components/kortix/avatar';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';
import { useToast } from '@/components/kortix/toast-provider';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { GlobeIcon, LockIcon, UsersIcon, type AppIcon } from '@/lib/icons';
import { projectKeys, useProjectAccess } from '@/lib/projects/hooks';
import {
  setProjectSessionSharing,
  type ProjectSession,
  type SessionSharing,
} from '@/lib/projects/projects-client';

type ShareMode = 'project' | 'private' | 'members';

// Labels match web's SESSION_SHARING_COPY.
const MODE_OPTIONS: Array<{ mode: ShareMode; icon: AppIcon; label: string }> = [
  { mode: 'private', icon: LockIcon, label: 'Only you' },
  { mode: 'project', icon: GlobeIcon, label: 'Whole project' },
  { mode: 'members', icon: UsersIcon, label: 'Specific people' },
];

interface SessionShareSheetProps {
  projectId: string;
  session: ProjectSession | null;
}

export const SessionShareSheet = forwardRef<BottomSheetModal, SessionShareSheetProps>(
  function SessionShareSheet({ projectId, session }, ref) {
    const { colorScheme } = useColorScheme();
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    const queryClient = useQueryClient();
    const toast = useToast();

    const [mode, setMode] = useState<ShareMode>('private');
    const [memberIds, setMemberIds] = useState<string[]>([]);
    // The members shared with when the sheet opened. They sort first; the
    // order then stays fixed, so a row never moves under the finger on a tap.
    const [seededMemberIds, setSeededMemberIds] = useState<string[]>([]);
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

    const sortedMembers = useMemo(() => {
      const seeded = new Set(seededMemberIds);
      return [...members].sort(
        (a, b) => Number(seeded.has(b.user_id)) - Number(seeded.has(a.user_id)),
      );
    }, [members, seededMemberIds]);

    // Own the sheet ref internally so dismiss works regardless of how the
    // parent's ref is shaped; expose it unchanged to the parent.
    const sheetRef = useRef<BottomSheetModal>(null);
    useImperativeHandle(ref, () => sheetRef.current!, []);

    // Seed mode/members from the session's current sharing on each open.
    const seedFromSession = useCallback(() => {
      sessionIdRef.current = session?.session_id ?? null;
      const sharing = session?.sharing;
      const shared = sharing?.mode === 'members' ? (sharing.memberIds ?? []) : [];
      setMode(sharing?.mode === 'members' || sharing?.mode === 'project' ? sharing.mode : 'private');
      setMemberIds(shared);
      setSeededMemberIds(shared);
      setGroupIds(sharing?.mode === 'members' ? (sharing.groupIds ?? []) : []);
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
        sheetRef.current?.dismiss();
      },
      onError: (err: Error) => {
        haptics.warning();
        toast.error(err.message || 'Could not update session sharing.');
      },
    });

    // Members mode needs at least one member; Save stays disabled until then.
    const incomplete = mode === 'members' && memberIds.length === 0;

    const handleSave = useCallback(() => {
      if (save.isPending || incomplete) return;
      haptics.tap();
      save.mutate();
    }, [save, incomplete]);

    const toggleMember = useCallback((userId: string) => {
      haptics.selection();
      setMemberIds((ids) =>
        ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId],
      );
    }, []);

    return (
      <KortixBottomSheetModal
        title="Share session"
        ref={sheetRef}
        enableDynamicSizing
        maxDynamicContentSize={Math.floor(height * 0.85)}
        enablePanDownToClose
        onChange={(index) => setOpen(index >= 0)}
        // Seed on presentation only (from -1), and re-seed on dismiss so the
        // next open never flashes the previous open's choice for a frame.
        onAnimate={(from, to) => {
          if (from === -1 && to === 0) seedFromSession();
        }}
        onDismiss={seedFromSession}>
        {/* Single scrollable child — required for enableDynamicSizing to size
            correctly with a long member list. */}
        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            // The app's sheet layout (PickerSheet): 20pt sides, 4pt under the
            // handle, 16pt between blocks; titles share one 8pt inset.
            paddingHorizontal: 20,
            paddingTop: 4,
            paddingBottom: Math.max(insets.bottom, 16) + 8,
            gap: 16,
          }}>
          {/* `bg-secondary`: in dark mode `card` equals the sheet's `popover`. */}
          <SettingsGroup className="bg-secondary">
            {MODE_OPTIONS.map((option) => (
              <SettingsRow
                key={option.mode}
                icon={option.icon}
                label={option.label}
                checked={option.mode === mode}
                right={null}
                onPress={() => {
                  haptics.selection();
                  setMode(option.mode);
                }}
              />
            ))}
          </SettingsGroup>

          {mode === 'members' ? (
            <View>
              <Text variant="muted" className="mb-2 px-2">
                People
              </Text>
              {access.isLoading ? (
                <View className="items-center py-6">
                  <KortixLoader size="small" />
                </View>
              ) : sortedMembers.length === 0 ? (
                <View className="items-center py-6">
                  <Text variant="muted">No other members yet</Text>
                </View>
              ) : (
                <SettingsGroup className="bg-secondary">
                  {sortedMembers.map((member) => {
                    const name = member.email ?? member.user_id;
                    return (
                      <SettingsRow
                        key={member.user_id}
                        leading={<Avatar variant="custom" size={28} fallbackText={name} />}
                        label={member.user_id === viewerUserId ? `${name} (you)` : name}
                        checked={memberIds.includes(member.user_id)}
                        right={null}
                        onPress={() => toggleMember(member.user_id)}
                      />
                    );
                  })}
                </SettingsGroup>
              )}
            </View>
          ) : null}

          <Button
            size="lg"
            className="rounded-full"
            disabled={save.isPending || incomplete}
            onPress={handleSave}>
            <Text>{save.isPending ? 'Saving…' : 'Save'}</Text>
          </Button>
        </BottomSheetScrollView>
      </KortixBottomSheetModal>
    );
  },
);
