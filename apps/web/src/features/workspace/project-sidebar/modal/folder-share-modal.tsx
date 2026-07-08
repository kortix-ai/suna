'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  SharingPicker,
  type SharingSelection,
  intentToSelection,
  isSharingComplete,
  selectionToIntent,
} from '@/features/workspace/shared/sharing-picker';
import { type SessionFolder, updateSessionFolder } from '@kortix/sdk/projects-client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

const FOLDER_SHARING_COPY = {
  heading: 'Who can access this folder',
  project: { label: 'Whole team', desc: 'Everyone in this project' },
  private: { label: 'Only you', desc: 'Private — just you' },
  members: { label: 'Specific members or groups', desc: 'A chosen list of members and groups' },
};

/**
 * Folder sharing uses the common team-share picker — the SAME control as
 * session/secret sharing. Sharing a folder shares every session inside it by
 * inheritance (including ones added later); a session in a shared folder
 * becomes visible to that same audience whatever its own sharing says.
 */
export function FolderShareModal({
  projectId,
  folder,
  open,
  onOpenChange,
}: {
  projectId: string;
  folder: SessionFolder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [sharing, setSharing] = useState<SharingSelection>({
    mode: 'private',
    memberIds: [],
    groupIds: [],
  });

  useEffect(() => {
    if (!open || !folder) return;
    setSharing(intentToSelection(folder.sharing ?? { mode: 'private', ownerId: '' }));
  }, [open, folder]);

  const save = useMutation({
    mutationFn: () => {
      if (!folder) throw new Error('No folder selected');
      if (!isSharingComplete(sharing)) {
        throw new Error('Pick at least one member, or choose another option.');
      }
      return updateSessionFolder(projectId, folder.folder_id, {
        sharing: selectionToIntent(sharing),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session-folders', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
      successToast('Folder sharing updated');
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update sharing'),
  });

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!save.isPending) onOpenChange(o);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>Share folder</ModalTitle>
          <ModalDescription>
            Sharing a folder shares every session inside it — including ones added later.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[60vh] overflow-y-auto">
          <SharingPicker
            projectId={projectId}
            value={sharing}
            onChange={setSharing}
            copy={FOLDER_SHARING_COPY}
          />
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            variant="outline-ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => save.mutate()}
            disabled={save.isPending || !isSharingComplete(sharing)}
          >
            {save.isPending && <Loading />}
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
