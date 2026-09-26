'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  SharingPicker,
  intentToSelection,
  isSharingComplete,
  selectionToIntent,
  type SharingCopy,
  type SharingSelection,
} from '@/features/workspace/shared/sharing-picker';
import type { UiTranslator } from '@/i18n/translator';
import { useTranslations } from '@/i18n/use-translations';
import { getSessionOversight, setProjectSessionSharing, type ProjectSession } from '@kortix/sdk';
import { sessionOversightQueryKey } from '@/components/iam/session-oversight-card';
import {
  GlobeIcon as Globe,
  ShieldCheckIcon,
  LockIcon as LockSolid,
  UsersIcon as UsersSolid,
} from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { SessionPublicLinkSection } from './session-public-link-section';
import { sessionAccessSummary, sessionAccessView } from './share-session-access';

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

/** The visibility badge is a status indicator (team/shared/private) — the
 *  shared and private states render their solid glyph, matching the app's
 *  status/solid-surface convention. */
function UsersSolidFilled({ className }: { className?: string }) {
  return <UsersSolid className={className} weight="fill" />;
}
function LockSolidFilled({ className }: { className?: string }) {
  return <LockSolid className={className} weight="fill" />;
}

export function sessionVisibilityMeta(
  session: Pick<ProjectSession, 'visibility'>,
  tI18nComplete: UiTranslator,
) {
  switch (session.visibility) {
    case 'project':
      return { icon: Globe, label: tI18nComplete.raw('text5985039f106d'), tone: 'shared' as const };
    case 'restricted':
      return {
        icon: UsersSolidFilled,
        label: tI18nComplete.raw('texte3c4b39d6d50'),
        tone: 'shared' as const,
      };
    default:
      return {
        icon: LockSolidFilled,
        label: tI18nComplete.raw('textc63eb6720c6e'),
        tone: 'private' as const,
      };
  }
}

export function SessionVisibilityBadge({ session }: { session: ProjectSession }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const meta = sessionVisibilityMeta(session, tI18nComplete);
  const Icon = meta.icon;

  if (session.visibility === 'private' && session.is_owner !== false) return null;
  const sharedBy =
    !session.is_owner && session.owner_email ? `Shared by ${session.owner_email}` : null;
  return (
    <Hint
      side="bottom"
      label={sharedBy ?? tI18nComplete('text6bf74b3f6d7a', { value0: meta.label })}
    >
      <Badge variant="kortix" size="sm" className="gap-2">
        <Icon className="size-3" />
        {meta.label}
      </Badge>
    </Hint>
  );
}

export function ShareSessionModal({
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tOversight = useTranslations('sessionOversight');
  const [sharing, setSharing] = useState<SharingSelection>({
    mode: 'private',
    memberIds: [],
    groupIds: [],
  });

  useEffect(() => {
    if (!open || !session) return;
    setSharing(intentToSelection(session.sharing ?? { mode: 'private', ownerId: '' }));
  }, [open, session]);

  // Disclose the account's session-oversight policy: while it is on, account
  // owners and admins can open this session whatever is picked below. Read only
  // while the dialog is open (a user action), and silently absent on any error
  // — the IAM read never toasts (`showErrors: false`).
  const accountId = session?.account_id ?? null;
  const oversightQuery = useQuery({
    queryKey: sessionOversightQueryKey(accountId ?? ''),
    queryFn: () => getSessionOversight(accountId!),
    enabled: open && !!accountId,
    staleTime: 30_000,
    retry: false,
  });
  const oversightOn = oversightQuery.data?.enabled === true;

  const save = useMutation({
    mutationFn: () => {
      if (!isSharingComplete(sharing)) {
        throw new Error('Pick at least one member, or choose another option.');
      }
      return setProjectSessionSharing(projectId, session!.session_id, selectionToIntent(sharing));
    },
    onSuccess: () => {
      successToast(tI18nHardcoded.raw('i18nComplete.textd8b630796604'));
      onSaved?.();
      onOpenChange(false);
    },
    onError: (err: Error) =>
      errorToast(err.message || tI18nHardcoded.raw('i18nComplete.text68d66e06fd0f')),
  });

  const view = session
    ? sessionAccessView(session)
    : { role: 'owner' as const, canEdit: true, disabledModes: [], ownerLabel: 'You' };
  // Never let the editor save a mode they are not allowed to pick. A
  // machine-owned session opens on `private`, and that is exactly the one a
  // delegate must not keep — saving it would revoke their own access.
  const blockedSelection = view.disabledModes.includes(sharing.mode);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!save.isPending) onOpenChange(o);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>
            {tI18nHardcoded('autoFeaturesCoWorkerProjectSidebarModalShareSessionModalJsxc5c9cc41')}
          </ModalTitle>
          <ModalDescription>
            {view.role === 'owner'
              ? tI18nHardcoded(
                  'autoFeaturesCoWorkerProjectSidebarModalShareSessionModalJsxb29062b4',
                )
              : view.role === 'delegate'
                ? tI18nHardcoded(
                    'autoFeaturesWorkspaceProjectSidebarModalShareSessionModalDelegateDescription',
                    { owner: view.ownerLabel },
                  )
                : tI18nHardcoded(
                    'autoFeaturesWorkspaceProjectSidebarModalShareSessionModalViewerDescription',
                    { owner: view.ownerLabel },
                  )}
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[60vh] space-y-5 overflow-y-auto">
          {view.canEdit ? (
            <SharingPicker
              projectId={projectId}
              value={sharing}
              onChange={setSharing}
              copy={
                view.role === 'owner'
                  ? SESSION_SHARING_COPY
                  : delegateCopy(view.ownerLabel, tI18nComplete)
              }
              disabledModes={view.disabledModes}
            />
          ) : (
            // Read-only, not hidden: a person a session was shared with should
            // still be able to see who else is in it. Withholding that is what
            // sent people to the editable dialog in the first place.
            <p className="text-foreground text-sm" data-testid="session-access-summary">
              {session ? sessionAccessSummary(session) : null}
            </p>
          )}
          {oversightOn ? (
            <InfoBanner
              tone="neutral"
              icon={ShieldCheckIcon}
              data-testid="session-oversight-disclosure"
            >
              {tOversight.raw('shareDisclosure')}
            </InfoBanner>
          ) : null}
          {/* Next to the in-team picker: who in the project can open the
              session, and a read-only link for anyone outside it. Same
              server verdict as the picker (`can_manage_sharing`). */}
          {view.canEdit && session ? (
            <SessionPublicLinkSection projectId={projectId} sessionId={session.session_id} />
          ) : null}
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            variant="outline-ghost"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            {view.canEdit ? 'Cancel' : 'Close'}
          </Button>
          {view.canEdit && (
            <Button
              size="sm"
              onClick={() => save.mutate()}
              disabled={save.isPending || !isSharingComplete(sharing) || blockedSelection}
              className="w-full sm:w-auto"
            >
              {save.isPending && <Loading />}
              {tI18nHardcoded.raw('i18nComplete.text1509f561f241')}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
