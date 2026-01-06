'use client';

import React from 'react';
import { KortixLoader } from '@/components/ui/kortix-loader';

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

interface KBDeleteConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  itemName: string;
  itemType: 'folder' | 'file';
  isDeleting: boolean;
}

export function KBDeleteConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  itemName,
  itemType,
  isDeleting,
}: KBDeleteConfirmDialogProps) {
  const title = `Delete ${itemType}`;
  const description = itemType === 'folder'
    ? `Are you sure you want to delete the folder "${itemName}"? This will permanently delete all files inside the folder. This action cannot be undone.`
    : `Are you sure you want to delete the file "${itemName}"? This action cannot be undone.`;

  return (
    <AlertDialog open={isOpen} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={isDeleting}
            className="bg-destructive text-white hover:bg-destructive/90"
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