/**
 * The app's one confirmation (COR-151): an `AlertDialog` for a destructive or
 * two-button choice. Never `Alert.alert` for a confirm/cancel decision —
 * `Alert.alert` stays only for a one-button acknowledgement (design.md →
 * Confirmations).
 *
 * `useConfirmDialog()` gives a screen an imperative `confirm({...})` that
 * replaces an `Alert.alert(title, message, [cancel, action])` call 1:1, plus
 * the `dialog` element the screen renders once, anywhere in its tree:
 *
 *   const { confirm, dialog } = useConfirmDialog();
 *   confirm({ title: 'Delete secret', description: '…', confirmLabel: 'Delete', destructive: true, onConfirm });
 *   return <>…{dialog}</>;
 *
 * Footer: `AlertDialogCancel asChild` secondary pill · the action pill
 * (`destructive` or `default`), both `size="lg" rounded-full`. The dialog
 * closes before `onConfirm` runs; the action reports its own result
 * (`useToast`). The last request stays rendered while the dialog animates
 * closed, so the text does not blank mid-fade.
 *
 * The dialog portals into `OVERLAY_PORTAL_HOST` by default, so a confirm asked
 * from inside a bottom sheet draws above the sheet on Android too. A screen
 * inside a React Native `Modal` (its own native window) mounts a `PortalHost`
 * in the modal and passes its name.
 */

import * as React from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { OVERLAY_PORTAL_HOST } from '@/lib/ui/portal-hosts';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

export interface ConfirmRequest {
  title: string;
  description?: string;
  /** The action pill's label, e.g. "Delete". */
  confirmLabel: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** Destructive action pill (red). Default false: the primary pill. */
  destructive?: boolean;
  onConfirm: () => void;
}

export function useConfirmDialog(options?: { portalHost?: string }): {
  confirm: (request: ConfirmRequest) => void;
  dialog: React.ReactElement;
} {
  const [open, setOpen] = React.useState(false);
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null);

  const confirm = React.useCallback((next: ConfirmRequest) => {
    setRequest(next);
    setOpen(true);
  }, []);

  const handleConfirm = React.useCallback(() => {
    setOpen(false);
    request?.onConfirm();
  }, [request]);

  const dialog = (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent
        className="rounded-3xl"
        portalHost={options?.portalHost ?? OVERLAY_PORTAL_HOST}>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title ?? ''}</AlertDialogTitle>
          {request?.description ? (
            <AlertDialogDescription>{request.description}</AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="secondary" size="lg" className="rounded-full">
              <Text>{request?.cancelLabel ?? 'Cancel'}</Text>
            </Button>
          </AlertDialogCancel>
          <Button
            variant={request?.destructive ? 'destructive' : 'default'}
            size="lg"
            className="rounded-full"
            onPress={handleConfirm}>
            <Text>{request?.confirmLabel ?? ''}</Text>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, dialog };
}
