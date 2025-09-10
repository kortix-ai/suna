'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Clock, Github, X } from 'lucide-react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/components/ui/button';

interface MaintenanceAlertProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  closeable?: boolean;
}

export function MaintenanceAlert({
  open,
  onOpenChange,
  closeable = true,
}: MaintenanceAlertProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={closeable ? onOpenChange : undefined}
    >
      <AlertDialogContent className="max-w-2xl w-[90vw] p-0 border-0 shadow-lg overflow-hidden rounded-2xl z-[9999]">
        <motion.div
          className="relative"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        >
          {closeable && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-4 top-4 z-20 rounded-full hover:bg-background/80"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Button>
          )}
          <AlertDialogHeader className="gap-6 px-8 pt-10 pb-6 relative z-10">
            <motion.div
              className="flex items-center justify-center"
              initial={{ y: -10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.1 }}
            >
              <div className="flex size-16 items-center justify-center rounded-full bg-gradient-to-t from-amber-500/20 to-amber-600/10 backdrop-blur-md">
                <div className="flex size-12 items-center justify-center rounded-full bg-gradient-to-t from-amber-500 to-amber-600 shadow-md">
                  <Clock className="h-6 w-6 text-white" />
                </div>
              </div>
            </motion.div>

            <motion.div
              initial={{ y: -10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              <AlertDialogTitle className="text-2xl font-bold text-center text-primary bg-clip-text">
                Maintenance Notice
              </AlertDialogTitle>
            </motion.div>

            <motion.div
              initial={{ y: -10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.3 }}
            >
              <AlertDialogDescription className="text-base text-center leading-relaxed">
                We are currently performing maintenance on our system. Please
                check back later.
              </AlertDialogDescription>
            </motion.div>
          </AlertDialogHeader>
        </motion.div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
