/**
 * SessionShareForm — the share view of the session options sheet
 * (`ProjectSessionsPage`): the sheet pushes it in place of the options
 * (`sheet-push`), with `SheetBackButton` in the title row to go back.
 *
 * Ported from web's ShareSessionModal + SharingPicker:
 * PUT /projects/:id/sessions/:sid/sharing with
 *   { mode: 'project' } | { mode: 'private', ownerId } | { mode: 'members', memberIds }.
 * Members come from the same project-access list the Members page uses.
 *
 * Layout = the app's picker sheets: one group of picker rows (icon · label ·
 * check), the member rows under it in members mode, one primary pill. No
 * descriptions. It mounts when the view is pushed, so it seeds from the session
 * once and fetches the members only while it shows.
 */
import * as React from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { Avatar } from '@/components/kortix/avatar';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
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

export interface SessionShareFormProps {
  projectId: string;
  session: ProjectSession;
  /** The sharing was saved. */
  onDone: () => void;
}

export function SessionShareForm({ projectId, session, onDone }: SessionShareFormProps) {
  const queryClient = useQueryClient();
  const toast = useToast();

  // Seeded once, from the session this view opened on. The session id is
  // pinned too, so Save still targets it if the list refetches under the sheet.
  const [seed] = React.useState(() => {
    const sharing = session.sharing;
    const members = sharing?.mode === 'members';
    return {
      sessionId: session.session_id,
      mode: (members || sharing?.mode === 'project' ? sharing.mode : 'private') as ShareMode,
      memberIds: members ? (sharing.memberIds ?? []) : [],
      // Group grants have no picker here (web drops them too), but round-trip
      // them so saving member changes never silently revokes group access.
      groupIds: members ? (sharing.groupIds ?? []) : [],
    };
  });
  const [mode, setMode] = React.useState<ShareMode>(seed.mode);
  const [memberIds, setMemberIds] = React.useState<string[]>(seed.memberIds);

  const access = useProjectAccess(projectId);
  const viewerUserId = access.data?.viewer_user_id;
  // The members shared with at open sort first; the order then stays fixed, so
  // a row never moves under the finger on a tap.
  const sortedMembers = React.useMemo(() => {
    const seeded = new Set(seed.memberIds);
    return [...(access.data?.members ?? [])].sort(
      (a, b) => Number(seeded.has(b.user_id)) - Number(seeded.has(a.user_id))
    );
  }, [access.data?.members, seed.memberIds]);

  const save = useMutation({
    mutationFn: () => {
      const intent: SessionSharing =
        mode === 'project'
          ? { mode: 'project' }
          : mode === 'members'
            ? { mode: 'members', memberIds, groupIds: seed.groupIds }
            : { mode: 'private', ownerId: '' }; // ownerId resolved server-side (web parity)
      return setProjectSessionSharing(projectId, seed.sessionId, intent);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) });
      haptics.success();
      onDone();
    },
    onError: () => {
      haptics.warning();
      toast.error('Unable to update sharing. Try again.');
    },
  });

  // Members mode needs at least one member; Save stays disabled until then.
  const incomplete = mode === 'members' && memberIds.length === 0;

  const toggleMember = (userId: string) => {
    haptics.selection();
    setMemberIds((ids) =>
      ids.includes(userId) ? ids.filter((id) => id !== userId) : [...ids, userId]
    );
  };

  return (
    <View className="gap-4 px-4">
      {/* `bg-secondary`: in dark mode `card` equals the sheet's `popover`. */}
      <SettingsGroup>
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
          <Text variant="muted" className="mb-2 px-4">
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
            <SettingsGroup>
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
        onPress={() => {
          if (save.isPending || incomplete) return;
          haptics.tap();
          save.mutate();
        }}>
        <Text>{save.isPending ? 'Saving…' : 'Save'}</Text>
      </Button>
    </View>
  );
}
