'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AdminFeedbackTable } from '@/components/admin/admin-feedback-table';
import { useAdminFeedbackStats } from '@/hooks/admin/use-admin-feedback';
import { 
  Star,
  MessageSquare,
  BarChart3,
  TrendingUp
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

export default function AdminFeedbackPage() {
  const { data: stats, isLoading: statsLoading } = useAdminFeedbackStats();

  const renderStarRating = (rating: number) => {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          {[...Array(5)].map((_, i) => {
            const starValue = i + 1;
            const isFilled = rating >= starValue;
            const isHalfFilled = rating >= starValue - 0.5 && rating < starValue;
            
            return (
              <Star 
                key={i} 
                className={`h-6 w-6 ${
                  isFilled 
                    ? 'fill-yellow-500 text-yellow-500' 
                    : isHalfFilled 
                    ? 'fill-yellow-500 text-yellow-500' 
                    : 'text-muted-foreground'
                }`}
                style={isHalfFilled ? { clipPath: 'inset(0 50% 0 0)' } : undefined}
              />
            );
          })}
        </div>
        <span className="text-3xl font-bold">{rating.toFixed(2)}</span>
      </div>
    );
  };

  const getTopRatings = () => {
    if (!stats?.rating_distribution) return [];
    
    const ratings = Object.entries(stats.rating_distribution)
      .map(([rating, count]) => ({ rating: parseFloat(rating), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    
    return ratings;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-6 space-y-8">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              User Feedback - Admin
            </h1>
            <p className="text-md text-muted-foreground mt-2">
              View and analyze user feedback submissions
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Average Rating
              </CardTitle>
              <Star className="h-4 w-4 text-yellow-500" />
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <Skeleton className="h-12 w-32" />
              ) : (
                <div className="flex items-center gap-2">
                  {renderStarRating(stats?.average_rating || 0)}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Feedback
              </CardTitle>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <Skeleton className="h-12 w-20" />
              ) : (
                <div className="text-3xl font-bold">
                  {stats?.total_feedback || 0}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                With Text Feedback
              </CardTitle>
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <Skeleton className="h-12 w-20" />
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="text-3xl font-bold">
                    {stats?.total_with_text || 0}
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
                Top Ratings
              </CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <Skeleton className="h-12 w-full" />
              ) : (
                <div className="space-y-1">
                  {getTopRatings().map((item, index) => (
                    <div key={item.rating} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-1">
                        <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" />
                        <span className="font-medium">{item.rating.toFixed(1)}</span>
                      </div>
                      <Badge variant="secondary" className="text-xs">
                        {item.count}
                      </Badge>
                    </div>
                  ))}
                  {getTopRatings().length === 0 && (
                    <div className="text-sm text-muted-foreground">No data</div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="border-0 bg-transparent shadow-none">
          <CardContent className="p-0">
            <AdminFeedbackTable />
          </CardContent>
        </div>
      </div>
    </div>
  );
}
