'use client';

// PrincipalPicker — THE "who is this for?" control.
//
// Evolved from `features/workspace/shared/sharing-picker.tsx`'s
// `SubjectPicker` (project + account modes, `allowInvite`, `kinds`,
// `excludeUserIds`) with the one capability that forced a second component
// to exist: `selection: 'single'`, i.e. radio semantics plus the collapsed
// "selected + Change" row ported from `AccountPrincipalPicker`
// (`components/iam/access-agents-tab.tsx:762-918`).
//
// It replaces `AccountPrincipalPicker`, `EntityListPicker`
// (`policy-assignments.tsx`), the email-chip composer in
// `InviteMemberModal`, the plain member `Select` in the Audit person
// filter, and the plain group `Select`s in `AddMappingDialog` /
// `BulkAddToGroupDialog`.

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useAuth } from '@/features/providers/auth-provider';
import { cn } from '@/lib/utils';
import { listAccountMembers, listGroups, listProjectAccess } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import {
  CheckCircleIcon,
  MagnifyingGlassIcon,
  UserPlusIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { principalLabel } from './access-shared';

export type PrincipalKind = 'member' | 'group';

export type PrincipalPickerScope =
  | { kind: 'account'; accountId: string }
  | { kind: 'project'; projectId: string };

/** Everything the picker can have selected, in one value. */
export interface PrincipalSelection {
  memberIds: string[];
  groupIds: string[];
  /** Not-yet-member emails chosen for invite. Only fills when `allowInvite`. */
  inviteEmails: string[];
}

export const EMPTY_PRINCIPAL_SELECTION: PrincipalSelection = {
  memberIds: [],
  groupIds: [],
  inviteEmails: [],
};

export function principalSelectionCount(value: PrincipalSelection): number {
  return value.memberIds.length + value.groupIds.length + value.inviteEmails.length;
}

export function isPrincipalSelectionEmpty(value: PrincipalSelection): boolean {
  return principalSelectionCount(value) === 0;
}

export const INVITE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isInviteEmail(value: string): boolean {
  return INVITE_EMAIL_RE.test(value.trim().toLowerCase());
}

export type PrincipalTarget =
  | { kind: 'member'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'invite'; id: string };

/**
 * The whole selection model, as one pure reducer.
 *
 * `multi` toggles the target inside its own bucket and leaves the others
 * alone. `single` is radio semantics: picking anything clears every other
 * bucket, and re-picking the same target is a no-op rather than a
 * deselect (a required field can't be emptied by a stray second click).
 */
export function togglePrincipal(
  value: PrincipalSelection,
  target: PrincipalTarget,
  selection: 'single' | 'multi' = 'multi',
): PrincipalSelection {
  if (selection === 'single') {
    return {
      memberIds: target.kind === 'member' ? [target.id] : [],
      groupIds: target.kind === 'group' ? [target.id] : [],
      inviteEmails: target.kind === 'invite' ? [target.id] : [],
    };
  }
  const bucket: keyof PrincipalSelection =
    target.kind === 'member' ? 'memberIds' : target.kind === 'group' ? 'groupIds' : 'inviteEmails';
  const current = value[bucket];
  return {
    ...value,
    [bucket]: current.includes(target.id)
      ? current.filter((x) => x !== target.id)
      : [...current, target.id],
  };
}

/** The single selected target, or null. Only meaningful in single mode. */
export function singlePrincipal(value: PrincipalSelection): PrincipalTarget | null {
  if (value.memberIds.length > 0) return { kind: 'member', id: value.memberIds[0]! };
  if (value.groupIds.length > 0) return { kind: 'group', id: value.groupIds[0]! };
  if (value.inviteEmails.length > 0) return { kind: 'invite', id: value.inviteEmails[0]! };
  return null;
}

export interface PrincipalPickerProps {
  scope: PrincipalPickerScope;
  /** Radio semantics + collapsed selected row, or a multi-select checklist. */
  selection?: 'single' | 'multi';
  /** Which kinds are listed. Defaults to members + groups. */
  kinds?: PrincipalKind[];
  /** Surfaces an "Invite {email}" row for a typed, non-matching address. */
  allowInvite?: boolean;
  /** User ids hidden on top of normal filtering (e.g. existing group members). */
  excludeUserIds?: string[] | Set<string>;
  value: PrincipalSelection;
  onChange: (next: PrincipalSelection) => void;
  /** Copy for "the roster itself is empty". */
  emptyLabel?: string;
  /** Copy for "the roster has people, but every one is excluded". */
  allExcludedLabel?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  searchPlaceholder?: string;
  className?: string;
}

interface RosterMember {
  user_id: string;
  email: string | null;
}

export function PrincipalPicker({
  scope,
  selection = 'multi',
  kinds = ['member', 'group'],
  allowInvite = false,
  excludeUserIds,
  value,
  onChange,
  emptyLabel = 'No members or groups here yet.',
  allExcludedLabel = 'Everyone is already added.',
  autoFocus = true,
  disabled = false,
  searchPlaceholder,
  className,
}: PrincipalPickerProps) {
  const [query, setQuery] = useState('');
  // Single mode collapses to a "selected + Change" row once something is
  // chosen; `editing` re-opens the list without clearing the value.
  const [editing, setEditing] = useState(false);
  const { user: authUser } = useAuth();

  const showMembers = kinds.includes('member');
  const showGroups = kinds.includes('group');
  const projectId = scope.kind === 'project' ? scope.projectId : undefined;

  const projectAccessQuery = useQuery({
    queryKey: projectId ? qk.project.access(projectId) : ['principal-picker-no-project'],
    queryFn: () => listProjectAccess(projectId as string),
    enabled: !!projectId,
    ...contract('inventory'),
  });

  const accountMembersQuery = useQuery({
    queryKey: ['account-members', scope.kind === 'account' ? scope.accountId : null],
    queryFn: () => listAccountMembers((scope as { accountId: string }).accountId),
    enabled: scope.kind === 'account' && showMembers,
    staleTime: 30_000,
  });

  // Groups are always account-scoped. In project mode the account is not a
  // prop — it comes back on the project-access response.
  const derivedAccountId =
    scope.kind === 'account' ? scope.accountId : projectAccessQuery.data?.account_id;
  const groupsQuery = useQuery({
    queryKey: ['account-groups', derivedAccountId],
    queryFn: () => listGroups(derivedAccountId as string),
    enabled: showGroups && !!derivedAccountId,
    staleTime: 60_000,
  });

  const rosterMembers: RosterMember[] = useMemo(
    () =>
      projectId ? (projectAccessQuery.data?.members ?? []) : (accountMembersQuery.data ?? []),
    [projectId, projectAccessQuery.data, accountMembersQuery.data],
  );
  const excludeSet = useMemo(
    () => (excludeUserIds ? new Set(excludeUserIds) : null),
    [excludeUserIds],
  );
  const members = useMemo(
    () => (excludeSet ? rosterMembers.filter((m) => !excludeSet.has(m.user_id)) : rosterMembers),
    [rosterMembers, excludeSet],
  );
  const groups = useMemo(
    () => (showGroups ? (groupsQuery.data ?? []) : []),
    [showGroups, groupsQuery.data],
  );
  const viewerId = projectId ? projectAccessQuery.data?.viewer_user_id : authUser?.id;

  const memberSet = useMemo(() => new Set(value.memberIds), [value.memberIds]);
  const groupSet = useMemo(() => new Set(value.groupIds), [value.groupIds]);
  const inviteSet = useMemo(() => new Set(value.inviteEmails), [value.inviteEmails]);
  const selectedCount = principalSelectionCount(value);

  const q = query.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    const list = q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups;
    // Selected first, then alphabetical — chosen entries stay visible.
    return [...list].sort((a, b) => {
      const d = (groupSet.has(a.group_id) ? 0 : 1) - (groupSet.has(b.group_id) ? 0 : 1);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }, [groups, q, groupSet]);

  const filteredMembers = useMemo(() => {
    const list = showMembers
      ? q
        ? members.filter((m) => principalLabel(m).toLowerCase().includes(q))
        : members
      : [];
    return [...list].sort((a, b) => {
      const d = (memberSet.has(a.user_id) ? 0 : 1) - (memberSet.has(b.user_id) ? 0 : 1);
      return d !== 0 ? d : principalLabel(a).localeCompare(principalLabel(b));
    });
  }, [members, q, memberSet, showMembers]);

  const inviteCandidate = useMemo(() => {
    if (!allowInvite || !INVITE_EMAIL_RE.test(q)) return null;
    const alreadyAMember = rosterMembers.some((m) => (m.email ?? '').toLowerCase() === q);
    return alreadyAMember ? null : q;
  }, [allowInvite, q, rosterMembers]);

  const rosterLoading = projectId ? projectAccessQuery.isLoading : accountMembersQuery.isLoading;
  const loading =
    (showMembers && rosterLoading) || (showGroups && !!derivedAccountId && groupsQuery.isLoading);

  function pick(target: PrincipalTarget) {
    onChange(togglePrincipal(value, target, selection));
    if (selection === 'single') {
      setQuery('');
      setEditing(false);
    }
  }

  // ── Single mode: collapsed "selected + Change" row ────────────────────
  const selected = selection === 'single' ? singlePrincipal(value) : null;
  if (selection === 'single' && selected && !editing) {
    const label =
      selected.kind === 'group'
        ? (groups.find((g) => g.group_id === selected.id)?.name ?? selected.id)
        : selected.kind === 'member'
          ? principalLabel(rosterMembers.find((m) => m.user_id === selected.id)) || selected.id
          : selected.id;
    return (
      <div className={cn('bg-popover flex items-center gap-2.5 rounded-md border px-3 py-2', className)}>
        {selected.kind === 'group' ? (
          <EntityAvatar icon={UsersIcon} label={label} size="sm" />
        ) : (
          <UserAvatar email={label} size="sm" />
        )}
        <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        <Badge variant="outline" size="sm">
          {selected.kind === 'group' ? 'Group' : selected.kind === 'invite' ? 'Invite' : 'Member'}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          Change
        </Button>
      </div>
    );
  }

  // Two distinct empty states: nobody is eligible at all (fresh
  // project/account) vs. the roster has people but every one was filtered
  // out by `excludeUserIds`. They read differently to the person here.
  const nothing = rosterMembers.length === 0 && groups.length === 0 && !inviteCandidate;
  const allExcluded = !nothing && members.length === 0 && groups.length === 0 && !inviteCandidate;

  const placeholder =
    searchPlaceholder ??
    (showMembers && showGroups
      ? 'Search members or groups'
      : showGroups
        ? 'Search groups'
        : allowInvite
          ? 'Search or type an email'
          : 'Search members');

  return (
    <div className={cn('border-border overflow-hidden rounded-md border', className)}>
      <InputGroupSearch className="border-b">
        <InputGroupSearchIcon>
          <MagnifyingGlassIcon />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          variant="popover"
          disabled={disabled}
          // Every caller opens this as the first interactive element of a
          // fresh dialog — typing starts the instant it is open.
          autoFocus={autoFocus}
        />
        {query ? <InputGroupSearchClear onClick={() => setQuery('')} /> : null}
      </InputGroupSearch>

      {selection === 'multi' && selectedCount > 0 ? (
        <div className="border-border flex items-center justify-between border-b px-3 py-1.5">
          <span className="text-muted-foreground text-xs">{selectedCount} selected</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={disabled}
            onClick={() => onChange(EMPTY_PRINCIPAL_SELECTION)}
          >
            Clear
          </Button>
        </div>
      ) : null}

      <div className="max-h-56 overflow-y-auto p-1">
        {loading ? (
          <div className="space-y-1 p-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
                <Skeleton className="size-6 rounded-full" />
                <Skeleton className="h-3.5 w-40" />
              </div>
            ))}
          </div>
        ) : nothing ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">{emptyLabel}</p>
        ) : allExcluded ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">{allExcludedLabel}</p>
        ) : filteredGroups.length === 0 && filteredMembers.length === 0 && !inviteCandidate ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            No matches for your search.
          </p>
        ) : (
          <>
            {inviteCandidate ? (
              <PickerRow
                selected={inviteSet.has(inviteCandidate)}
                selection={selection}
                disabled={disabled}
                onSelect={() => pick({ kind: 'invite', id: inviteCandidate })}
                leading={
                  <span className="border-muted-foreground/40 text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed">
                    <UserPlusIcon className="size-3.5" />
                  </span>
                }
                label={`Invite ${inviteCandidate}`}
                suffix="· not a member yet"
              />
            ) : null}

            {filteredGroups.length > 0 ? (
              <>
                <PickerSectionLabel>Groups</PickerSectionLabel>
                {filteredGroups.map((group) => (
                  <PickerRow
                    key={group.group_id}
                    selected={groupSet.has(group.group_id)}
                    selection={selection}
                    disabled={disabled}
                    onSelect={() => pick({ kind: 'group', id: group.group_id })}
                    leading={<EntityAvatar icon={UsersIcon} label={group.name} size="sm" />}
                    label={group.name}
                    suffix="· group"
                  />
                ))}
              </>
            ) : null}

            {filteredMembers.length > 0 ? (
              <>
                {filteredGroups.length > 0 ? <PickerSectionLabel>Members</PickerSectionLabel> : null}
                {filteredMembers.map((member) => {
                  const label = principalLabel(member) || member.user_id;
                  return (
                    <PickerRow
                      key={member.user_id}
                      selected={memberSet.has(member.user_id)}
                      selection={selection}
                      disabled={disabled}
                      onSelect={() => pick({ kind: 'member', id: member.user_id })}
                      leading={<UserAvatar email={label} size="sm" variant="primary" />}
                      label={label}
                      suffix={member.user_id === viewerId ? '(you)' : undefined}
                    />
                  );
                })}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function PickerSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground/70 px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide uppercase first:pt-1.5">
      {children}
    </p>
  );
}

function PickerRow({
  selected,
  selection,
  disabled,
  onSelect,
  leading,
  label,
  suffix,
}: {
  selected: boolean;
  selection: 'single' | 'multi';
  disabled?: boolean;
  onSelect: () => void;
  leading: React.ReactNode;
  label: string;
  suffix?: string;
}) {
  return (
    <button
      type="button"
      role={selection === 'single' ? 'radio' : undefined}
      aria-checked={selection === 'single' ? selected : undefined}
      aria-pressed={selection === 'multi' ? selected : undefined}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        selected ? 'bg-primary/[0.06]' : 'hover:bg-muted/50',
      )}
    >
      {leading}
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">
        {label}
        {suffix ? <span className="text-muted-foreground ml-1 text-xs">{suffix}</span> : null}
      </span>
      {selected ? (
        <span className="shrink-0 px-1">
          <CheckCircleIcon weight="fill" className="size-[1.1rem]" />
        </span>
      ) : null}
    </button>
  );
}
