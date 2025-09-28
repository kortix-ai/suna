'use client';

import { MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Button } from '../ui/button';
import { GetAccountMembersResponse } from '@usebasejump/shared';
import { useEffect, useState } from 'react';
import {
  DialogHeader,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import EditTeamMemberRoleForm from './edit-team-member-role-form';
import DeleteTeamMemberForm from './delete-team-member-form';

type Props = {
  accountId: string;
  teamMember: GetAccountMembersResponse[0];
  isPrimaryOwner: boolean;
};

export default function TeamMemberOptions({
  teamMember,
  accountId,
  isPrimaryOwner,
}: Props) {
  const [updateTeamRole, toggleUpdateTeamRole] = useState(false);
  const [removeTeamMember, toggleRemoveTeamMember] = useState(false);

  useEffect(() => {
    if (updateTeamRole) {
      toggleUpdateTeamRole(false);
    }
  }, [teamMember.account_role, updateTeamRole]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-8 w-8 p-0 rounded-full hover:bg-hover-bg dark:hover:bg-hover-bg-dark"
          >
            <MoreHorizontal className="h-4 w-4 text-foreground/70" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-[160px] border-subtle dark:border-white/10 bg-card-bg dark:bg-background-secondary rounded-xl shadow-custom">
          <DropdownMenuItem
            onSelect={() => toggleUpdateTeamRole(true)}
            className="rounded-md hover:bg-hover-bg cursor-pointer text-foreground/90"
          >
            Change role
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => toggleRemoveTeamMember(true)}
            className="rounded-md hover:bg-hover-bg cursor-pointer text-red-500 dark:text-red-400"
          >
            Remove member
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={updateTeamRole} onOpenChange={toggleUpdateTeamRole}>
        <DialogContent className="sm:max-w-[425px] border-subtle dark:border-white/10 bg-card-bg dark:bg-background-secondary rounded-2xl shadow-custom">
          <DialogHeader>
            <DialogTitle className="text-card-title">
              Update team member role
            </DialogTitle>
            <DialogDescription className="text-foreground/70">
              Update a member's role in your team
            </DialogDescription>
          </DialogHeader>
          <EditTeamMemberRoleForm
            teamMember={teamMember}
            accountId={accountId}
            isPrimaryOwner={isPrimaryOwner}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={removeTeamMember} onOpenChange={toggleRemoveTeamMember}>
        <DialogContent className="sm:max-w-[425px] border-subtle dark:border-white/10 bg-card-bg dark:bg-background-secondary rounded-2xl shadow-custom">
          <DialogHeader>
            <DialogTitle className="text-card-title">
              Remove team member
            </DialogTitle>
            <DialogDescription className="text-foreground/70">
              Are you sure you want to remove this user from the team?
            </DialogDescription>
          </DialogHeader>
          <DeleteTeamMemberForm teamMember={teamMember} accountId={accountId} />
        </DialogContent>
      </Dialog>
    </>
  );
}
