'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Star, MessageSquare, TrendingUp, TrendingDown, Users } from 'lucide-react';
import { useAdminFeedbackStats, useAdminSentimentSummary } from '@/hooks/admin/use-admin-feedback';

export function FeedbackStatsCards() {
  const { data: stats, isLoading: statsLoading } = useAdminFeedbackStats();
  const { data: sentiment, isLoading: sentimentLoading } = useAdminSentimentSummary();

  const renderStarRating = (rating: number) => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0.5">
          {[...Array(5)].map((_, i) => {
            if (i < fullStars) {
              return <Star key={i} className="h-5 w-5 fill-yellow-500 text-yellow-500" />;
            } else if (i === fullStars && hasHalfStar) {
              return <Star key={i} className="h-5 w-5 fill-yellow-500 text-yellow-500" style={{ clipPath: 'inset(0 50% 0 0)' }} />;
            } else {
              return <Star key={i} className="h-5 w-5 text-muted-foreground/30" />;
            }
          })}
        </div>
        <span className="text-2xl font-bold tabular-nums">{rating.toFixed(2)}</span>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Average Rating
          </CardTitle>
          <Star className="h-4 w-4 text-yellow-500" />
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <Skeleton className="h-10 w-32" />
          ) : (
            renderStarRating(stats?.average_rating || 0)
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Total Feedback
          </CardTitle>
          <Users className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <Skeleton className="h-10 w-20" />
          ) : (
            <div className="text-2xl font-bold tabular-nums">
              {(stats?.total_feedback || 0).toLocaleString()}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            With Comments
          </CardTitle>
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <Skeleton className="h-10 w-20" />
          ) : (
            <div className="flex flex-col">
              <div className="text-2xl font-bold tabular-nums">
                {(stats?.total_with_text || 0).toLocaleString()}
              </div>
              {stats && stats.total_feedback > 0 && (
                <div className="text-xs text-muted-foreground">
                  {Math.round((stats.total_with_text / stats.total_feedback) * 100)}% of total
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Positive (4-5★)
          </CardTitle>
          <TrendingUp className="h-4 w-4 text-blue-500" />
        </CardHeader>
        <CardContent>
          {sentimentLoading ? (
            <Skeleton className="h-10 w-20" />
          ) : (
            <div className="flex flex-col">
              <div className="text-2xl font-bold tabular-nums text-blue-600 dark:text-blue-400">
                {sentiment?.positive_percentage || 0}%
              </div>
              <div className="text-xs text-muted-foreground">
                {(sentiment?.positive || 0).toLocaleString()} reviews
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Negative (1-2.5★)
          </CardTitle>
          <TrendingDown className="h-4 w-4 text-red-500" />
        </CardHeader>
        <CardContent>
          {sentimentLoading ? (
            <Skeleton className="h-10 w-20" />
          ) : (
            <div className="flex flex-col">
              <div className="text-2xl font-bold tabular-nums text-red-600 dark:text-red-400">
                {sentiment?.negative_percentage || 0}%
              </div>
              <div className="text-xs text-muted-foreground">
                {(sentiment?.negative || 0).toLocaleString()} reviews
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
