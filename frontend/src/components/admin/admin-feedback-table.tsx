'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, DataTableColumn } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Pagination } from '@/components/agents/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { Star, Mail, ExternalLink } from 'lucide-react';
import { useAdminFeedbackList } from '@/hooks/admin/use-admin-feedback';
import type { FeedbackWithUser } from '@/hooks/admin/use-admin-feedback';

export function AdminFeedbackTable() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [ratingFilter, setRatingFilter] = useState<string>('all');
  const [hasTextFilter, setHasTextFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState('created_at');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  
  const { data: feedbackListResponse, isLoading, error } = useAdminFeedbackList({
    page,
    page_size: pageSize,
    rating_filter: ratingFilter && ratingFilter !== 'all' ? parseFloat(ratingFilter) : undefined,
    has_text: hasTextFilter === 'with_text' ? true : hasTextFilter === 'without_text' ? false : undefined,
    sort_by: sortBy,
    sort_order: sortOrder,
  });

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const renderStars = (rating: number) => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 !== 0;
    
    return (
      <div className="flex items-center gap-1">
        {[...Array(5)].map((_, i) => {
          if (i < fullStars) {
            return <Star key={i} className="h-4 w-4 fill-yellow-500 text-yellow-500" />;
          } else if (i === fullStars && hasHalfStar) {
            return <Star key={i} className="h-4 w-4 fill-yellow-500 text-yellow-500" style={{ clipPath: 'inset(0 50% 0 0)' }} />;
          } else {
            return <Star key={i} className="h-4 w-4 text-muted-foreground" />;
          }
        })}
        <span className="ml-1 text-sm font-medium">{rating.toFixed(1)}</span>
      </div>
    );
  };

  const columns: DataTableColumn<FeedbackWithUser>[] = useMemo(() => [
    {
      id: 'rating',
      header: 'Rating',
      cell: (feedback) => renderStars(feedback.rating),
      width: 'w-48',
    },
    {
      id: 'user',
      header: 'User',
      cell: (feedback) => (
        <div className="flex flex-col gap-1 min-w-[200px]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{feedback.user_email}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={(e) => {
                e.stopPropagation();
                window.location.href = `mailto:${feedback.user_email}`;
              }}
              title={`Email ${feedback.user_email}`}
            >
              <Mail className="h-3 w-3" />
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            {formatDate(feedback.created_at)}
          </div>
        </div>
      ),
    },
    {
      id: 'feedback',
      header: 'Feedback',
      cell: (feedback) => (
        <div className="max-w-md">
          {feedback.feedback_text ? (
            <div className="text-sm text-foreground line-clamp-2" title={feedback.feedback_text}>
              {feedback.feedback_text}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground italic">No feedback text</span>
          )}
        </div>
      ),
    },
    {
      id: 'thread',
      header: 'Thread',
      cell: (feedback) => (
        <div>
          {feedback.thread_id ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2"
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/agents/${feedback.thread_id}`);
              }}
              title={`View thread ${feedback.thread_id.substring(0, 8)}...`}
            >
              <ExternalLink className="h-3 w-3" />
              View Chat
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground italic">No thread</span>
          )}
        </div>
      ),
      width: 'w-40',
    },
    {
      id: 'help_improve',
      header: 'Allow Contact',
      cell: (feedback) => (
        <Badge variant={feedback.help_improve ? "default" : "secondary"}>
          {feedback.help_improve ? 'Yes' : 'No'}
        </Badge>
      ),
      width: 'w-32',
    },
  ], [router]);

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  const handleClearFilters = () => {
    setRatingFilter('all');
    setHasTextFilter('all');
    setPage(1);
  };

  if (error) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-destructive">
            Failed to load feedback: {error.message}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row gap-4">
        <div className="flex-1 space-y-2">
          <Label className="text-sm font-medium text-muted-foreground">Filter by Rating</Label>
          <Select value={ratingFilter} onValueChange={(value) => { setRatingFilter(value); setPage(1); }}>
            <SelectTrigger>
              <SelectValue placeholder="All ratings" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All ratings</SelectItem>
              <SelectItem value="5.0">5 stars</SelectItem>
              <SelectItem value="4.5">4.5 stars</SelectItem>
              <SelectItem value="4.0">4 stars</SelectItem>
              <SelectItem value="3.5">3.5 stars</SelectItem>
              <SelectItem value="3.0">3 stars</SelectItem>
              <SelectItem value="2.5">2.5 stars</SelectItem>
              <SelectItem value="2.0">2 stars</SelectItem>
              <SelectItem value="1.5">1.5 stars</SelectItem>
              <SelectItem value="1.0">1 star</SelectItem>
              <SelectItem value="0.5">0.5 stars</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 space-y-2">
          <Label className="text-sm font-medium text-muted-foreground">Filter by Feedback Text</Label>
          <Select value={hasTextFilter} onValueChange={(value) => { setHasTextFilter(value); setPage(1); }}>
            <SelectTrigger>
              <SelectValue placeholder="All feedback" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All feedback</SelectItem>
              <SelectItem value="with_text">With text</SelectItem>
              <SelectItem value="without_text">Without text</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 space-y-2">
          <Label className="text-sm font-medium text-muted-foreground">Sort By</Label>
          <Select value={sortBy} onValueChange={(value) => { setSortBy(value); setPage(1); }}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="created_at">Date Created</SelectItem>
              <SelectItem value="rating">Rating</SelectItem>
              <SelectItem value="updated_at">Last Updated</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 space-y-2">
          <Label className="text-sm font-medium text-muted-foreground">Order</Label>
          <Select value={sortOrder} onValueChange={(value) => { setSortOrder(value as 'asc' | 'desc'); setPage(1); }}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">Descending</SelectItem>
              <SelectItem value="asc">Ascending</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {(ratingFilter !== 'all' || hasTextFilter !== 'all') && (
          <div className="flex items-end">
            <Button variant="outline" onClick={handleClearFilters}>
              Clear Filters
            </Button>
          </div>
        )}
      </div>

      <Card className='border-0 shadow-none bg-transparent'>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center space-x-4">
                  <Skeleton className="h-12 w-full" />
                </div>
              ))}
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={feedbackListResponse?.data || []}
              emptyMessage="No feedback found matching your criteria"
              getItemId={(feedback) => feedback.feedback_id}
            />
          )}
        </CardContent>
      </Card>

      {feedbackListResponse?.pagination && (
        <Pagination
          currentPage={feedbackListResponse.pagination.current_page}
          totalPages={feedbackListResponse.pagination.total_pages}
          totalItems={feedbackListResponse.pagination.total_items}
          pageSize={feedbackListResponse.pagination.page_size}
          onPageChange={handlePageChange}
          showPageSizeSelector={false}
          showJumpToPage={true}
        />
      )}
    </div>
  );
}

