'use client';

import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  EMPTY_PRINCIPAL_SELECTION,
  PrincipalPicker,
  type PrincipalKind,
} from '@/features/workspace/shared/access';
import { useMemo } from 'react';
import {
  DEFAULT_COPY,
  type SharingCopy,
  type SharingMode,
  type SharingSelection,
} from './sharing-intent';

// The member/group picker itself now lives in
// `features/workspace/shared/access/principal-picker.tsx` as
// `PrincipalPicker` — one component for every access surface. This module
// keeps the project-sharing radio (`SharingPicker`) and a thin
// `SubjectPicker` adapter so the one remaining non-access caller
// (`features/apps/apps-view.tsx`) is untouched.
export { PrincipalPicker } from '@/features/workspace/shared/access';

// Re-exported so existing callers can keep importing selection helpers +
// types from the component module.
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
   * members/groups" option — targeted access comes ONLY through agent
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
          To give specific people access, assign them (or a group) to an{' '}
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
 * Legacy adapter over {@link PrincipalPicker}, kept ONLY for the
 * non-access callers of this module (`features/apps/apps-view.tsx` and
 * `SharingPicker` above). Every access surface imports `PrincipalPicker`
 * directly and passes one `PrincipalSelection` value instead of three
 * parallel arrays.
 *
 * @deprecated Use `PrincipalPicker` from
 * `@/features/workspace/shared/access`.
 */
export function SubjectPicker({
  projectId,
  accountId,
  memberIds,
  groupIds,
  inviteEmails = [],
  onChange,
  allowInvite = false,
  kinds = ['member', 'group'],
  excludeUserIds,
  emptyLabel = 'No members or groups in this project yet.',
  allExcludedLabel = 'Everyone is already added.',
}: {
  projectId?: string;
  accountId?: string;
  memberIds: string[];
  groupIds: string[];
  inviteEmails?: string[];
  onChange: (memberIds: string[], groupIds: string[], inviteEmails: string[]) => void;
  allowInvite?: boolean;
  kinds?: PrincipalKind[];
  excludeUserIds?: string[] | Set<string>;
  emptyLabel?: string;
  allExcludedLabel?: string;
}) {
  const value = useMemo(
    () => ({ memberIds, groupIds, inviteEmails }),
    [memberIds, groupIds, inviteEmails],
  );
  const scope = projectId
    ? ({ kind: 'project', projectId } as const)
    : ({ kind: 'account', accountId: accountId ?? '' } as const);

  return (
    <PrincipalPicker
      scope={scope}
      selection="multi"
      kinds={kinds}
      allowInvite={allowInvite}
      excludeUserIds={excludeUserIds}
      value={value ?? EMPTY_PRINCIPAL_SELECTION}
      onChange={(next) => onChange(next.memberIds, next.groupIds, next.inviteEmails)}
      emptyLabel={emptyLabel}
      allExcludedLabel={allExcludedLabel}
    />
  );
}
