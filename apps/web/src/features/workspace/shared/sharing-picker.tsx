'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { Icon } from '@/features/icon/icon';
import { listProjectAccess, type ConnectorSharing } from '@kortix/sdk/projects-client';
import { cn } from '@/lib/utils';
import { CheckCircleSolid } from '@mynaui/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

export type SharingMode = 'project' | 'private' | 'members';

export interface SharingSelection {
  mode: SharingMode;
  memberIds: string[];
}

interface OptionCopy {
  label: string;
  desc: string;
}

export interface SharingCopy {
  heading: string;
  project: OptionCopy;
  private: OptionCopy;
  members: OptionCopy;
}

const DEFAULT_COPY: SharingCopy = {
  heading: 'Who can access this',
  project: { label: 'Project-wide', desc: 'Every member of this project' },
  private: { label: 'Only me', desc: 'Just you' },
  members: { label: 'Select members', desc: 'A chosen list of members' },
};

export function isSharingComplete(s: SharingSelection): boolean {
  return s.mode !== 'members' || s.memberIds.length > 0;
}

export function selectionToIntent(s: SharingSelection): ConnectorSharing {
  if (s.mode === 'project') return { mode: 'project' };
  if (s.mode === 'private') return { mode: 'private', ownerId: '' };
  return { mode: 'members', memberIds: s.memberIds };
}

export function intentToSelection(intent: ConnectorSharing | null | undefined): SharingSelection {
  if (!intent || intent.mode === 'project') return { mode: 'project', memberIds: [] };
  if (intent.mode === 'private') return { mode: 'private', memberIds: [] };
  return { mode: 'members', memberIds: intent.memberIds ?? [] };
}

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
}: {
  projectId: string;
  value: SharingSelection;
  onChange: (next: SharingSelection) => void;
  copy?: Partial<SharingCopy>;
  showHeading?: boolean;
}) {
  const c: SharingCopy = {
    heading: copy?.heading ?? DEFAULT_COPY.heading,
    project: copy?.project ?? DEFAULT_COPY.project,
    private: copy?.private ?? DEFAULT_COPY.private,
    members: copy?.members ?? DEFAULT_COPY.members,
  };

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
        <ShareOption value="members" label={c.members.label} desc={c.members.desc} />
      </RadioGroup>
      {value.mode === 'members' && (
        <MemberPicker
          projectId={projectId}
          selected={value.memberIds}
          onChange={(memberIds) => onChange({ ...value, memberIds })}
        />
      )}
    </div>
  );
}

/** Searchable, multi-select member list — round avatars, tinted selection. */
function MemberPicker({
  projectId,
  selected,
  onChange,
}: {
  projectId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [query, setQuery] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    staleTime: 30_000,
  });

  const members = data?.members ?? [];
  const viewerId = data?.viewer_user_id;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? members.filter((m) => (m.email ?? m.user_id).toLowerCase().includes(q))
      : members;
    // Selected first, then alphabetical — chosen people stay visible.
    return [...list].sort((a, b) => {
      const d = (selectedSet.has(a.user_id) ? 0 : 1) - (selectedSet.has(b.user_id) ? 0 : 1);
      return d !== 0 ? d : (a.email ?? a.user_id).localeCompare(b.email ?? b.user_id);
    });
  }, [members, query, selectedSet]);

  const toggle = (id: string) =>
    onChange(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

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
          className="rounded-b-none pl-9"
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

      {selected.length > 0 && (
        <div className="border-border/60 flex items-center justify-between border-b px-3 py-1.5">
          <span className="text-muted-foreground text-xs">{selected.length} selected</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        </div>
      )}

      <div className="max-h-56 overflow-y-auto p-1">
        {isLoading ? (
          <div className="space-y-1 p-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-2.5 px-2 py-1.5">
                <Skeleton className="size-6 rounded-full" />
                <Skeleton className="h-3.5 w-40" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {members.length === 0
              ? 'No members in this project yet.'
              : 'No members match your search.'}
          </p>
        ) : (
          filtered.map((m) => {
            const isSelected = selectedSet.has(m.user_id);
            const email = m.email ?? m.user_id;
            return (
              <button
                key={m.user_id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggle(m.user_id)}
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
          })
        )}
      </div>
    </div>
  );
}
