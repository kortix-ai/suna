'use client';

import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import confetti from 'canvas-confetti';
import { TierBadge } from './tier-badge';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

interface UpgradeCelebrationProps {
  isOpen: boolean;
  onClose: () => void;
  planName: string;
  isLoading?: boolean;
}

export function UpgradeCelebration({ isOpen, onClose, planName, isLoading = false }: UpgradeCelebrationProps) {
  const animationRef = useRef<number | null>(null);
  const endTimeRef = useRef<number>(0);

  useEffect(() => {
    if (isOpen) {
      // Start confetti
      const colors = ["#a786ff", "#fd8bbc", "#eca184", "#f8deb1"];
      endTimeRef.current = Date.now() + 3000;

      const frame = () => {
        if (Date.now() > endTimeRef.current) {
          animationRef.current = null;
          return;
        }

        confetti({
          particleCount: 2,
          angle: 60,
          spread: 55,
          startVelocity: 60,
          origin: { x: 0, y: 0.5 },
          colors: colors,
        });
        
        confetti({
          particleCount: 2,
          angle: 120,
          spread: 55,
          startVelocity: 60,
          origin: { x: 1, y: 0.5 },
          colors: colors,
        });

        animationRef.current = requestAnimationFrame(frame);
      };

      frame();

      // Auto-close after 4 seconds
      const closeTimer = setTimeout(onClose, 4000);

      return () => {
        clearTimeout(closeTimer);
        if (animationRef.current) {
          cancelAnimationFrame(animationRef.current);
          animationRef.current = null;
        }
        endTimeRef.current = 0;
      };
    }
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* Subtle backdrop for readability */}
          <motion.div 
            className="absolute inset-0 bg-background/60 backdrop-blur-[2px] cursor-pointer"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          
          {/* Content */}
          <motion.div
            className="relative flex flex-col items-center gap-4 pointer-events-none select-none"
            initial={{ scale: 0.8, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: -10 }}
            transition={{ 
              duration: 0.5,
              type: "spring",
              stiffness: 200,
              damping: 20
            }}
          >
            {/* Kortix Logo */}
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.05, duration: 0.3 }}
            >
              <KortixLogo size={36} variant="logomark" />
            </motion.div>

            {/* Welcome text */}
            <motion.p
              className="text-lg text-muted-foreground"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15, duration: 0.4 }}
            >
              Welcome to
            </motion.p>

            {/* Tier Badge */}
            <motion.div
              className="min-h-[40px] flex items-center justify-center"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ 
                delay: 0.25, 
                duration: 0.5, 
                type: "spring", 
                stiffness: 250,
                damping: 18 
              }}
            >
              {isLoading ? (
                <div className="h-10 w-28 rounded-lg bg-muted/50 animate-pulse" />
              ) : (
                <TierBadge 
                  planName={planName} 
                  variant="default" 
                  size="lg"
                  className="scale-150"
                />
              )}
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
