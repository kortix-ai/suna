'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Pagination } from '@/components/agents/pagination';
import { DataTable, DataTableColumn } from '@/components/ui/data-table';
import { toast } from '@/lib/toast';
import { ExternalLink, Languages, Filter } from 'lucide-react';
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

  // Reset page to 1 when category/tier filter or date changes
  const prevCategoryRef = useRef(categoryFilter);
  const prevTierRef = useRef(tierFilter);
  const prevDateFromRef = useRef(filterDateFrom);
  const prevDateToRef = useRef(filterDateTo);
  useEffect(() => {
    const categoryChanged = prevCategoryRef.current !== categoryFilter;
    const tierChanged = prevTierRef.current !== tierFilter;
    const dateFromChanged = prevDateFromRef.current !== filterDateFrom;
    const dateToChanged = prevDateToRef.current !== filterDateTo;

    if (categoryChanged || tierChanged || dateFromChanged || dateToChanged) {
      setParams(p => ({ ...p, page: 1 }));
    }

    prevCategoryRef.current = categoryFilter;
    prevTierRef.current = tierFilter;
    prevDateFromRef.current = filterDateFrom;
    prevDateToRef.current = filterDateTo;
  }, [categoryFilter, tierFilter, filterDateFrom, filterDateTo]);

  // Include category/tier filter and date filter in query params
  // Always filter by date to match the distribution stats shown above
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
    let newParams = { ...params, page: 1 };

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
      toast.success('Translated to English');
    } catch (error: any) {
      toast.error(error.message || 'Failed to translate');
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const columns: DataTableColumn<ThreadAnalytics>[] = useMemo(() => [
    {
      id: 'thread',
      header: 'Thread',
      cell: (thread) => (
        <div className="min-w-[250px]">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate max-w-[200px]">
              {thread.project_name || 'Untitled'}
            </span>
            {thread.is_public && (
              <Badge variant="outline" className="text-xs">Public</Badge>
            )}
          </div>
          <div className="text-xs mt-1">
            <UserEmailLink email={thread.user_email} onUserClick={onUserClick} />
          </div>
          <p className="text-xs text-muted-foreground font-mono">
            {thread.thread_id.slice(0, 8)}...
          </p>
        </div>
      ),
    },
    {
      id: 'messages',
      header: 'Messages',
      cell: (thread) => (
        <div className="text-center">
          <div className="font-semibold">{thread.user_message_count}</div>
          <p className="text-xs text-muted-foreground">user msgs</p>
          <p className="text-xs text-muted-foreground">{thread.message_count} total</p>
        </div>
      ),
      width: 'w-24',
    },
    {
      id: 'first_message',
      header: 'First Prompt',
      cell: (thread) => {
        const translation = translations[thread.thread_id];
        const displayText = translation || thread.first_user_message;

        return (
          <div className="min-w-[300px] max-w-[400px]">
            {displayText ? (
              <div>
                <p className="text-sm line-clamp-2">{displayText}</p>
                {!translation && thread.first_user_message && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-6 text-xs"
                    onClick={() => handleTranslate(thread.thread_id, thread.first_user_message!)}
                    disabled={translateMutation.isPending}
                  >
                    <Languages className="h-3 w-3 mr-1" />
                    Translate
                  </Button>
                )}
                {translation && (
                  <Badge variant="secondary" className="mt-1 text-xs">
                    <Languages className="h-3 w-3 mr-1" />
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
        <div className="text-sm text-muted-foreground whitespace-nowrap">
          {formatDate(thread.created_at)}
        </div>
      ),
      width: 'w-36',
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (thread) => (
        <Button
          variant="outline"
          size="sm"
          asChild
        >
          <a
            href={`/share/${thread.thread_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1"
          >
            <ExternalLink className="h-3 w-3" />
            Open
          </a>
        </Button>
      ),
      width: 'w-24',
    },
  ], [translations, translateMutation.isPending, onUserClick]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[200px]">
          <Label htmlFor="email-search" className="text-sm">Search by Email</Label>
          <div className="flex gap-2 mt-1">
            <Input
              id="email-search"
              placeholder="user@example.com"
              value={emailSearch}
              onChange={(e) => setEmailSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleEmailSearch()}
            />
            <Button onClick={handleEmailSearch} variant="outline">
              Search
            </Button>
          </div>
        </div>

        <div className="w-[180px]">
          <Label className="text-sm">User Messages</Label>
          <Select value={messageFilter} onValueChange={handleFilterChange}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Filter by messages" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All threads</SelectItem>
              <SelectItem value="1">1 message only</SelectItem>
              <SelectItem value="2-3">2-3 messages</SelectItem>
              <SelectItem value="5+">5+ messages</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Active Category Filter */}
        {categoryFilter && (
          <div className="flex items-end">
            <div>
              <Label className="text-sm">Category</Label>
              <Badge variant="secondary" className="mt-1 flex items-center gap-1 h-10 px-3">
                <Filter className="h-3 w-3" />
                {categoryFilter}
                {filterDateFrom && (
                  <span className="text-muted-foreground">
                    ({filterDateFrom === filterDateTo ? filterDateFrom : `${filterDateFrom} - ${filterDateTo}`})
                  </span>
                )}
                <button
                  onClick={onClearCategory}
                  className="ml-1 hover:text-destructive"
                >
                  ×
                </button>
              </Badge>
            </div>
          </div>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="p-6 space-y-3 rounded-2xl border">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={threadsData?.data || []}
          emptyMessage="No threads found matching your criteria"
          getItemId={(thread) => thread.thread_id}
        />
      )}

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
