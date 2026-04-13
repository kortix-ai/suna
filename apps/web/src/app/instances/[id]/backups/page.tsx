'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useQuery } from '@tanstack/react-query';
import { getSandboxById, type BackupInfo } from '@/lib/platform-client';
import { useBackups } from '@/hooks/instance/use-backups';
import { toast as sonnerToast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import {
  ArrowLeft,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  HardDrive,
  Clock,
  AlertTriangle,
  Archive,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { InstancesTopBar } from '../../_components/shared';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function BackupRow({
  backup,
  onRestore,
  onDelete,
  isRestoring,
  isDeleting,
}: {
  backup: BackupInfo;
  onRestore: () => void;
  onDelete: () => void;
  isRestoring: boolean;
  isDeleting: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-card px-4 py-3.5 group hover:border-border/70 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-foreground truncate">
            {backup.description || `Backup ${backup.id}`}
          </p>
          <div className="flex items-center gap-3 mt-1.5">
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
              <Clock className="h-3 w-3" />
              <span title={formatFullDate(backup.created)}>
                {formatDate(backup.created)}
              </span>
            </span>
            {backup.size > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                <HardDrive className="h-3 w-3" />
                {formatBytes(backup.size * 1024 * 1024 * 1024)}
              </span>
            )}
            <span
              className={cn(
                'text-[10px] font-medium px-1.5 py-px rounded-full',
                backup.status === 'available'
                  ? 'text-emerald-500/80 bg-emerald-500/10'
                  : 'text-amber-500/80 bg-amber-500/10',
              )}
            >
              {backup.status}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={onRestore}
            disabled={isRestoring || backup.status !== 'available'}
            title="Restore from this backup"
            className="flex items-center justify-center h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-lg transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {isRestoring ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            title="Delete this backup"
            className="flex items-center justify-center h-8 w-8 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {isDeleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BackupsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();

  const [description, setDescription] = useState('');
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  const { data: sandbox, isLoading: sandboxLoading } = useQuery({
    queryKey: ['platform', 'sandbox', 'detail', id],
    queryFn: () => getSandboxById(id!),
    enabled: !!user && !!id,
  });

  const {
    backups,
    backupsEnabled,
    isLoading: backupsLoading,
    create,
    restore,
    remove,
  } = useBackups(id);

  async function handleCreate() {
    try {
      await create.mutateAsync(description || undefined);
      setDescription('');
      sonnerToast.success('Backup started');
    } catch (err: any) {
      sonnerToast.error(err?.message || 'Failed to create backup');
    }
  }

  async function handleRestore(backupId: string) {
    setConfirmRestore(null);
    try {
      await restore.mutateAsync(backupId);
      sonnerToast.success('Restore initiated. Your machine will reboot with the backup data.');
    } catch (err: any) {
      sonnerToast.error(err?.message || 'Failed to restore backup');
    }
  }

  async function handleDelete(backupId: string) {
    setConfirmDelete(null);
    try {
      await remove.mutateAsync(backupId);
      sonnerToast.success('Backup deleted');
    } catch (err: any) {
      sonnerToast.error(err?.message || 'Failed to delete backup');
    }
  }

  const restoreTarget = backups.find((b) => b.id === confirmRestore);
  const deleteTarget = backups.find((b) => b.id === confirmDelete);
  const isLoading = backupsLoading || sandboxLoading;

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <InstancesTopBar
        user={user}
        leading={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/instances')}
            className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Instances
          </Button>
        }
      />

      <main className="flex-1 flex items-start justify-center px-4 pt-8 pb-20">
        <div className="w-full max-w-lg">
          {/* Header */}
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Archive className="h-5 w-5 text-muted-foreground" />
              Backups
              {backupsEnabled && (
                <span className="ml-1 flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500/90">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Auto
                </span>
              )}
            </h1>
            {sandbox && (
              <p className="text-xs text-muted-foreground mt-1.5 font-mono">
                {sandbox.name || sandbox.sandbox_id}
              </p>
            )}
          </div>

          {/* Create backup */}
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Backup description (optional)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) =>
                  e.key === 'Enter' && !create.isPending && handleCreate()
                }
                className="flex-1 h-10 text-sm px-3.5 rounded-xl bg-muted/40 border border-border/50 outline-none placeholder:text-muted-foreground/50 focus:border-primary/40 focus:bg-muted/60 transition-colors"
              />
              <Button
                onClick={handleCreate}
                disabled={create.isPending}
                className="gap-1.5 h-10"
              >
                {create.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Backup Now
              </Button>
            </div>
          </div>

          {/* Loading */}
          {isLoading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Empty state */}
          {!isLoading && backups.length === 0 && (
            <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 p-8 flex flex-col items-center gap-4">
              <div className="flex items-center justify-center h-14 w-14 rounded-xl bg-muted/50">
                <HardDrive className="h-7 w-7 text-muted-foreground/40" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground/80">No backups yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  {backupsEnabled
                    ? 'Your first automatic backup will appear here soon.'
                    : 'Create a manual backup to get started.'}
                </p>
              </div>
            </div>
          )}

          {/* Backup list */}
          {!isLoading && backups.length > 0 && (
            <div className="flex flex-col gap-2">
              {backups.map((backup) => (
                <BackupRow
                  key={backup.id}
                  backup={backup}
                  onRestore={() => setConfirmRestore(backup.id)}
                  onDelete={() => setConfirmDelete(backup.id)}
                  isRestoring={restore.isPending && restore.variables === backup.id}
                  isDeleting={remove.isPending && remove.variables === backup.id}
                />
              ))}
            </div>
          )}

          {/* Footer hint */}
          {!isLoading && backupsEnabled && backups.length > 0 && (
            <p className="text-[11px] text-muted-foreground/40 mt-4 text-center">
              Automatic daily backups are enabled. The provider retains the latest backups.
            </p>
          )}
        </div>
      </main>

      {/* Restore confirmation */}
      <AlertDialog open={!!confirmRestore} onOpenChange={() => setConfirmRestore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Restore from Backup
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will rebuild your machine from the backup
              {restoreTarget ? ` "${restoreTarget.description || `Backup ${restoreTarget.id}`}"` : ''}.
              <span className="block mt-2 font-medium text-foreground/80">
                All current data will be replaced with the backup contents. This cannot be undone.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmRestore && handleRestore(confirmRestore)}
              className="bg-amber-600 text-white hover:bg-amber-700"
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Backup</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete
              {deleteTarget ? ` "${deleteTarget.description || `Backup ${deleteTarget.id}`}"` : ' this backup'}?
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDelete && handleDelete(confirmDelete)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
