'use client';

/** One account-member row: avatar, joined time, role menu, remove. Presentation
 *  only — the shared mutations and their cross-row pending state stay in
 *  MembersSection. */

import Loading from '@/components/ui/loading';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { relativeTime } from '@/lib/utils';
import type { AccountMember } from '@kortix/sdk';
import { MoreHorizontal, UserMinus } from 'lucide-react';

const ROLES = ['owner', 'admin', 'member'] as const;
export type AccountMemberRole = (typeof ROLES)[number];

export function MemberRow({
  member,
  index,
  busy,
  onChangeRole,
  onRemove,
}: {
  member: AccountMember;
  index: number;
  busy: boolean;
  onChangeRole: (vars: { userId: string; role: AccountMemberRole }) => void;
  onRemove: (userId: string) => void;
}) {
  const label = member.email ?? member.user_id ?? 'Member';
  const initial = label.charAt(0).toUpperCase();
  const memberRole = member.account_role;
  const userId = member.user_id;

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Avatar size="sm">
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="truncate text-xs text-muted-foreground">
          {member.joined_at ? `Joined ${relativeTime(member.joined_at)}` : (userId ?? '')}
        </div>
      </div>
      <Badge variant="outline" className="capitalize">
        {memberRole}
      </Badge>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={!userId || busy}
            aria-label={`Manage ${label}`}
          >
            {busy ? <Loading className="size-4" /> : <MoreHorizontal className="size-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel>Change role</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={memberRole}
            onValueChange={(v) => {
              if (userId && v !== memberRole)
                onChangeRole({ userId, role: v as AccountMemberRole });
            }}
          >
            {ROLES.map((r) => (
              <DropdownMenuRadioItem key={r} value={r} className="capitalize">
                {r}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => userId && onRemove(userId)}
          >
            <UserMinus className="size-4" /> Remove from account
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
