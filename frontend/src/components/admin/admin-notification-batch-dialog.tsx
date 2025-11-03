'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAdminNotificationBatch, useCancelGlobalNotificationBatch } from '@/hooks/react-query/admin/use-admin-notifications';
import { formatDistanceToNow } from 'date-fns';
import { Loader2, X } from 'lucide-react';
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

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  sending: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  completed: 'bg-green-500/10 text-green-500 border-green-500/20',
  failed: 'bg-red-500/10 text-red-500 border-red-500/20',
  cancelled: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
};

const typeColors: Record<string, string> = {
  info: 'bg-blue-500/10 text-blue-500',
  success: 'bg-green-500/10 text-green-500',
  warning: 'bg-yellow-500/10 text-yellow-500',
  error: 'bg-red-500/10 text-red-500',
};

interface AdminNotificationBatchDialogProps {
  batchId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function AdminNotificationBatchDialog({
  batchId,
  isOpen,
  onClose,
}: AdminNotificationBatchDialogProps) {
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const { data: batch, isLoading, refetch } = useAdminNotificationBatch(batchId);
  const cancelMutation = useCancelGlobalNotificationBatch();

  const canCancel = batch?.status === 'pending' || batch?.status === 'sending';

  const handleCancel = () => {
    cancelMutation.mutate(batchId, {
      onSuccess: () => {
        setShowCancelDialog(false);
        refetch();
      },
    });
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle>Notification Batch Details</DialogTitle>
                <DialogDescription>View detailed information about this notification batch</DialogDescription>
              </div>
              {canCancel && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCancelDialog(true)}
                  disabled={cancelMutation.isPending}
                  className="text-destructive hover:text-destructive"
                >
                  {cancelMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Cancelling...
                    </>
                  ) : (
                    <>
                      <X className="h-4 w-4 mr-2" />
                      Cancel Batch
                    </>
                  )}
                </Button>
              )}
            </div>
          </DialogHeader>

        {isLoading ? (
          <div className="p-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Loading batch details...</p>
          </div>
        ) : batch ? (
          <div className="space-y-6">
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold mb-2">{batch.title}</h3>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{batch.message}</p>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="outline"
                  className={statusColors[batch.status] || statusColors.pending}
                >
                  {batch.status}
                </Badge>
                <Badge variant="outline" className={typeColors[batch.type] || typeColors.info}>
                  {batch.type}
                </Badge>
                {batch.send_email && <Badge variant="outline">Email</Badge>}
                {batch.send_push && <Badge variant="outline">Push</Badge>}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Total Recipients</p>
                  <p className="text-lg font-semibold">{batch.total_recipients || 0}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Emails Sent</p>
                  <p className="text-lg font-semibold">{batch.emails_sent || 0}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Push Sent</p>
                  <p className="text-lg font-semibold">{batch.pushes_sent || 0}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Success Rate</p>
                  <p className="text-lg font-semibold">
                    {batch.total_recipients > 0
                      ? Math.round(
                          ((batch.emails_sent || 0) + (batch.pushes_sent || 0)) /
                            (batch.total_recipients * 2) *
                            100
                        )
                      : 0}
                    %
                  </p>
                </div>
              </div>

              <div className="space-y-2 text-sm">
                {batch.created_at && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Created:</span>
                    <span>{formatDistanceToNow(new Date(batch.created_at), { addSuffix: true })}</span>
                  </div>
                )}
                {batch.started_at && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Started:</span>
                    <span>{formatDistanceToNow(new Date(batch.started_at), { addSuffix: true })}</span>
                  </div>
                )}
                {batch.completed_at && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Completed:</span>
                    <span>{formatDistanceToNow(new Date(batch.completed_at), { addSuffix: true })}</span>
                  </div>
                )}
                {batch.cancelled_at && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Cancelled:</span>
                    <span>{formatDistanceToNow(new Date(batch.cancelled_at), { addSuffix: true })}</span>
                  </div>
                )}
              </div>

              {batch.notifications && batch.notifications.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-2">Sample Notifications ({Math.min(batch.notifications.length, 10)})</h4>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {batch.notifications.slice(0, 10).map((notif) => (
                      <div
                        key={notif.id}
                        className="border rounded p-2 text-sm space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-xs text-muted-foreground">User ID</span>
                            <span className="text-sm font-mono">{notif.user_id.substring(0, 8)}...</span>
                          </div>
                          <div className="flex gap-2">
                            {notif.email_sent && (
                              <Badge variant="outline" className="text-xs bg-green-500/10 text-green-500 border-green-500/20">Email</Badge>
                            )}
                            {notif.push_sent && (
                              <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-500 border-blue-500/20">Push</Badge>
                            )}
                            {!notif.email_sent && !notif.push_sent && (
                              <Badge variant="outline" className="text-xs text-muted-foreground">Pending</Badge>
                            )}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(notif.created_at), { addSuffix: true })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="p-8 text-center">
            <p className="text-sm text-muted-foreground">Batch not found</p>
          </div>
        )}
      </DialogContent>
    </Dialog>

    <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel Notification Batch?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to cancel this notification batch? The sending process will stop
            at the next checkpoint (within the next ~10 users). Notifications already sent cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep Sending</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleCancel}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={cancelMutation.isPending}
          >
            {cancelMutation.isPending ? 'Cancelling...' : 'Cancel Batch'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}

