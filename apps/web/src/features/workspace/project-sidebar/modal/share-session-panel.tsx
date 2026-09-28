'use client';

import { sessionOversightQueryKey } from '@/components/iam/session-oversight-card';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { EMPTY_PRINCIPAL_SELECTION, PrincipalPicker } from '@/features/workspace/shared/access';
import {
  intentToSelection,
  isSharingComplete,
  selectionToIntent,
  type SharingCopy,
  type SharingMode,
  type SharingSelection,
} from '@/features/workspace/shared/sharing-intent';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from '@/i18n/remaining-ui-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { getSessionOversight, setProjectSessionSharing, type ProjectSession } from '@kortix/sdk';
import {
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  FolderSimpleIcon,
  LinkSimpleIcon,
  LockIcon,
  ShieldCheckIcon,
  UsersIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';
import { SessionPublicLinkRow } from './session-public-link-section';
import { sessionAccessSummary, sessionAccessView, withSelection } from './share-session-access';
import { refreshAfterShare } from './share-session-cache';

/**
 * The three options, worded from the EDITOR's seat.
 *
 * "Only you" is the trap this copy exists to avoid repeating: the stored value
 * is `visibility: 'private'`, which means "the session's OWNER only". Rendered
 * to somebody who is not the owner it promised the opposite of what saving it
 * did — they lost the session. A non-owner therefore gets the honest label
 * below, disabled, instead of a second-person one that lies.
 */
const SESSION_SHARING_COPY: SharingCopy = {
  heading: 'Who can open this session',
  project: { label: 'Whole project', desc: 'Every member of this project.' },
  private: { label: 'Only you', desc: 'Nobody else can open this session.' },
  members: { label: 'Specific people', desc: 'Only the members and groups you choose.' },
};

function delegateCopy(ownerLabel: string, tI18nComplete: UiTranslator): SharingCopy {
  return {
    ...SESSION_SHARING_COPY,
    private: {
      label: tI18nComplete('text0df9df285277', { value0: ownerLabel }),
      desc: tI18nComplete.raw('text38b08d83da73'),
    },
  };
}

const MODES: { mode: SharingMode; icon: Icon }[] = [
  { mode: 'private', icon: LockIcon },
  { mode: 'project', icon: FolderSimpleIcon },
  { mode: 'members', icon: UsersIcon },
];

type TextElement = ElementType<{ className?: string; children?: ReactNode }>;

const PRIVATE_INTENT = { mode: 'private', ownerId: '' } as const;

/**
 * Who can open a session, and its public link, in one panel. The header's
 * Share popover and the session list's Share dialog both render it, so the two
 * entry points cannot drift apart.
 *
 * A pick saves on click: there is no Save button to forget. "Specific people"
 * is the one exception — it opens a picker and saves on Done, because an empty
 * allow-list is not a valid policy (`isSharingComplete`).
 */
export function ShareSessionPanel({
  projectId,
  session,
  onSaved,
  Title = 'h2',
  Description = 'p',
}: {
  projectId: string;
  session: ProjectSession;
  onSaved?: () => void;
  /** The element for the heading. The dialog passes `ModalTitle` so it stays labelled. */
  Title?: TextElement;
  Description?: TextElement;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tOversight = useTranslations('sessionOversight');
  const view = sessionAccessView(session);
  const copy = localizeUiCatalog<SharingCopy>(
    view.role === 'owner' ? SESSION_SHARING_COPY : delegateCopy(view.ownerLabel, tI18nComplete),
    tI18nComplete,
    REMAINING_UI_TRANSLATION_KEYS,
  );

  // The last pick this panel saved, until the refetched session carries it.
  const [saved, setSaved] = useState<SharingSelection | null>(null);
  const current = saved ?? intentToSelection(session.sharing ?? PRIVATE_INTENT);
  const [picking, setPicking] = useState<SharingSelection | null>(null);

  // Disclose the account's session-oversight policy: while it is on, account
  // owners and admins can open this session whatever is picked below. Silently
  // absent on any error — the IAM read never toasts.
  const oversightQuery = useQuery({
    queryKey: sessionOversightQueryKey(session.account_id ?? ''),
    queryFn: () => getSessionOversight(session.account_id!),
    enabled: !!session.account_id,
    staleTime: 30_000,
    retry: false,
  });

  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (next: SharingSelection) =>
      setProjectSessionSharing(projectId, session.session_id, selectionToIntent(next)),
    onSuccess: (_result, next) => {
      setSaved(next);
      setPicking(null);
      // A share can switch the session's provider keys (share-session-cache.ts).
      void refreshAfterShare(queryClient, projectId, session.session_id);
      onSaved?.();
    },
  });
  // Optimistic: the pick shows as chosen while it saves. A failure falls back
  // to `current`, which only a successful save moves.
  const shown = save.isPending && save.variables ? save.variables : current;

  const pick = (mode: SharingMode) => {
    if (mode === 'members') {
      setPicking(
        current.mode === 'members' ? current : { mode: 'members', memberIds: [], groupIds: [] },
      );
      return;
    }
    if (mode !== shown.mode) save.mutate({ mode, memberIds: [], groupIds: [] });
  };

  const summary = sessionAccessSummary(withSelection(session, shown));
  const description =
    view.role === 'owner'
      ? tI18nHardcoded('autoFeaturesCoWorkerProjectSidebarModalShareSessionModalJsxb29062b4')
      : view.role === 'delegate'
        ? tI18nHardcoded(
            'autoFeaturesWorkspaceProjectSidebarModalShareSessionModalDelegateDescription',
            { owner: view.ownerLabel },
          )
        : tI18nHardcoded(
            'autoFeaturesWorkspaceProjectSidebarModalShareSessionModalViewerDescription',
            { owner: view.ownerLabel },
          );

  if (picking) {
    return (
      <div className="flex flex-col" data-testid="share-session-people">
        <div className="flex items-center gap-1 px-2 py-2">
          <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => setPicking(null)}>
            <CaretLeftIcon className="size-4" />
          </Button>
          <Title className="text-foreground text-sm font-medium">{copy.members.label}</Title>
        </div>
        <PrincipalPicker
          scope={{ kind: 'project', projectId }}
          selection="multi"
          kinds={['member', 'group']}
          value={{
            ...EMPTY_PRINCIPAL_SELECTION,
            memberIds: picking.memberIds,
            groupIds: picking.groupIds,
          }}
          onChange={(next) =>
            setPicking({ mode: 'members', memberIds: next.memberIds, groupIds: next.groupIds })
          }
          className="rounded-none border-x-0 border-b-0"
        />
        <ShareFooter
          status={
            save.isError
              ? { tone: 'error', text: 'Couldn’t change access' }
              : {
                  tone: 'muted',
                  text: isSharingComplete(picking)
                    ? sessionAccessSummary(withSelection(session, picking))
                    : 'Pick at least one person',
                }
          }
        >
          <Button
            size="sm"
            disabled={!isSharingComplete(picking) || save.isPending}
            onClick={() => save.mutate(picking)}
          >
            {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Done
          </Button>
        </ShareFooter>
      </div>
    );
  }

  return (
    <div className="flex flex-col" data-testid="share-session-panel">
      <div className="space-y-1 px-4 pt-4 pb-2.5">
        <Title className="text-foreground text-sm font-medium">
          {tI18nHardcoded('autoFeaturesCoWorkerProjectSidebarModalShareSessionModalJsxc5c9cc41')}
        </Title>
        <Description className="text-muted-foreground text-xs">{description}</Description>
      </div>

      {view.canEdit ? (
        <div role="radiogroup" aria-label={copy.heading} className="px-1.5 pb-1.5">
          {MODES.map(({ mode, icon: ModeIcon }) => {
            const selected = shown.mode === mode;
            const saving = save.isPending && save.variables?.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={view.disabledModes.includes(mode) || save.isPending}
                onClick={() => pick(mode)}
                className={cn(
                  'duration-fast flex w-full cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors',
                  'hover:bg-hover focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-hidden',
                  'disabled:pointer-events-none disabled:opacity-50',
                  selected && 'bg-active',
                )}
              >
                <ModeIcon
                  className={cn(
                    'size-4 shrink-0',
                    selected ? 'text-foreground' : 'text-muted-foreground',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block text-sm font-medium">
                    {copy[mode].label}
                  </span>
                  <span className="text-muted-foreground block text-xs">{copy[mode].desc}</span>
                </span>
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {saving ? (
                    <Loading className="size-4 shrink-0" />
                  ) : selected ? (
                    <CheckIcon className="text-foreground size-4" />
                  ) : mode === 'members' ? (
                    <CaretRightIcon className="text-muted-foreground size-3.5" />
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {oversightQuery.data?.enabled === true ? (
        <div className="px-4 pb-3">
          <InfoBanner
            tone="neutral"
            icon={ShieldCheckIcon}
            data-testid="session-oversight-disclosure"
          >
            {tOversight.raw('shareDisclosure')}
          </InfoBanner>
        </div>
      ) : null}

      {/* A read-only, sign-in-free link for anyone outside the project. Same
          server verdict as the options above (`can_manage_sharing`). */}
      {view.canEdit ? (
        <SessionPublicLinkRow projectId={projectId} sessionId={session.session_id} />
      ) : null}

      <ShareFooter
        status={
          save.isError
            ? { tone: 'error', text: 'Couldn’t change access' }
            : { tone: save.isSuccess ? 'saved' : 'muted', text: summary }
        }
      >
        {save.isError ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => save.variables && save.mutate(save.variables)}
          >
            Try again
          </Button>
        ) : (
          <CopySessionLink projectId={projectId} sessionId={session.session_id} />
        )}
      </ShareFooter>
    </div>
  );
}

function ShareFooter({
  status,
  children,
}: {
  status: { tone: 'muted' | 'saved' | 'error'; text: string };
  children: ReactNode;
}) {
  return (
    <div className="bg-surface flex items-center justify-between gap-3 border-t py-2.5 pr-3 pl-4">
      <span
        role={status.tone === 'error' ? 'alert' : undefined}
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-xs',
          status.tone === 'error' ? 'text-kortix-red' : 'text-muted-foreground',
        )}
      >
        {status.tone === 'saved' ? (
          <CheckIcon className="text-kortix-green size-3.5 shrink-0" />
        ) : null}
        <span className="truncate">{status.text}</span>
      </span>
      {children}
    </div>
  );
}

/** The session's own URL. Opens only for the people the options above allow. */
function CopySessionLink({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/projects/${projectId}/sessions/${sessionId}`,
      );
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      errorToast('Couldn’t copy the link');
    }
  };

  return (
    <Button size="sm" className="active:scale-[0.96]" onClick={() => void copy()}>
      {copied ? (
        <CheckIcon className="size-4 shrink-0" />
      ) : (
        <LinkSimpleIcon className="size-4 shrink-0" />
      )}
      {copied ? 'Copied' : 'Copy link'}
    </Button>
  );
}
