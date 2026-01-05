'use client';

import { useState } from 'react';
import { AlertCircle, Brain, Search } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { MemoryCard } from './MemoryCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Memory } from '@/lib/api/memory';
import { useTranslations } from 'next-intl';

interface MemoryListProps {
  memories: Memory[];
  isLoading: boolean;
  error?: string | null;
  onDelete: (memoryId: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  deletingIds?: Set<string>;
}

export function MemoryList({
  memories,
  isLoading,
  error,
  onDelete,
  onLoadMore,
  hasMore,
  deletingIds = new Set(),
}: MemoryListProps) {
  const t = useTranslations('settings.memory');
  const tCommon = useTranslations('common');
  const [filterType, setFilterType] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredMemories = memories.filter((memory) => {
    const matchesType = filterType === 'all' || memory.memory_type === filterType;
    const matchesSearch = searchQuery === '' || 
      memory.content.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesType && matchesSearch;
  });

  if (error) {
    return (
      <Alert variant="destructive" className="rounded-xl">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {isLoading && memories.length === 0 ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : filteredMemories.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="relative mb-4">
            <div className="absolute inset-0 blur-2xl bg-primary/10 rounded-full" />
            <Brain className="relative h-12 w-12 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">
            {searchQuery || filterType !== 'all' ? t('noMatchingMemories') : t('noMemoriesYet')}
          </h3>
          <p className="text-sm text-muted-foreground max-w-md">
            {searchQuery || filterType !== 'all'
              ? t('adjustFilters')
              : t('noMemoriesDescription')}
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3">
            {filteredMemories.map((memory) => (
              <MemoryCard
                key={memory.memory_id}
                memory={memory}
                onDelete={onDelete}
                isDeleting={deletingIds.has(memory.memory_id)}
              />
            ))}
          </div>

          {hasMore && onLoadMore && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={onLoadMore}
                disabled={isLoading}
                className="rounded-xl"
              >
                {isLoading ? (
                  <>
                    <KortixLoader size="small" className="mr-2" />
                    {tCommon('loading')}
                  </>
                ) : (
                  t('loadMore')
                )}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
