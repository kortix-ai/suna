'use client';

import React, { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useOnboarding, type OnboardingStep } from '@/hooks/use-onboarding';
import { cn } from '@/lib/utils';
import { ArrowLeft, ArrowRight, CheckCircle2, Sparkles, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface OnboardingPageProps {
  steps?: OnboardingStep[];
  className?: string;
}

export function OnboardingPage({ steps, className }: OnboardingPageProps) {
  const {
    isOpen,
    currentStep,
    steps: storeSteps,
    isLastStep,
    isFirstStep,
    currentStepData,
    progress,
    setIsOpen,
    nextStep,
    previousStep,
    completeOnboarding,
    setSteps,
  } = useOnboarding();

  const contentRef = useRef<HTMLDivElement>(null);

  // Set steps if provided
  useEffect(() => {
    if (steps && steps.length > 0) {
      setSteps(steps);
    }
  }, [steps, setSteps]);

  // Reset scroll when step changes
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [currentStep]);

  const handleNext = async () => {
    if (currentStepData?.onAction) {
      try {
        await currentStepData.onAction();
      } catch (error) {
        console.error('Error executing step action:', error);
      }
    }
    nextStep();
  };

  const handleClose = () => {
    completeOnboarding();
  };

  if (!isOpen || !currentStepData) {
    return null;
  }

  return (
    <div className={cn(
      "fixed inset-0 z-50 bg-background overflow-hidden",
      className
    )}>
      <div className="flex flex-col h-screen relative overflow-hidden">
        {/* Header with progress */}
        <motion.div 
          className="flex items-center justify-between p-6 border-b border-border/50 bg-background"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
          <div className="flex items-center gap-4 flex-1">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <Sparkles className="h-5 w-5 text-primary" />
                <span className="font-semibold text-foreground">Getting Started</span>
              </div>
              <span className="text-sm text-muted-foreground">
                {currentStep + 1} of {storeSteps.length}
              </span>
            </div>
            
            <div className="flex-1 max-w-md">
              <Progress 
                value={progress} 
                className="h-2 bg-muted/50"
              />
            </div>
          </div>
          
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </Button>
        </motion.div>

        {/* Step indicator */}
        <motion.div 
          className="flex items-center justify-center py-4 bg-muted/20 border-b border-border/30"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
        >
          <div className="flex items-center gap-2">
            {storeSteps.map((_, index) => (
              <div
                key={index}
                className={cn(
                  "flex items-center justify-center w-8 h-8 rounded-full text-xs font-medium transition-all duration-300",
                  index === currentStep
                    ? "bg-primary text-primary-foreground scale-110"
                    : index < currentStep
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {index < currentStep ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  index + 1
                )}
              </div>
            ))}
          </div>
        </motion.div>

        {/* Content */}
        <div 
          ref={contentRef}
          className="flex-1 overflow-y-auto scroll-smooth"
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep}
              initial={{ x: 20, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: -20, opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="p-8"
            >
              {/* Step header */}
              <div className="text-center mb-8 max-w-2xl mx-auto">
                <motion.h2 
                  className="text-3xl font-bold text-foreground mb-4"
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.1 }}
                >
                  {currentStepData.title}
                </motion.h2>
                <motion.p 
                  className="text-lg text-muted-foreground"
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                >
                  {currentStepData.description}
                </motion.p>
              </div>

              {/* Step content */}
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="max-w-4xl mx-auto"
              >
                {currentStepData.content}
              </motion.div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer */}
        <motion.div 
          className="flex items-center justify-between p-6 border-t border-border/50 bg-background"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.4 }}
        >
          <Button
            variant="outline"
            onClick={previousStep}
            disabled={isFirstStep}
            className="flex items-center gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Previous
          </Button>

          <div className="flex items-center gap-3">
            {currentStepData.canSkip && !isLastStep && (
              <Button
                variant="ghost"
                onClick={nextStep}
                className="text-muted-foreground hover:text-foreground"
              >
                Skip
              </Button>
            )}
            
            <Button
              onClick={isLastStep ? completeOnboarding : handleNext}
              className="flex items-center gap-2 min-w-[120px]"
            >
              {isLastStep ? (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  Complete
                </>
              ) : (
                <>
                  {currentStepData.actionLabel || 'Next'}
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
