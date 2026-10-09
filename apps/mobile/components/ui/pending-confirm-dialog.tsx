/**
 * A confirm dialog that stays open while its action is in flight: the cancel
 * button and the system dismiss are disabled until `pending` clears, and the
 * caller decides the title / description (which is where an error message
 * replaces the question). Shared by the destructive dialogs that drive a
 * mutation (archive project, cancel a scheduled plan change).
 */
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

interface PendingConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An in-flight action keeps the dialog up and both buttons disabled. */
  pending: boolean;
  title: React.ReactNode;
  description: React.ReactNode;
  /** Renders the description in the destructive color (an error message). */
  descriptionError?: boolean;
  confirmLabel: string;
  confirmVariant?: 'default' | 'destructive';
  onConfirm: () => void;
}

export function PendingConfirmDialog({
  open,
  onOpenChange,
  pending,
  title,
  description,
  descriptionError,
  confirmLabel,
  confirmVariant = 'default',
  onConfirm,
}: PendingConfirmDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Keep the dialog up until an in-flight action settles.
        if (!next && pending) return;
        onOpenChange(next);
      }}>
      <AlertDialogContent className="rounded-3xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className={descriptionError ? 'text-destructive' : undefined}>
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild disabled={pending}>
            <Button variant="secondary" size="lg" className="rounded-full">
              <Text>Cancel</Text>
            </Button>
          </AlertDialogCancel>
          <Button
            variant={confirmVariant}
            size="lg"
            className="rounded-full"
            disabled={pending}
            onPress={onConfirm}>
            <Text>{confirmLabel}</Text>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
