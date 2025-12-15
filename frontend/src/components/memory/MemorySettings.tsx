'use client';

import { useState } from 'react';
import { Brain, Trash2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { MemoryList } from './MemoryList';
import { useMemories, useMemoryStats, useDeleteMemory, useDeleteAllMemories, useUpdateMemorySettings } from '@/hooks/memory/use-memory';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export function MemorySettings() {
  const t = useTranslations('settings.memory');
  const tCommon = useTranslations('common');
  const [page, setPage] = useState(1);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const { data: stats, isLoading: statsLoading } = useMemoryStats();
  const { data: memoriesData, isLoading: memoriesLoading, error: memoriesError } = useMemories(page);
  const deleteMemory = useDeleteMemory();
  const deleteAllMemories = useDeleteAllMemories();
  const updateMemorySettings = useUpdateMemorySettings();

  const handleDeleteMemory = async (memoryId: string) => {
    setDeletingIds((prev) => new Set(prev).add(memoryId));
    try {
      await deleteMemory.mutateAsync(memoryId);
    } finally {
      setDeletingIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(memoryId);
        return newSet;
      });
    }
  };

  const handleDeleteAll = async () => {
    await deleteAllMemories.mutateAsync();
  };

  const usagePercentage = stats
    ? stats.max_memories > 0
      ? (stats.total_memories / stats.max_memories) * 100
      : 0
    : 0;

  const isEnabled = stats && stats.max_memories > 0;

  const circumference = 2 * Math.PI * 58;
  const strokeDashoffset = circumference - (usagePercentage / 100) * circumference;

  if (statsLoading) {
    return (
      <div className="p-4 sm:p-6 pb-12 sm:pb-6 space-y-5 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
        <Skeleton className="h-8 w-48" />
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 pb-12 sm:pb-6 space-y-5 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
      <div>
        <div className="flex items-start justify-between mb-6">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10">
                <Brain className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">{t('title')}</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {t('description')}
                </p>
              </div>
            </div>
          </div>
        </div>
        {isEnabled && (
          <div className="flex items-center justify-between mb-4 p-4 rounded-xl border border-border bg-card">
            <div className="space-y-0.5">
              <Label htmlFor="memory-toggle" className="text-sm font-medium">
                {t('enableMemory') || 'Enable Memory'}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('enableMemoryDescription') || 'Allow Kortix to remember information from your conversations'}
              </p>
            </div>
            <Switch
              id="memory-toggle"
              checked={stats?.memory_enabled ?? true}
              onCheckedChange={(checked) => updateMemorySettings.mutate(checked)}
              disabled={updateMemorySettings.isPending}
            />
          </div>
        )}

        <div className="space-y-6">
          {!isEnabled ? (
            <Alert>
              <Sparkles className="h-4 w-4" />
              <AlertDescription className="text-sm">
                {t('notAvailable')}
              </AlertDescription>
            </Alert>
          ) : !stats?.memory_enabled ? (
            <Alert>
              <Brain className="h-4 w-4" />
              <AlertDescription className="text-sm">
                {t('memoryDisabledByUser') || 'Memory is currently disabled. Enable it above to start building memories from your conversations.'}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
                <div className="relative flex items-center justify-center flex-shrink-0">
                  <svg 
                    className="transform -rotate-90" 
                    width="140" 
                    height="140"
                  >
                    <circle
                      cx="70"
                      cy="70"
                      r="58"
                      stroke="currentColor"
                      strokeWidth="10"
                      fill="none"
                      className="text-muted-foreground/20"
                    />
                    <circle
                      cx="70"
                      cy="70"
                      r="58"
                      stroke="url(#gradient)"
                      strokeWidth="10"
                      fill="none"
                      strokeLinecap="round"
                      strokeDasharray={circumference}
                      strokeDashoffset={strokeDashoffset}
                      className="transition-all duration-700 ease-in-out"
                    />
                    <defs>
                      <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" style={{ stopColor: 'hsl(var(--primary))' }} />
                        <stop offset="100%" style={{ stopColor: 'hsl(var(--primary))', stopOpacity: 0.5 }} />
                      </linearGradient>
                    </defs>
                  </svg>
                  
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <div className="text-2xl sm:text-3xl font-bold">
                      {stats.total_memories}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      of {stats.max_memories}
                    </div>
                  </div>
                </div>

                <div className="flex-1 space-y-4 w-full">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">{t('usage')}</span>
                      <span className="text-sm text-muted-foreground">
                        {Math.round(usagePercentage)}%
                      </span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-primary transition-all duration-700 ease-in-out rounded-full"
                        style={{ width: `${usagePercentage}%` }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:gap-4">
                    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-3 sm:p-4">
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">{tCommon('active')}</div>
                        <div className="text-xl sm:text-2xl font-semibold">{stats.total_memories}</div>
                      </div>
                    </div>
                    
                    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-3 sm:p-4">
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Available</div>
                        <div className="text-xl sm:text-2xl font-semibold">
                          {stats.max_memories - stats.total_memories}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {isEnabled && stats?.memory_enabled && memoriesData && memoriesData.memories.length > 0 && (
        <div className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-medium">{t('yourMemories')}</h3>
              <p className="text-sm text-muted-foreground mt-0.5">
                {t('yourMemoriesDescription')}
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleteAllMemories.isPending}
                  className="h-9"
                >
                  <Trash2 className="h-4 w-4" />
                  {t('clearAll')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('deleteAllTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('deleteAllDescription', { count: stats?.total_memories })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDeleteAll}
                    className="bg-destructive hover:bg-destructive/90 text-white"
                  >
                    {t('deleteAllButton')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
          <MemoryList
            memories={memoriesData.memories}
            isLoading={memoriesLoading}
            error={memoriesError?.message}
            onDelete={handleDeleteMemory}
            deletingIds={deletingIds}
            hasMore={memoriesData.page < memoriesData.pages}
            onLoadMore={() => setPage((p) => p + 1)}
          />
        </div>
      )}
    </div>
  );
}
