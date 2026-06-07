'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Globe, Lock, Search, Users, type LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { cn } from '@/lib/utils';
import { listProjectAccess, type ConnectorSharing } from '@/lib/projects-client';

/**
 * THE one "who can access this" control — shared by project secrets, Executor
 * connectors, and sessions. Three options map onto the backend's one mechanism:
 *
 *   Project-wide   → everyone in the project
 *   Only me        → private to the owner
 *   Select members → a searchable allow-list of members
 *
 * Copy is overridable so callers that ship translated strings (connectors) can
 * pass them in; the defaults are the canonical English.
 */

type SharingMode = 'project' | 'private' | 'members';

export interface SharingSelection {
  mode: SharingMode;
  memberIds: string[];
}

interface OptionCopy {
  label: string;
  desc: string;
}

interface SharingCopy {
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

/** A selection is incomplete only when "Select members" is chosen with nobody picked. */
export function isSharingComplete(s: SharingSelection): boolean {
  return s.mode !== 'members' || s.memberIds.length > 0;
}

/** SharingSelection → the API's sharing intent. ownerId is filled in server-side. */
export function selectionToIntent(s: SharingSelection): ConnectorSharing {
  if (s.mode === 'project') return { mode: 'project' };
  if (s.mode === 'private') return { mode: 'private', ownerId: '' };
  return { mode: 'members', memberIds: s.memberIds };
}

/** API sharing intent → SharingSelection, for rendering the current state. */
export function intentToSelection(intent: ConnectorSharing | null | undefined): SharingSelection {
  if (!intent || intent.mode === 'project') return { mode: 'project', memberIds: [] };
  if (intent.mode === 'private') return { mode: 'private', memberIds: [] };
  return { mode: 'members', memberIds: intent.memberIds ?? [] };
}

/**
 * One selectable option row: an icon tile, label + description, and a check when
 * selected. The radio is visually hidden (the whole card is the affordance) but
 * stays in the tree for keyboard/AT — focus shows via `focus-within` ring.
 * When no `icon` is given it falls back to a plain leading radio dot, so it can
 * also serve adjacent non-sharing radios (e.g. the connector credential mode).
 */
export function ShareOption({
  value,
  label,
  desc,
  current,
  icon: Icon,
}: {
  value: string;
  label: string;
  desc: string;
  current: string;
  icon?: LucideIcon;
}) {
  const selected = current === value;
  return (
    <label
      className={cn(
        'group/option flex cursor-pointer items-center gap-3 rounded-2xl border p-3 transition-all duration-150',
        // Ring only on keyboard focus — not on every mouse click — so a picked
        // card reads as a clean tinted card, never a heavy persistent outline.
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-background',
        selected
          ? 'border-primary/60 bg-primary/[0.05]'
          : 'border-border/60 hover:border-border hover:bg-muted/30',
      )}
    >
      {Icon ? (
        <>
          <RadioGroupItem value={value} className="sr-only" />
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
              selected
                ? 'bg-primary/10 text-primary'
                : 'bg-muted text-muted-foreground group-hover/option:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
        </>
      ) : (
        <RadioGroupItem value={value} className="shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className={cn('text-sm font-medium transition-colors', selected ? 'text-foreground' : 'text-foreground/90')}>
          {label}
        </div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
      {Icon && (
        <Check
          className={cn(
            'h-4 w-4 shrink-0 text-primary transition-opacity duration-150',
            selected ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </label>
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
  /** Hide the internal heading when the surrounding surface already labels it. */
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
      {showHeading && (
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
          {c.heading}
        </Label>
      )}
      <RadioGroup
        value={value.mode}
        onValueChange={(v) => onChange({ ...value, mode: v as SharingMode })}
        className="space-y-2"
      >
        <ShareOption value="project" label={c.project.label} desc={c.project.desc} current={value.mode} icon={Globe} />
        <ShareOption value="private" label={c.private.label} desc={c.private.desc} current={value.mode} icon={Lock} />
        <ShareOption value="members" label={c.members.label} desc={c.members.desc} current={value.mode} icon={Users} />
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
    const list = q ? members.filter((m) => (m.email ?? m.user_id).toLowerCase().includes(q)) : members;
    // Selected first, then alphabetical — chosen people stay visible.
    return [...list].sort((a, b) => {
      const d = (selectedSet.has(a.user_id) ? 0 : 1) - (selectedSet.has(b.user_id) ? 0 : 1);
      return d !== 0 ? d : (a.email ?? a.user_id).localeCompare(b.email ?? b.user_id);
    });
  }, [members, query, selectedSet]);

  const toggle = (id: string) =>
    onChange(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="overflow-hidden rounded-2xl border border-border/60">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search members…"
          className="h-9 rounded-none border-0 border-b border-border/60 bg-transparent pl-9 shadow-none focus-visible:ring-0"
        />
      </div>

      {selected.length > 0 && (
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
          <span className="text-xs text-muted-foreground">{selected.length} selected</span>
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onChange([])}>
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
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {members.length === 0 ? 'No members in this project yet.' : 'No members match your search.'}
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
                  isSelected ? 'bg-primary/[0.06]' : 'hover:bg-muted/50',
                )}
              >
                <UserAvatar email={email} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {email}
                  {m.user_id === viewerId && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
                </span>
                <span
                  className={cn(
                    'flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors',
                    isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}
                >
                  {isSelected && <Check className="h-3 w-3" />}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
