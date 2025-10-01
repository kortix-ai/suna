'use client';

import { CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ProgressIndicatorProps {
  steps: { id: string; title: string }[];
  currentStep: number;
  className?: string;
}

export const ProgressIndicator = ({ steps, currentStep, className }: ProgressIndicatorProps) => {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {steps.map((step, index) => (
        <div key={step.id} className="flex items-center">
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
          {index < steps.length - 1 && (
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
  );
};

