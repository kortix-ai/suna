/**
 * SessionRenameForm — the rename view of the session options sheet
 * (`ProjectSessionsPage`): the sheet pushes it in place of the options
 * (`sheet-push`), with `SheetBackButton` in the title row to go back.
 *
 * Ported from web's RenameSessionModal: PATCH /projects/:id/sessions/:sid with
 * { name }. An empty name reverts to the automatic title, which the placeholder
 * shows. The field is `SheetTextInput`, the one text field for sheets.
 *
 * The new name is written into the cached session lists at once (the drawer,
 * the Sessions page, the thread header), then the server's answer, then the
 * refetch. A refused rename puts the old name back.
 */
import * as React from 'react';
import { Keyboard, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { SheetTextInput } from '@/components/kortix/SheetInput';
import { useToast } from '@/components/kortix/toast-provider';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { projectKeys, sessionListKeys } from '@/lib/projects/hooks';
import { updateProjectSession, type ProjectSession } from '@/lib/projects/projects-client';
import {
  applyToSessionCache,
  mergeRenamed,
  renameInRows,
  writeSessionLists,
} from '@/lib/session/session-cache-write';

const MAX_NAME_LENGTH = 120;

export interface SessionRenameFormProps {
  projectId: string;
  session: ProjectSession;
  /** The name was saved, or it did not change. */
  onDone: () => void;
}

export function SessionRenameForm({ projectId, session, onDone }: SessionRenameFormProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const currentName = session.custom_name ?? '';
  const [value, setValue] = React.useState(currentName);

  const rename = useMutation({
    mutationFn: (name: string) => updateProjectSession(projectId, session.session_id, { name }),
    onMutate: async (name) => {
      // A refetch in flight would land the old name over the new one.
      await queryClient.cancelQueries({ queryKey: projectKeys.projectSessions(projectId) });
      const undo = writeSessionLists(queryClient, sessionListKeys(projectId), (cached) =>
        applyToSessionCache<ProjectSession>(cached, (rows) =>
          renameInRows(rows, session.session_id, name)
        )
      );
      return { undo };
    },
    onSuccess: (updated) => {
      // The server's name (normalized, or the automatic title after a clear).
      writeSessionLists(queryClient, sessionListKeys(projectId), (cached) =>
        applyToSessionCache<ProjectSession>(cached, (rows) => mergeRenamed(rows, updated))
      );
      haptics.success();
      onDone();
    },
    onError: (_error, _name, context) => {
      context?.undo();
      haptics.warning();
      toast.error('Unable to rename the session. Try again.');
    },
    // The server stays the source: refetch after either answer. Not awaited:
    // the mutation would stay pending ("Saving…") until the refetch lands.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.projectSessions(projectId) });
    },
  });

  const handleSave = () => {
    if (rename.isPending) return;
    const trimmed = value.trim();
    if (trimmed === currentName) {
      onDone();
      return;
    }
    Keyboard.dismiss();
    rename.mutate(trimmed);
  };

  return (
    <View className="gap-4 px-4">
      <SheetTextInput
        value={value}
        onChangeText={setValue}
        placeholder={session.name || 'Session name'}
        accessibilityLabel="Session name"
        autoFocus
        maxLength={MAX_NAME_LENGTH}
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      <Button size="lg" className="rounded-full" disabled={rename.isPending} onPress={handleSave}>
        <Text>{rename.isPending ? 'Saving…' : 'Save'}</Text>
      </Button>
    </View>
  );
}
