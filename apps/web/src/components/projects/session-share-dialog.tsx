'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Globe, Loader2, Lock, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { setProjectSessionSharing, type ProjectSession } from '@/lib/projects-client';
import {
  SharingPicker,
  intentToSelection,
  isSharingComplete,
  selectionToIntent,
  type SharingSelection,
} from '@/components/projects/sharing-picker';

const SESSION_SHARING_COPY = {
  heading: 'Who can access this session',
  project: { label: 'Whole team', desc: 'Everyone in this project' },
  private: { label: 'Only you', desc: 'Private — just you' },
  members: { label: 'Select members', desc: 'A chosen list of members' },
};

/** What a session's current visibility means, in one word + icon. */
export function sessionVisibilityMeta(session: Pick<ProjectSession, 'visibility'>) {
  switch (session.visibility) {
    case 'project':
      return { icon: Globe, label: 'Team', tone: 'shared' as const };
    case 'restricted':
      return { icon: Users, label: 'Shared', tone: 'shared' as const };
    default:
      return { icon: Lock, label: 'Private', tone: 'private' as const };
  }
}

/**
 * Tiny header/list affordance: shows how a session is shared within the org,
 * and "shared by X" when someone else owns it. Minimal by design.
 */
export function SessionVisibilityBadge({ session }: { session: ProjectSession }) {
  const meta = sessionVisibilityMeta(session);
  const Icon = meta.icon;
  // Private + mine = the default; no badge needed.
  if (session.visibility === 'private' && session.is_owner !== false) return null;
  const sharedBy = !session.is_owner && session.owner_email ? `Shared by ${session.owner_email}` : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" size="sm" className="gap-1">
          <Icon className="h-3 w-3" />
          {meta.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {sharedBy ?? `${meta.label} · who can access this session`}
      </TooltipContent>
    </Tooltip>
  );
}

/** Share dialog: pick session visibility (private | team | members). */
export function SessionShareDialog({
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
      toast.success('Session sharing updated');
      onSaved?.();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update sharing'),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!save.isPending) onOpenChange(o); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share session</DialogTitle>
          <DialogDescription>
            Sessions are private to you by default. Share read/continue access with your team or specific members.
          </DialogDescription>
        </DialogHeader>
        <div className="py-1">
          <SharingPicker projectId={projectId} value={sharing} onChange={setSharing} copy={SESSION_SHARING_COPY} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !isSharingComplete(sharing)}
            className="gap-1.5"
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
