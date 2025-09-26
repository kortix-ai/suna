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
  onComplete?: () => void;
}

export function OnboardingPage({ steps, className, onComplete }: OnboardingPageProps) {
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
    if (onComplete) {
      onComplete();
    } else {
      completeOnboarding();
    }
  };

  // Keyboard navigation support
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle keyboard shortcuts if onboarding is open
      if (!isOpen) return;
      
      // Prevent default behavior for arrow keys
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
      }
      
      switch (event.key) {
        case 'ArrowLeft':
          if (!isFirstStep) {
            previousStep();
          }
          break;
        case 'ArrowRight':
          if (isLastStep) {
            handleClose();
          } else {
            handleNext();
          }
          break;
        case 'Escape':
          handleClose();
          break;
        case 'Enter':
          if (event.ctrlKey || event.metaKey) {
            if (isLastStep) {
              handleClose();
            } else {
              handleNext();
            }
          }
          break;
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);
    
    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, isFirstStep, isLastStep, previousStep, handleNext, handleClose]);

  if (!isOpen || !currentStepData) {
    return null;
  }

  return (
    <div className={cn(
      "fixed inset-0 z-50 bg-background overflow-hidden",
      className
    )}>
      <div className="flex flex-col h-screen relative overflow-hidden">
        {/* Compact Header */}
        <motion.div 
          className="flex items-center justify-between px-6 py-4 border-b border-border/30 bg-background/95 backdrop-blur-sm"
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3 }}
        >
        <div className="flex items-center gap-3">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Setup</span>
          <span className="text-xs text-muted-foreground">
            {currentStep + 1}/{storeSteps.length}
          </span>
        </div>
        
        {/* Progress stepper - centered and prominent */}
        <div className="flex items-center gap-1">
          {storeSteps.map((step, index) => (
            <div key={index} className="flex items-center">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-all duration-300",
                  index === currentStep
                    ? "bg-primary text-primary-foreground scale-110 shadow-lg"
                    : index < currentStep
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {index < currentStep ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  index + 1
                )}
              </div>
              {index < storeSteps.length - 1 && (
                <div
                  className={cn(
                    "w-6 h-0.5 mx-1 transition-all duration-300",
                    index < currentStep ? "bg-primary" : "bg-muted"
                  )}
                />
              )}
            </div>
          ))}
        </div>

          
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground h-8 w-8 p-0"
          >
            <X className="h-3 w-3" />
          </Button>
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

        {/* Compact Footer */}
        <motion.div 
          className="flex items-center justify-between px-6 py-4 border-t border-border/30 bg-background/95 backdrop-blur-sm"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.4 }}
        >
          {isFirstStep ? (
            <div /> 
          ) : (
            <Button
              variant="ghost"
              onClick={previousStep}
              size="sm"
              className="text-muted-foreground hover:text-foreground h-9"
            >
              <ArrowLeft className="h-3 w-3 mr-2" />
              Back
            </Button>
          )}

        <div className="flex items-center gap-4">
          {/* Keyboard shortcuts hint */}
          <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
            <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">←</kbd>
            <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs">→</kbd>
            <span>navigate</span>
          </div>

          <div className="flex items-center gap-2">
            {currentStepData.canSkip && !isLastStep && (
              <Button
                variant="ghost"
                onClick={nextStep}
                size="sm"
                className="text-muted-foreground hover:text-foreground h-9"
              >
                Skip
              </Button>
            )}

            <Button
              onClick={isLastStep ? handleClose : handleNext}
              size="sm"
              className="h-9 px-6"
            >
              {isLastStep ? (
                <>
                  Complete
                  <CheckCircle2 className="h-3 w-3 ml-2" />
                </>
              ) : (
                <>
                  {currentStepData.actionLabel || 'Continue'}
                  <ArrowRight className="h-3 w-3 ml-2" />
                </>
              )}
            </Button>
          </div>
        </div>
        </motion.div>
      </div>
    </div>
  );
}
