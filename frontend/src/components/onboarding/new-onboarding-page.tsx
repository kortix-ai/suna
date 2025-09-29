'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowLeft, ArrowRight, CheckCircle2, Sparkles, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { 
  onboardingSteps, 
  getStepByIndex, 
  isFirstStep, 
  isLastStep, 
  canSkipStep,
  getProgressPercentage,
  canProceedFromStep
} from './onboarding-config';
import { ProgressIndicator } from './shared/progress-indicator';
import { userContext } from './shared/context';

interface NewOnboardingPageProps {
  className?: string;
  onComplete?: () => void;
  onClose?: () => void;
}

export function NewOnboardingPage({ className, onComplete, onClose }: NewOnboardingPageProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(true);

  const currentStepData = getStepByIndex(currentStepIndex);
  const progress = getProgressPercentage(currentStepIndex);
  const isFirstStepFlag = isFirstStep(currentStepIndex);
  const isLastStepFlag = isLastStep(currentStepIndex);
  const canSkip = canSkipStep(currentStepIndex);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;
      
      if (event.key === 'ArrowLeft' && !isFirstStepFlag) {
        handlePrevious();
      } else if (event.key === 'ArrowRight' && !isLastStepFlag) {
        handleNext();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [currentStepIndex, isOpen, isFirstStepFlag, isLastStepFlag]);

  const handleNext = () => {
    if (currentStepIndex < onboardingSteps.length - 1) {
      setCurrentStepIndex(prev => prev + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrevious = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex(prev => prev - 1);
    }
  };

  const handleComplete = () => {
    setIsOpen(false);
    onComplete?.();
  };

  const handleClose = () => {
    setIsOpen(false);
    onClose?.();
  };

  const canProceed = canProceedFromStep(currentStepIndex, userContext);

  if (!isOpen || !currentStepData) {
    return null;
  }

  return (
    <div className={cn(
      "fixed inset-0 z-50 bg-background/95 backdrop-blur-sm",
      className
    )}>
      <div className="h-full flex flex-col">
        {/* Header */}
        <motion.div
          className="flex items-center justify-center px-6 py-4 border-b border-border/30 bg-background/95 backdrop-blur-sm"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
          {/* Progress indicator - perfectly centered */}
          <ProgressIndicator 
            steps={onboardingSteps.map(step => ({ id: step.id, title: step.title }))}
            currentStep={currentStepIndex}
          />
        </motion.div>

        {/* Main content */}
        <div className="flex-1 overflow-auto">
          <div className="container mx-auto px-6 py-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={currentStepData.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="h-full"
              >
                {currentStepData.content}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Footer */}
        <motion.div
          className="flex items-center justify-center px-6 py-4 border-t border-border/30 bg-background/95 backdrop-blur-sm"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.4 }}
        >
          <div className="flex items-center gap-3">
            {!isFirstStepFlag && (
              <Button
                variant="outline"
                onClick={handlePrevious}
                size="sm"
                className="h-9 px-6"
              >
                <ArrowLeft className="h-3 w-3 mr-2" />
                Back
              </Button>
            )}

            <Button
              onClick={isLastStepFlag ? handleComplete : handleNext}
              size="sm"
              className="h-9 px-6"
              disabled={!canProceed && !canSkip}
            >
              {isLastStepFlag ? (
                <>
                  Complete Setup
                  <CheckCircle2 className="h-3 w-3 ml-2" />
                </>
              ) : (
                <>
                  Continue
                  <ArrowRight className="h-3 w-3 ml-2" />
                </>
              )}
            </Button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

