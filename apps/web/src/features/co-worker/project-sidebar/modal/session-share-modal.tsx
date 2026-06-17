'use client';

import {
  SharingPicker,
  intentToSelection,
  isSharingComplete,
  selectionToIntent,
  type SharingSelection,
} from '@/features/co-worker/shared/sharing-picker';
import { Badge } from '@/components/ui/badge';
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
import Hint from '@/components/ui/hint';
import { setProjectSessionSharing, type ProjectSession } from '@/lib/projects-client';
import { LockSolid, UsersSolid } from '@mynaui/icons-react';
import { useMutation } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { useEffect, useState } from 'react';

const SESSION_SHARING_COPY = {
  heading: 'Who can access this session',
  project: { label: 'Whole team', desc: 'Everyone in this project' },
  private: { label: 'Only you', desc: 'Private — just you' },
  members: { label: 'Select members', desc: 'A chosen list of members' },
};

export function sessionVisibilityMeta(session: Pick<ProjectSession, 'visibility'>) {
  switch (session.visibility) {
    case 'project':
      return { icon: Globe, label: 'Team', tone: 'shared' as const };
    case 'restricted':
      return { icon: UsersSolid, label: 'Shared', tone: 'shared' as const };
    default:
      return { icon: LockSolid, label: 'Private', tone: 'private' as const };
  }
}

export function SessionVisibilityBadge({ session }: { session: ProjectSession }) {
  const meta = sessionVisibilityMeta(session);
  const Icon = meta.icon;

  if (session.visibility === 'private' && session.is_owner !== false) return null;
  const sharedBy =
    !session.is_owner && session.owner_email ? `Shared by ${session.owner_email}` : null;
  return (
    <Hint
      side="bottom"
      sideOffset={6}
      className="text-xs"
      label={sharedBy ?? `${meta.label} · who can access this session`}
    >
      <Badge variant="outline" size="sm" className="gap-1">
        <Icon className="h-3 w-3" />
        {meta.label}
      </Badge>
    </Hint>
  );
}


export function SessionShareModal({
  projectId,
  session,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  session: ProjectSession | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const [sharing, setSharing] = useState<SharingSelection>({ mode: 'private', memberIds: [] });

  useEffect(() => {
    if (!open || !session) return;
    setSharing(intentToSelection(session.sharing ?? { mode: 'private', ownerId: '' }));
  }, [open, session]);

  const save = useMutation({
    mutationFn: () => {
      if (!isSharingComplete(sharing)) {
        throw new Error('Pick at least one member, or choose another option.');
      }
      return setProjectSessionSharing(projectId, session!.session_id, selectionToIntent(sharing));
    },
    onSuccess: () => {
      successToast('Session sharing updated');
      onSaved?.();
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
          <ModalTitle>Share session</ModalTitle>
          <ModalDescription>
            Private to you by default. Grant read &amp; continue access to your whole team or
            specific members.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[60vh] overflow-y-auto">
          <SharingPicker
            projectId={projectId}
            value={sharing}
            onChange={setSharing}
            copy={SESSION_SHARING_COPY}
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
            onClick={() => save.mutate()}
            disabled={save.isPending || !isSharingComplete(sharing)}
            className=" w-full sm:w-auto"
          >
            {save.isPending && <Loading />}
            Save
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
