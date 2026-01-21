'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAdminCriticalFeedback } from '@/hooks/admin/use-admin-feedback';
import { Star, ExternalLink, AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow, parseISO } from 'date-fns';

export function CriticalFeedbackList() {
  const router = useRouter();
  const { data: criticalFeedback, isLoading } = useAdminCriticalFeedback(10);

  const renderStars = (rating: number) => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    
    return (
      <div className="flex items-center gap-0.5">
        {[...Array(5)].map((_, i) => {
          if (i < fullStars) {
            return <Star key={i} className="h-3 w-3 fill-yellow-500 text-yellow-500" />;
          } else if (i === fullStars && hasHalfStar) {
            return <Star key={i} className="h-3 w-3 fill-yellow-500 text-yellow-500" style={{ clipPath: 'inset(0 50% 0 0)' }} />;
          } else {
            return <Star key={i} className="h-3 w-3 text-muted-foreground/30" />;
          }
        })}
        <span className="ml-1 text-xs font-medium text-red-600 dark:text-red-400">{rating.toFixed(1)}</span>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <CardTitle className="text-base font-medium">Critical Feedback</CardTitle>
        </div>
        <CardDescription>Recent low ratings that need attention</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-4 space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : !criticalFeedback || criticalFeedback.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground">
            <p className="text-sm">No critical feedback found 🎉</p>
            <p className="text-xs mt-1">Keep up the good work!</p>
          </div>
        ) : (
          <ScrollArea className="h-[350px]">
            <div className="divide-y">
              {criticalFeedback.map((feedback) => (
                <div 
                  key={feedback.feedback_id} 
                  className="p-4 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        {renderStars(feedback.rating)}
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(parseISO(feedback.created_at), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="text-sm text-foreground line-clamp-2 mb-2">
                        {feedback.feedback_text}
                      </p>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {feedback.user_email}
                        </Badge>
                        {feedback.thread_id && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => router.push(`/agents/${feedback.thread_id}`)}
                          >
                            <ExternalLink className="h-3 w-3 mr-1" />
                            View Chat
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
