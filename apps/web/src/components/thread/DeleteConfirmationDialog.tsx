'use client';

import { useTranslations } from 'next-intl';

import React, { useEffect } from 'react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { buttonVariants } from '@/components/ui/button';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface DeleteConfirmationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  threadName: string;
  isDeleting: boolean;
}

/**
 * Confirmation dialog for deleting a conversation
 */
export function DeleteConfirmationDialog({
  isOpen,
  onClose,
  onConfirm,
  threadName,
  isDeleting,
}: DeleteConfirmationDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  // Reset pointer events when dialog opens
  useEffect(() => {
    if (isOpen) {
      document.body.style.pointerEvents = 'auto';
    }
  }, [isOpen]);

  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tHardcodedUi.raw('componentsThreadDeleteconfirmationdialog.line47JsxTextDeleteConversation')}</AlertDialogTitle>
          <AlertDialogDescription>{tHardcodedUi.raw('componentsThreadDeleteconfirmationdialog.line49JsxTextAreYouSureYouWantToDeleteThe')}{' '}
            <span className="font-semibold">"{threadName}"</span>?
            <br />{tHardcodedUi.raw('componentsThreadDeleteconfirmationdialog.line52JsxTextThisActionCannotBeUndone')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={isDeleting}
            className={buttonVariants({ variant: 'destructive' })}
          >
            {isDeleting ? (
              <>
                <KortixLoader size="small" className="mr-2" />
                Deleting...
              </>
            ) : (
              'Delete'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
