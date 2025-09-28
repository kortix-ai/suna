'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Rocket } from 'lucide-react';
import React, { useCallback, useEffect } from 'react';

export interface PaywallDialogProps {
  cancelText?: string;
  children?: React.ReactNode;
  ctaText?: string;
  open: boolean;
  description?: string;
  onDialogClose?: () => void;
  onUpgradeClick?: () => void;
  upgradeUrl?: string;
  title?: string;
}

export const PaywallDialog: React.FC<PaywallDialogProps> = ({
  cancelText = 'Maybe Later',
  children,
  open = false,
  ctaText = 'Upgrade Now',
  description = 'This feature requires an upgrade to access.',
  onDialogClose,
  onUpgradeClick,
  upgradeUrl = '/settings/billing',
  title = 'Upgrade Required',
}) => {
  const handleUpgrade = useCallback(() => {
    if (onUpgradeClick) {
      onUpgradeClick();
    } else {
      window.location.href = upgradeUrl;
    }
  }, [onUpgradeClick, upgradeUrl]);

  const handleClose = useCallback(() => {
    if (onDialogClose) {
      onDialogClose();
    }
  }, [onDialogClose]);

  useEffect(() => {
    return () => {
      document.body.classList.remove('overflow-hidden');
      document.body.style.pointerEvents = 'auto';
      
      const strayBackdrops = document.querySelectorAll('[data-backdrop]');
      strayBackdrops.forEach(element => element.remove());
    };
  }, []);
  
  useEffect(() => {
    if (!open) {
      document.body.classList.remove('overflow-hidden');
      document.body.style.pointerEvents = 'auto';

      const overlays = document.querySelectorAll('[role="dialog"]');
      overlays.forEach(overlay => {
        if (!overlay.closest('[open="true"]')) {
          overlay.remove();
        }
      });
    }
  }, [open]);

  return (
    <>
      {children}

      <Dialog 
        open={open} 
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            document.body.style.pointerEvents = 'auto';
            document.body.classList.remove('overflow-hidden');
            
            setTimeout(() => {
              if (onDialogClose) {
                onDialogClose();
              }
            }, 0);
          }
        }}
      >
        <DialogContent 
          className="sm:max-w-md"
          onEscapeKeyDown={() => {
            handleClose();
            document.body.style.pointerEvents = 'auto';
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="py-6">
            <div className="flex flex-col items-center text-center space-y-4">
              <div className="rounded-full bg-primary/10 p-3">
                <Rocket className="h-6 w-6 text-primary" />
              </div>

              <div className="space-y-2">
                <h3 className="text-lg font-medium">Upgrade to unlock</h3>
                <p className="text-muted-foreground">
                  Get access to premium models and features
                </p>
              </div>
            </div>
          </div>

          <DialogFooter className="flex items-center gap-2">
            <Button 
              onClick={() => {
                document.body.style.pointerEvents = 'auto';
                document.body.classList.remove('overflow-hidden');
                handleClose();
              }} 
              variant="outline"
            >
              {cancelText}
            </Button>
            <Button 
              onClick={() => {
                document.body.style.pointerEvents = 'auto';
                document.body.classList.remove('overflow-hidden');
                handleUpgrade();
              }} 
              variant="default"
            >
              <Rocket className="h-4 w-4" />
              {ctaText}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};