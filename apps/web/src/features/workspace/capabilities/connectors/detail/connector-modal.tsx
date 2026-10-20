'use client';

import { useTranslations } from '@/i18n/use-translations';
import type { AdminConnector } from '@kortix/sdk';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';

import { Button } from '@/components/ui/button';
import { Modal, ModalClose, ModalContent, ModalTitle } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { Close } from '@/features/icon/icons/close';

import { ConnectorDetailView } from './connector-page';

interface ConnectorModalProps {
  projectId: string;
  /** The connector to show, or `null` when it has not resolved yet. `open` is
   *  driven by the SELECTION, not by this — see `shared/detail-selection.ts`. */
  connector: AdminConnector | null;
  canWrite: boolean;
  open: boolean;
  /** Open on a selection whose record is still loading. Renders the shell so
   *  the modal is present from the first frame. */
  isResolving?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refetch every authorization-derived query. Every mutation below calls it. */
  onChanged: () => void;
  /** The connector no longer exists — clear the selection and close. */
  onRemoved: () => void;
}

/** The scroll column inside the modal: the page's column, tighter. */
const MODAL_COLUMN = 'w-full space-y-6 px-6 py-6';

/**
 * One connector over the agent editor, without leaving it (a navigation would
 * drop the agent's unsaved draft). The body IS the connector page
 * (`ConnectorDetailView`): the same header, status strip, notice, tabs and
 * split credential sheet, so the modal and the page cannot drift. The modal
 * adds only a close button and keeps its tab in state instead of the URL.
 *
 * The view is keyed on `connector.slug` so picking a different connector while
 * the modal stays open resets the tab without replaying the open animation.
 */
export function ConnectorModal({
  projectId,
  connector,
  canWrite,
  open,
  isResolving = false,
  onOpenChange,
  onChanged,
  onRemoved,
}: ConnectorModalProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        className="bg-background flex max-h-[92vh] min-h-[85vh] flex-col space-y-0 overflow-hidden p-0 lg:max-w-5xl"
        aria-describedby={undefined}
        showCloseButton={false}
      >
        {connector ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <ConnectorDetailView
              key={connector.slug}
              projectId={projectId}
              connector={connector}
              canWrite={canWrite}
              onChanged={onChanged}
              onRemoved={onChanged}
              onLeave={onRemoved}
              urlState={false}
              columnClassName={MODAL_COLUMN}
              wrapTitle={(title) => <ModalTitle asChild>{title}</ModalTitle>}
              headerEnd={
                <ModalClose asChild>
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={tI18nComplete.raw('text7d9eb7acb13e')}
                  >
                    <Close className="text-foreground size-4 stroke-1" />
                  </Button>
                </ModalClose>
              }
            />
          </div>
        ) : isResolving ? (
          <ConnectorModalSkeleton />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

/**
 * The shell while the selection resolves. Shape-matched to the view — icon and
 * name, the strip, the tabs, two rows — so the handover fills it in place.
 * The visually hidden title gives the dialog its accessible name meanwhile.
 */
function ConnectorModalSkeleton() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className={MODAL_COLUMN} aria-busy>
      <VisuallyHidden>
        <ModalTitle>{tI18nComplete.raw('text0c21b0363778')}</ModalTitle>
      </VisuallyHidden>
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-6 w-48 rounded-sm" />
      </div>
      <Skeleton className="h-16 w-full rounded-md" />
      <Skeleton className="h-9 w-64 rounded-md" />
      <Skeleton className="h-20 w-full rounded-md" />
    </div>
  );
}
