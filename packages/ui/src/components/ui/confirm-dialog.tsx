'use client';

/**
 * Reusable confirmation dialog — used for delete, destructive actions, etc.
 *
 * <ConfirmDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   title="Delete task"
 *   description="This will permanently delete the task and all comments."
 *   confirmLabel="Delete"
 *   onConfirm={() => deleteMutation.mutate(id)}
 *   isPending={deleteMutation.isPending}
 *   destructive
 * />
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { buttonVariants } from './button';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '../../lib/utils';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  isPending?: boolean;
  /** Render the confirm button in destructive red. Use for delete /
   *  revoke / disable-security-feature flows. */
  confirmVariant?: 'default' | 'destructive';
  /** Optional leading icon on the confirm button. */
  confirmIcon?: React.ReactNode;
  /** Keep the confirm button disabled, e.g. until a typed confirmation matches. */
  confirmDisabled?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  isPending,
  confirmVariant = 'default',
  confirmIcon,
  confirmDisabled,
}: ConfirmDialogProps) {
  // The defaults are the viewer's language: an English literal here put
  // "Cancel" under every translated dialog that passed no label (KRTX-2326).
  const t = useTranslations('common');
  const confirmText = confirmLabel ?? t('confirm');
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md" overlayClassName="bg-black/25 backdrop-blur-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{cancelLabel ?? t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={isPending || confirmDisabled}
            className={cn(buttonVariants({ variant: confirmVariant, size: 'sm' }), 'gap-1.5')}
          >
            {confirmIcon}
            {isPending ? `${confirmText}…` : confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
