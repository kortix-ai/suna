'use client';

import { ReactNode } from 'react';

interface StepWrapperProps {
  children: ReactNode;
  className?: string;
}

export const StepWrapper = ({ children, className = "" }: StepWrapperProps) => {
  return (
    <div className={`w-full ${className}`}>
      {children}
    </div>
  );
};

