'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Pagination } from '@/components/agents/pagination';
import { DataTable, DataTableColumn } from '@/components/ui/data-table';
import { toast } from '@/lib/toast';
import { ExternalLink, Languages, Search } from 'lucide-react';
import {
  useThreadBrowser,
  useTranslate,
  type ThreadAnalytics,
  type ThreadBrowseParams,
} from '@/hooks/admin/use-admin-analytics';
import { UserEmailLink } from './user-email-link';
import type { ThreadBrowserProps } from '../types';

export function ThreadBrowser({
  categoryFilter,
  tierFilter,
  filterDateFrom,
  filterDateTo,
  onClearCategory,
  onClearTier,
  onUserClick
}: ThreadBrowserProps) {
  const [params, setParams] = useState<ThreadBrowseParams>({
    page: 1,
    page_size: 15,
    sort_by: 'created_at',
    sort_order: 'desc',
  });
  const [emailSearch, setEmailSearch] = useState('');
  const [messageFilter, setMessageFilter] = useState<string>('all');
  const [translations, setTranslations] = useState<Record<string, string>>({});

  // Reset page when filters change
  const prevCategoryRef = useRef(categoryFilter);
  const prevTierRef = useRef(tierFilter);
  const prevDateFromRef = useRef(filterDateFrom);
  const prevDateToRef = useRef(filterDateTo);

  useEffect(() => {
    const changed = prevCategoryRef.current !== categoryFilter ||
      prevTierRef.current !== tierFilter ||
      prevDateFromRef.current !== filterDateFrom ||
      prevDateToRef.current !== filterDateTo;

    if (changed) setParams(p => ({ ...p, page: 1 }));

    prevCategoryRef.current = categoryFilter;
    prevTierRef.current = tierFilter;
    prevDateFromRef.current = filterDateFrom;
    prevDateToRef.current = filterDateTo;
  }, [categoryFilter, tierFilter, filterDateFrom, filterDateTo]);

  const queryParams: ThreadBrowseParams = {
    ...params,
    category: categoryFilter || undefined,
    tier: tierFilter || undefined,
    date_from: filterDateFrom || undefined,
    date_to: filterDateTo || undefined,
  };

  const { data: threadsData, isLoading } = useThreadBrowser(queryParams);
  const translateMutation = useTranslate();

  const handleFilterChange = (filter: string) => {
    setMessageFilter(filter);
    const newParams = { ...params, page: 1 };

    switch (filter) {
      case '1':
        newParams.min_messages = 1;
        newParams.max_messages = 1;
        break;
      case '2-3':
        newParams.min_messages = 2;
        newParams.max_messages = 3;
        break;
      case '5+':
        newParams.min_messages = 5;
        newParams.max_messages = undefined;
        break;
      default:
        newParams.min_messages = undefined;
        newParams.max_messages = undefined;
    }

    setParams(newParams);
  };

  const handleEmailSearch = () => {
    setParams({ ...params, search_email: emailSearch || undefined, page: 1 });
  };

  const handleTranslate = async (threadId: string, text: string) => {
    try {
      const result = await translateMutation.mutateAsync({ text });
      setTranslations(prev => ({ ...prev, [threadId]: result.translated }));
      toast.success('Translated');
    } catch (error: any) {
      toast.error(error.message || 'Failed to translate');
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const columns: DataTableColumn<ThreadAnalytics>[] = useMemo(() => [
    {
      id: 'thread',
      header: 'Thread',
      cell: (thread) => (
        <div className="min-w-[220px]">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate max-w-[180px]">
              {thread.project_name || 'Untitled'}
            </span>
            {thread.is_public && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">Public</Badge>
            )}
          </div>
          <div className="text-xs mt-0.5">
            <UserEmailLink email={thread.user_email} onUserClick={onUserClick} />
          </div>
        </div>
      ),
    },
    {
      id: 'messages',
      header: 'Msgs',
      cell: (thread) => (
        <div className="text-center">
          <div className="font-semibold">{thread.user_message_count}</div>
          <p className="text-[10px] text-muted-foreground">{thread.message_count} total</p>
        </div>
      ),
      width: 'w-16',
    },
    {
      id: 'first_message',
      header: 'First Prompt',
      cell: (thread) => {
        const translation = translations[thread.thread_id];
        const displayText = translation || thread.first_user_message;

        return (
          <div className="min-w-[280px] max-w-[360px]">
            {displayText ? (
              <div>
                <p className="text-sm line-clamp-2">{displayText}</p>
                {!translation && thread.first_user_message && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-6 text-xs px-2"
                    onClick={() => handleTranslate(thread.thread_id, thread.first_user_message!)}
                    disabled={translateMutation.isPending}
                  >
                    <Languages className="h-3 w-3 mr-1" />
                    Translate
                  </Button>
                )}
                {translation && (
                  <Badge variant="secondary" className="mt-1 text-[10px]">
                    Translated
                  </Badge>
                )}
              </div>
            ) : (
              <span className="text-muted-foreground text-sm">No messages</span>
            )}
          </div>
        );
      },
    },
    {
      id: 'created',
      header: 'Created',
      cell: (thread) => (
        <div className="text-xs text-muted-foreground whitespace-nowrap">
          {formatDate(thread.created_at)}
        </div>
      ),
      width: 'w-28',
    },
    {
      id: 'actions',
      header: '',
      cell: (thread) => (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          asChild
        >
          <a
            href={`/share/${thread.thread_id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      ),
      width: 'w-10',
    },
  ], [translations, translateMutation.isPending, onUserClick]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="rounded-xl border bg-card">
        <div className="p-4 flex items-center gap-4">
          <div className="flex-1 max-w-sm">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by email..."
                value={emailSearch}
                onChange={(e) => setEmailSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleEmailSearch()}
                className="pl-9 h-9"
              />
            </div>
          </div>

          <Select value={messageFilter} onValueChange={handleFilterChange}>
            <SelectTrigger className="w-32 h-9">
              <SelectValue placeholder="Messages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All threads</SelectItem>
              <SelectItem value="1">1 message</SelectItem>
              <SelectItem value="2-3">2-3 messages</SelectItem>
              <SelectItem value="5+">5+ messages</SelectItem>
            </SelectContent>
          </Select>

          {(categoryFilter || tierFilter) && (
            <div className="flex items-center gap-2">
              {categoryFilter && (
                <Badge variant="secondary" className="flex items-center gap-1 h-9 px-3">
                  {categoryFilter}
                  <button onClick={onClearCategory} className="ml-1 hover:text-destructive">
                    ×
                  </button>
                </Badge>
              )}
              {tierFilter && (
                <Badge variant="secondary" className="flex items-center gap-1 h-9 px-3">
                  {tierFilter}
                  <button onClick={onClearTier} className="ml-1 hover:text-destructive">
                    ×
                  </button>
                </Badge>
              )}
            </div>
          )}
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="p-4 pt-0 space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={threadsData?.data || []}
            emptyMessage="No threads found"
            getItemId={(thread) => thread.thread_id}
          />
        )}
      </div>

      {/* Pagination */}
      {threadsData?.pagination && (
        <Pagination
          currentPage={threadsData.pagination.current_page}
          totalPages={threadsData.pagination.total_pages}
          totalItems={threadsData.pagination.total_items}
          pageSize={threadsData.pagination.page_size}
          onPageChange={(page) => setParams({ ...params, page })}
          showPageSizeSelector={false}
          showJumpToPage={true}
        />
      )}
    </div>
  );
}
