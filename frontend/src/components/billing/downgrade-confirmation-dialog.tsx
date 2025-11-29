'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { backendApi } from '@/lib/api-client';
import { toast } from 'sonner';

export type DowngradeReason =
  | 'tooExpensive'
  | 'notUsingOften'
  | 'foundAlternative'
  | 'technicalIssues'
  | 'resultsNotGood'
  | 'other';

interface DowngradeConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  targetPlanName: string;
  isPending?: boolean;
}

const DOWNGRADE_REASON_KEYS: DowngradeReason[] = [
  'tooExpensive',
  'notUsingOften',
  'foundAlternative',
  'technicalIssues',
  'resultsNotGood',
  'other',
];

export function DowngradeConfirmationDialog({
  open,
  onOpenChange,
  onConfirm,
  targetPlanName,
  isPending = false,
}: DowngradeConfirmationDialogProps) {
  const t = useTranslations('billing.downgradeDialog');
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedReason, setSelectedReason] = useState<DowngradeReason | null>(null);
  const [additionalFeedback, setAdditionalFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetAndClose = () => {
    setStep(1);
    setSelectedReason(null);
    setAdditionalFeedback('');
    onOpenChange(false);
  };

  const handleNext = () => {
    setStep(2);
  };

  const handleSubmit = async () => {
    if (!selectedReason) {
      toast.error(t('pleaseSelectReason'));
      return;
    }

    setIsSubmitting(true);
    try {
      const reasonText = t(`reasons.${selectedReason}`);
      let feedbackText = `Downgrade reason: ${reasonText}`;
      if (additionalFeedback.trim()) {
        feedbackText += `\n\nAdditional feedback: ${additionalFeedback.trim()}`;
      }

      await backendApi.post('/feedback', {
        rating: 2.0,
        feedback_text: feedbackText,
        help_improve: true,
        context: {
          type: 'downgrade',
          reason: selectedReason,
          target_plan: targetPlanName,
          additional_feedback: additionalFeedback.trim() || null,
        },
      });

      console.log('[Downgrade Feedback] Submitted');
    } catch (error) {
      console.error('[Downgrade Feedback] Error:', error);
    } finally {
      setIsSubmitting(false);
      resetAndClose();
      onConfirm();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(open) => {
      if (!open) resetAndClose();
      else onOpenChange(open);
    }}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        {step === 1 ? (
          <div className="p-8">
            {/* Logo & Header */}
            <div className="flex flex-col items-center text-center mb-6">
              <div className="mb-4 p-3 rounded-2xl bg-muted/50">
                <KortixLogo size={32} variant="symbol" />
              </div>
              <DialogTitle className="text-xl font-semibold text-foreground">
                {t('confirmTitle')}
              </DialogTitle>
              <p className="text-sm text-muted-foreground mt-2">
                {t('confirmSubtitle')}
              </p>
            </div>

            {/* Content */}
            <div className="bg-muted/30 rounded-xl p-4 mb-6">
              <p className="text-sm text-muted-foreground">
                {t('confirmDescription', { planName: targetPlanName })}
              </p>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-3">
              <Button onClick={handleNext} className="w-full">
                {t('continue')}
              </Button>
              <Button variant="ghost" onClick={resetAndClose} className="w-full text-muted-foreground">
                {t('keepCurrentPlan')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-8">
            {/* Logo & Header */}
            <div className="flex flex-col items-center text-center mb-6">
              <div className="mb-4 p-3 rounded-2xl bg-muted/50">
                <KortixLogo size={32} variant="symbol" />
              </div>
              <DialogTitle className="text-xl font-semibold text-foreground">
                {t('feedbackTitle')}
              </DialogTitle>
              <p className="text-sm text-muted-foreground mt-2">
                {t('feedbackSubtitle')}
              </p>
            </div>

            {/* Feedback Options */}
            <div className="mb-6">
              <RadioGroup
                value={selectedReason || ''}
                onValueChange={(value) => setSelectedReason(value as DowngradeReason)}
                className="space-y-2"
              >
                {DOWNGRADE_REASON_KEYS.map((reasonKey) => (
                  <label
                    key={reasonKey}
                    htmlFor={reasonKey}
                    className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                      selectedReason === reasonKey 
                        ? 'border-primary bg-primary/5' 
                        : 'border-border hover:border-muted-foreground/30 hover:bg-muted/30'
                    }`}
                  >
                    <RadioGroupItem value={reasonKey} id={reasonKey} />
                    <span className="text-sm">{t(`reasons.${reasonKey}`)}</span>
                  </label>
                ))}
              </RadioGroup>
            </div>

            {/* Optional Textarea with psychological nudge */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-foreground mb-2">
                {t('whatWouldMakeYouStay')}
              </label>
              <Textarea
                placeholder={t('feedbackPlaceholder')}
                value={additionalFeedback}
                onChange={(e) => setAdditionalFeedback(e.target.value)}
                className="min-h-[100px] resize-none"
                rows={4}
              />
              <p className="text-xs text-muted-foreground mt-2">
                {t('feedbackFooter')}
              </p>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-3">
              <Button
                onClick={handleSubmit}
                disabled={!selectedReason || isSubmitting || isPending}
                className="w-full"
              >
                {isSubmitting ? t('processing') : t('confirmDowngrade')}
              </Button>
              <Button 
                variant="ghost" 
                onClick={resetAndClose} 
                disabled={isSubmitting}
                className="w-full text-muted-foreground"
              >
                {t('keepCurrentPlan')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
