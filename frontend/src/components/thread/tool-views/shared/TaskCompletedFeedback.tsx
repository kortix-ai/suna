import React, { useState, useEffect } from 'react';
import { CheckCircle2, Star } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { PromptExamples, PromptExample } from '@/components/shared/prompt-examples';
import { backendApi } from '@/lib/api-client';
import { toast } from 'sonner';

// Flag to control whether to show prompt examples
const SHOW_PROMPT_EXAMPLES = true;

interface MessageFeedback {
  feedback_id: string;
  thread_id: string;
  message_id: string;
  rating: number;
  feedback_text: string | null;
  help_improve: boolean;
  created_at: string;
  updated_at: string;
}

interface TaskCompletedFeedbackProps {
  taskSummary?: string;
  followUpPrompts?: string[];
  onFollowUpClick?: (prompt: string) => void;
  samplePromptsTitle?: string;
  isLatestMessage?: boolean;
  threadId?: string;
  messageId?: string | null;
}

export function TaskCompletedFeedback({ 
  taskSummary,
  followUpPrompts,
  onFollowUpClick,
  samplePromptsTitle = 'Sample prompts',
  isLatestMessage = false,
  threadId,
  messageId
}: TaskCompletedFeedbackProps) {
  const t = useTranslations();
  const [rating, setRating] = useState<number | null>(null); // Can be 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5
  const [feedback, setFeedback] = useState('');
  const [helpImprove, setHelpImprove] = useState(true);
  const [showRatingModal, setShowRatingModal] = useState(false);
  const [submittedFeedback, setSubmittedFeedback] = useState<MessageFeedback | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);

  // Fetch existing feedback on mount
  useEffect(() => {
    if (threadId && messageId) {
      setIsLoadingFeedback(true);
      backendApi.get<MessageFeedback[]>(`/feedback?thread_id=${threadId}&message_id=${messageId}`)
        .then((response) => {
          if (response.success && response.data && response.data.length > 0) {
            const feedbackData = response.data[0];
            setSubmittedFeedback(feedbackData);
            setRating(feedbackData.rating);
            setFeedback(feedbackData.feedback_text || '');
            setHelpImprove(feedbackData.help_improve);
          }
        })
        .catch((error) => {
          console.error('Error fetching feedback:', error);
        })
        .finally(() => {
          setIsLoadingFeedback(false);
        });
    }
  }, [threadId, messageId]);

  // Only use prompts provided from the tool - no fallback generation
  const promptExamples: PromptExample[] = followUpPrompts && followUpPrompts.length > 0
    ? followUpPrompts.slice(0, 4).map(prompt => ({ text: prompt }))
    : [];

  const handleStarClick = (value: number) => {
    setRating(value);
    setShowRatingModal(true);
  };

  const handleSubmitRating = async () => {
    if (!rating || !threadId || !messageId) return;

    setIsSubmitting(true);
    try {
      const response = await backendApi.post<MessageFeedback>(
        `/feedback`,
        {
          rating,
          feedback_text: feedback.trim() || null,
          help_improve: helpImprove,
          thread_id: threadId,
          message_id: messageId
        }
      );

      if (response.success && response.data) {
        setSubmittedFeedback(response.data);
        setShowRatingModal(false);
        toast.success(t('thread.feedbackSubmittedSuccess'));
      } else {
        toast.error(t('thread.feedbackSubmitFailed'));
      }
    } catch (error) {
      console.error('Error submitting feedback:', error);
      toast.error(t('thread.feedbackSubmitFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div className="space-y-4 mt-4">
        {/* Task Completed Message with Rating */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
            <p className="text-sm text-muted-foreground">
              {t('thread.taskCompleted')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {!submittedFeedback && (
              <span className="text-sm text-muted-foreground">{t('thread.rateThisResult')}</span>
            )}
          <div className="flex items-center gap-0.5">
            {[1, 2, 3, 4, 5].map((value) => {
              const fullStarValue = value;
              const halfStarValue = value - 0.5;
              const currentRating = submittedFeedback?.rating ?? rating;
              const isFullStar = currentRating !== null && currentRating >= fullStarValue;
              const isHalfStar = currentRating !== null && currentRating >= halfStarValue && currentRating < fullStarValue;
              
              return (
                <div key={value} className="relative flex items-center">
                  {/* Base star for visual display */}
                  <div className="relative">
                    <Star
                      className={cn(
                        "h-4 w-4 transition-colors",
                        isFullStar
                          ? "text-yellow-500 fill-current"
                          : isHalfStar
                          ? "text-yellow-500"
                          : "text-muted-foreground/30"
                      )}
                    />
                    {/* Visual half star overlay */}
                    {isHalfStar && (
                      <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ width: '50%' }}>
                        <Star className="h-4 w-4 text-yellow-500 fill-current" />
                      </div>
                    )}
                  </div>
                  {/* Clickable overlay for half-star detection */}
                  {!submittedFeedback && (
                    <button
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickX = e.clientX - rect.left;
                        const isLeftHalf = clickX < rect.width / 2;
                        handleStarClick(isLeftHalf ? halfStarValue : fullStarValue);
                      }}
                      className="absolute inset-0 z-10 hover:scale-110 transition-transform"
                      style={{ width: '100%', height: '100%' }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          </div>
        </div>

        {/* Prompt Examples - Only show if provided from tool */}
        {SHOW_PROMPT_EXAMPLES && promptExamples.length > 0 && (
          <PromptExamples
            prompts={promptExamples}
            onPromptClick={onFollowUpClick}
            variant="text"
            showTitle={true}
            title={samplePromptsTitle}
          />
        )}
      </div>

      {/* Rating Modal */}
      <Dialog open={showRatingModal} onOpenChange={setShowRatingModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('thread.rateThisResult')}</DialogTitle>
            <DialogDescription>
              {t('thread.feedbackHelpsImprove')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Star Rating */}
            <div className="flex items-center justify-center gap-1">
              {[1, 2, 3, 4, 5].map((value) => {
                const fullStarValue = value;
                const halfStarValue = value - 0.5;
                const isFullStar = rating !== null && rating >= fullStarValue;
                const isHalfStar = rating !== null && rating >= halfStarValue && rating < fullStarValue;
                
                return (
                  <div key={value} className="relative flex items-center">
                    {/* Base star for visual display */}
                    <div className="relative">
                      <Star
                        className={cn(
                          "h-8 w-8 transition-colors",
                          isFullStar
                            ? "text-yellow-500 fill-current"
                            : isHalfStar
                            ? "text-yellow-500"
                            : "text-muted-foreground/30"
                        )}
                      />
                      {/* Visual half star overlay */}
                      {isHalfStar && (
                        <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ width: '50%' }}>
                          <Star className="h-8 w-8 text-yellow-500 fill-current" />
                        </div>
                      )}
                    </div>
                    {/* Clickable overlay for half-star detection */}
                    <button
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickX = e.clientX - rect.left;
                        const isLeftHalf = clickX < rect.width / 2;
                        setRating(isLeftHalf ? halfStarValue : fullStarValue);
                      }}
                      className="absolute inset-0 z-10 hover:scale-110 transition-transform"
                      style={{ width: '100%', height: '100%' }}
                    />
                  </div>
                );
              })}
            </div>

            {/* Feedback Textarea */}
            <div className="space-y-2">
              <Textarea
                placeholder={t('thread.additionalFeedbackOptional')}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                className="min-h-[100px] resize-none"
              />
            </div>

            {/* Help Improve Checkbox */}
            <div className="flex items-center gap-2">
              <Checkbox
                id="help-improve"
                checked={helpImprove}
                onCheckedChange={(checked) => setHelpImprove(checked === true)}
              />
              <label
                htmlFor="help-improve"
                className="text-sm text-foreground cursor-pointer"
              >
                {t('thread.helpKortixImprove')}
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRatingModal(false)} disabled={isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSubmitRating} disabled={!rating || isSubmitting}>
              {isSubmitting ? t('thread.submitting') : t('thread.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
