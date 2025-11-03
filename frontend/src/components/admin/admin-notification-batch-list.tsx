'use client';

import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAdminNotificationBatches, useCancelGlobalNotificationBatch } from '@/hooks/react-query/admin/use-admin-notifications';
import { formatDistanceToNow } from 'date-fns';
import { Eye, Loader2, X } from 'lucide-react';
import { AdminNotificationBatchDialog } from './admin-notification-batch-dialog';
import type { GlobalNotificationBatch } from '@/lib/api';
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

export function AdminNotificationBatchList() {
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [cancelBatchId, setCancelBatchId] = useState<string | null>(null);
  const { data: batches, isLoading, refetch } = useAdminNotificationBatches({
    page: 1,
    page_size: 50,
  });
  const cancelMutation = useCancelGlobalNotificationBatch();

  const handleCancel = (batchId: string) => {
    setCancelBatchId(batchId);
  };

  const confirmCancel = () => {
    if (cancelBatchId) {
      cancelMutation.mutate(cancelBatchId, {
        onSuccess: () => {
          setCancelBatchId(null);
        },
      });
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading notification batches...</p>
        </CardContent>
      </Card>
    );
  }

  if (!batches || batches.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Global Notification Batches</CardTitle>
          <CardDescription>History of all global notifications sent</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No global notifications sent yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Global Notification Batches</CardTitle>
              <CardDescription>History of all global notifications sent</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {batches.map((batch: GlobalNotificationBatch) => {
              const statusInfo: Record<string, { label: string; description: string }> = {
                pending: { label: 'Pending', description: 'Queued, starting soon' },
                sending: { label: 'Sending', description: 'Currently being delivered' },
                completed: { label: 'Completed', description: 'All notifications sent' },
                failed: { label: 'Failed', description: 'Error occurred during sending' },
                cancelled: { label: 'Cancelled', description: 'Batch was cancelled before completion' },
              };
              const info = statusInfo[batch.status] || statusInfo.pending;
              const canCancel = batch.status === 'pending' || batch.status === 'sending';
              
              return (
              <div
                key={batch.batch_id}
                className="border rounded-lg p-4 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold">{batch.title}</h3>
                      <Badge
                        variant="outline"
                        className={statusColors[batch.status] || statusColors.pending}
                        title={info.description}
                      >
                        {info.label}
                      </Badge>
                      <Badge variant="outline" className={typeColors[batch.type] || typeColors.info}>
                        {batch.type}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">{batch.message}</p>
                    <div className="space-y-1">
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>
                          Recipients: {batch.total_recipients || batch.total_count || 0}
                        </span>
                        {batch.emails_sent_count > 0 && (
                          <span>Emails: {batch.emails_sent_count}</span>
                        )}
                        {batch.pushes_sent_count > 0 && (
                          <span>Push: {batch.pushes_sent_count}</span>
                        )}
                        {batch.created_at && (
                          <span>{formatDistanceToNow(new Date(batch.created_at), { addSuffix: true })}</span>
                        )}
                      </div>
                      {batch.status === 'pending' && (
                        <p className="text-xs text-blue-600 dark:text-blue-400">
                          ⚡ Will begin sending immediately after queue processing
                        </p>
                      )}
                      {batch.status === 'sending' && batch.started_at && (
                        <p className="text-xs text-blue-600 dark:text-blue-400">
                          🔄 Started {formatDistanceToNow(new Date(batch.started_at), { addSuffix: true })}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {canCancel && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCancel(batch.batch_id)}
                        disabled={cancelMutation.isPending}
                        className="text-destructive hover:text-destructive"
                      >
                        {cancelMutation.isPending && cancelBatchId === batch.batch_id ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Cancelling...
                          </>
                        ) : (
                          <>
                            <X className="h-4 w-4 mr-2" />
                            Cancel
                          </>
                        )}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedBatchId(batch.batch_id)}
                    >
                      <Eye className="h-4 w-4 mr-2" />
                      View Details
                    </Button>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {selectedBatchId && (
        <AdminNotificationBatchDialog
          batchId={selectedBatchId}
          isOpen={!!selectedBatchId}
          onClose={() => setSelectedBatchId(null)}
        />
      )}

      <AlertDialog open={!!cancelBatchId} onOpenChange={(open) => !open && setCancelBatchId(null)}>
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
              onClick={confirmCancel}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelMutation.isPending ? 'Cancelling...' : 'Cancel Batch'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

