'use client';

import { Badge } from '@/components/ui/badge';
import Hint from '@/components/ui/hint';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '@/components/ui/modal';
import type { UiTranslator } from '@/i18n/translator';
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectSession } from '@kortix/sdk';
import {
  GlobeIcon as Globe,
  LockIcon as LockSolid,
  UsersIcon as UsersSolid,
} from '@phosphor-icons/react';
import { ShareSessionPanel } from './share-session-panel';

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

/**
 * The Share dialog, for the places with no Share button to anchor a popover to
 * (the session list's row menu, the sessions page). The header opens the same
 * `ShareSessionPanel` in a popover instead.
 */
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
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-sm">
        {session ? (
          <ShareSessionPanel
            projectId={projectId}
            session={session}
            onSaved={onSaved}
            Title={ModalTitle}
            Description={ModalDescription}
          />
        ) : null}
      </ModalContent>
    </Modal>
  );
}
