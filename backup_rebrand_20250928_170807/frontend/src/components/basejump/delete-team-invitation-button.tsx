'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useState } from 'react';
import { Trash } from 'lucide-react';
import { SubmitButton } from '../ui/submit-button';
import { deleteInvitation } from '@/lib/actions/invitations';
import { usePathname } from 'next/navigation';

type Props = {
  invitationId: string;
};

export default function DeleteTeamInvitationButton({ invitationId }: Props) {
  const [open, setOpen] = useState(false);
  const returnPath = usePathname();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="h-8 w-8 p-0 rounded-full hover:bg-hover-bg dark:hover:bg-hover-bg-dark"
        >
          <Trash className="text-red-500 dark:text-red-400 w-4 h-4" />
          <span className="sr-only">Delete invitation</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px] border-subtle dark:border-white/10 bg-card-bg dark:bg-background-secondary rounded-2xl shadow-custom">
        <DialogHeader>
          <DialogTitle className="text-card-title">
            Delete Invitation
          </DialogTitle>
          <DialogDescription className="text-foreground/70">
            Are you sure you want to delete this invitation? This cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 justify-end mt-4">
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            className="rounded-lg h-9 border-subtle dark:border-white/10 hover:bg-hover-bg dark:hover:bg-hover-bg-dark"
          >
            Cancel
          </Button>
          <form>
            <input type="hidden" name="invitationId" value={invitationId} />
            <input type="hidden" name="returnPath" value={returnPath} />
            <SubmitButton
              variant="destructive"
              formAction={deleteInvitation}
              pendingText="Deleting..."
              className="rounded-lg h-9 bg-red-500 hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700"
            >
              Delete
            </SubmitButton>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
