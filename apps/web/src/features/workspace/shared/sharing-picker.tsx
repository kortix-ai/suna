'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Icon } from '@/features/icon/icon';
import { listGroups } from '@/lib/iam-client';
import { cn } from '@/lib/utils';
import { type ConnectorSharing, listProjectAccess } from '@kortix/sdk/projects-client';
import { CheckCircleSolid } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Search, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  DEFAULT_COPY,
  type SharingCopy,
  type SharingMode,
  type SharingSelection,
} from './sharing-intent';

// Re-exported so existing callers can keep importing selection helpers + types
// from the component module.
export {
  intentToSelection,
  isSharingComplete,
  selectionToIntent,
  type SharingCopy,
  type SharingMode,
  type SharingSelection,
} from './sharing-intent';

export function ShareOption({
  value,
  label,
  desc,
}: {
  value: string;
  label: string;
  desc: string;
  /** @deprecated Selection state comes from the parent `RadioGroup`. */
  current?: string;
}) {
  return (
    <RadioGroupItem
      value={value}
      id={`share-option-${value}`}
      label={label}
      description={desc}
      size="lg"
      variant="outline"
    />
  );
}

export function SharingPicker({
  projectId,
  value,
  onChange,
  copy,
  showHeading = true,
  hideMembers = false,
}: {
  projectId: string;
  value: SharingSelection;
  onChange: (next: SharingSelection) => void;
  copy?: Partial<SharingCopy>;
  showHeading?: boolean;
  /**
   * Pure-pyramid mode (secrets + connectors): drop the direct "specific
   * members/departments" option — targeted access comes ONLY through agent
   * assignment (declare the resource on an agent, assign people to that agent,
   * they inherit it). Keeps one mental model: resources live on agents.
   */
  hideMembers?: boolean;
}) {
  const c: SharingCopy = {
    heading: copy?.heading ?? DEFAULT_COPY.heading,
    project: copy?.project ?? DEFAULT_COPY.project,
    private: copy?.private ?? DEFAULT_COPY.private,
    members: copy?.members ?? DEFAULT_COPY.members,
  };
  // An older secret/connector still stored as a direct member share — surface it
  // (read-only-ish) so it isn't silently broken; the user migrates it to
  // Project-wide/Private or moves the people onto an agent.
  const legacyMembers = hideMembers && value.mode === 'members';

  return (
    <div className="space-y-3">
      {showHeading && <Label>{c.heading}</Label>}
      <RadioGroup
        value={value.mode}
        onValueChange={(v) => onChange({ ...value, mode: v as SharingMode })}
        className="space-y-2"
      >
        <ShareOption value="project" label={c.project.label} desc={c.project.desc} />
        <ShareOption value="private" label={c.private.label} desc={c.private.desc} />
        {!hideMembers && (
          <ShareOption value="members" label={c.members.label} desc={c.members.desc} />
        )}
      </RadioGroup>
      {!hideMembers && value.mode === 'members' && (
        <SubjectPicker
          projectId={projectId}
          memberIds={value.memberIds}
          groupIds={value.groupIds}
          onChange={(memberIds, groupIds) => onChange({ ...value, memberIds, groupIds })}
        />
      )}
      {hideMembers && !legacyMembers && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          To give specific people access, assign them (or a department) to an{' '}
          <span className="text-foreground/80 font-medium">agent</span> that uses this — they
          inherit it automatically. Manage that in the project's Members tab.
        </p>
      )}
      {legacyMembers && (
        <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
          This is still shared with specific members directly (legacy). Switch it to Project-wide or
          Private — targeted access now flows through agent assignment.
        </p>
      )}
    </div>
  );
}

/**
 * Searchable, multi-select allow-list of MEMBERS and DEPARTMENTS — the same
 * member+department subject model the IAM Resource-access dialog uses. Members
 * come from the project's access list; departments (account groups) from
 * listGroups, keyed off the account the project belongs to (derived from the
 * access response, so no extra prop plumbing).
 */
function SubjectPicker({
  projectId,
  memberIds,
  groupIds,
  onChange,
}: {
  projectId: string;
  memberIds: string[];
  groupIds: string[];
  onChange: (memberIds: string[], groupIds: string[]) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [query, setQuery] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    staleTime: 30_000,
  });

  const accountId = data?.account_id;
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId as string),
    enabled: !!accountId,
    staleTime: 60_000,
  });

  const members = data?.members ?? [];
  const groups = groupsQuery.data ?? [];
  const viewerId = data?.viewer_user_id;
  const memberSet = useMemo(() => new Set(memberIds), [memberIds]);
  const groupSet = useMemo(() => new Set(groupIds), [groupIds]);
  const selectedCount = memberIds.length + groupIds.length;

  const q = query.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    const list = q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups;
    return [...list].sort((a, b) => {
      const d = (groupSet.has(a.group_id) ? 0 : 1) - (groupSet.has(b.group_id) ? 0 : 1);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }, [groups, q, groupSet]);
  const filteredMembers = useMemo(() => {
    const list = q
      ? members.filter((m) => (m.email ?? m.user_id).toLowerCase().includes(q))
      : members;
    // Selected first, then alphabetical — chosen people stay visible.
    return [...list].sort((a, b) => {
      const d = (memberSet.has(a.user_id) ? 0 : 1) - (memberSet.has(b.user_id) ? 0 : 1);
      return d !== 0 ? d : (a.email ?? a.user_id).localeCompare(b.email ?? b.user_id);
    });
  }, [members, q, memberSet]);

  const toggleMember = (id: string) =>
    onChange(memberSet.has(id) ? memberIds.filter((x) => x !== id) : [...memberIds, id], groupIds);
  const toggleGroup = (id: string) =>
    onChange(memberIds, groupSet.has(id) ? groupIds.filter((x) => x !== id) : [...groupIds, id]);

  const loading = isLoading || (!!accountId && groupsQuery.isLoading);
  const nothing = members.length === 0 && groups.length === 0;

  return (
    <div className="border-border overflow-hidden rounded-md border">
      <div className="relative overflow-hidden border-b">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tI18nHardcoded.raw(
            'autoFeaturesCoWorkerSharedSharingPickerJsxAttrPlaceholderSearch5747dea4',
          )}
          className="rounded-b-none border-none pl-9"
          variant="transparent"
        />
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute top-1/2 right-3 -translate-y-1/2"
        >
          <Icon.Close className="text-muted-foreground size-3.5" />
        </Button>
      </div>

      {selectedCount > 0 && (
        <div className="border-border flex items-center justify-between border-b px-3 py-1.5">
          <span className="text-muted-foreground text-xs">{selectedCount} selected</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onChange([], [])}
          >
            Clear
          </Button>
        </div>
      )}

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
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            No members or departments in this project yet.
          </p>
        ) : filteredGroups.length === 0 && filteredMembers.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            No matches for your search.
          </p>
        ) : (
          <>
            {filteredGroups.length > 0 && (
              <>
                <p className="text-muted-foreground/70 px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide uppercase">
                  Departments
                </p>
                {filteredGroups.map((g) => {
                  const isSelected = groupSet.has(g.group_id);
                  return (
                    <button
                      key={g.group_id}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => toggleGroup(g.group_id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                        isSelected ? 'bg-secondary' : 'hover:bg-muted/50',
                      )}
                    >
                      <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full">
                        <Users className="size-3.5" />
                      </span>
                      <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                        {g.name}
                        <span className="text-muted-foreground ml-1 text-xs">· dept</span>
                      </span>
                      {isSelected && (
                        <span className="shrink-0 px-1">
                          <CheckCircleSolid className="size-[1.1rem]" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )}

            {filteredMembers.length > 0 && (
              <>
                {filteredGroups.length > 0 && (
                  <p className="text-muted-foreground/70 px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide uppercase">
                    Members
                  </p>
                )}
                {filteredMembers.map((m) => {
                  const isSelected = memberSet.has(m.user_id);
                  const email = m.email ?? m.user_id;
                  return (
                    <button
                      key={m.user_id}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => toggleMember(m.user_id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                        isSelected ? 'bg-secondary' : 'hover:bg-muted/50',
                      )}
                    >
                      <UserAvatar email={email} size="sm" variant="primary" />
                      <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                        {email}
                        {m.user_id === viewerId && (
                          <span className="text-muted-foreground ml-1 text-xs">(you)</span>
                        )}
                      </span>
                      {isSelected && (
                        <span className="shrink-0 px-1">
                          <CheckCircleSolid className="size-[1.1rem]" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
