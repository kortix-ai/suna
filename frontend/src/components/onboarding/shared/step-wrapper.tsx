'use client';

import { motion } from 'framer-motion';
import { ReactNode } from 'react';

interface StepWrapperProps {
  children: ReactNode;
  className?: string;
}

export const StepWrapper = ({ children, className = "" }: StepWrapperProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className={`max-w-4xl mx-auto space-y-8 ${className}`}
    >
      {children}
    </motion.div>
  );
};

