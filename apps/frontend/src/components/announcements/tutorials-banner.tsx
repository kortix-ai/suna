'use client';

import * as React from 'react';
import { useState, useEffect } from 'react';
import { X, BookOpen, Play, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';

const STORAGE_KEY = 'kortix-tutorials-banner-dismissed';

export function TutorialsBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    setMounted(true);
    
    // Only show for logged-in users who haven't dismissed
    if (!user) return;
    
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (dismissed) return;
    
    // Show banner after a short delay
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 2000);
    
    return () => clearTimeout(timer);
  }, [user]);

  const handleClose = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsVisible(false);
    localStorage.setItem(STORAGE_KEY, 'true');
  };

  if (!mounted || !isVisible || !user) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.95 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="fixed bottom-4 right-4 z-[100] w-[320px]"
      >
        <Link href="/tutorials" className="block">
          <div className="relative bg-white dark:bg-[#2a2a2a] rounded-xl shadow-xl overflow-hidden border border-border/60 dark:border-[#232324] hover:border-primary/30 transition-colors group">
            {/* Close button */}
            <button
              onClick={handleClose}
              className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-black/10 hover:bg-black/20 dark:bg-black/80 dark:hover:bg-black transition-colors"
            >
              <X className="h-3 w-3 text-foreground dark:text-white" />
            </button>

            {/* Illustration area */}
            <div className="relative h-[100px] bg-gradient-to-br from-primary/10 via-primary/5 to-transparent dark:from-primary/20 dark:via-primary/10 dark:to-transparent flex items-center justify-center overflow-hidden">
              {/* Decorative circles */}
              <div className="absolute -top-4 -right-4 w-24 h-24 bg-primary/10 rounded-full blur-xl" />
              <div className="absolute -bottom-4 -left-4 w-20 h-20 bg-primary/5 rounded-full blur-lg" />
              
              {/* Chapter badges floating */}
              <div className="relative flex items-center gap-2">
                <motion.div 
                  initial={{ y: 0 }}
                  animate={{ y: [-2, 2, -2] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                  className="w-10 h-10 bg-background dark:bg-[#1a1a1a] rounded-lg flex items-center justify-center shadow-md border border-border/50"
                >
                  <span className="text-sm font-bold text-primary">1</span>
                </motion.div>
                <motion.div 
                  initial={{ y: 0 }}
                  animate={{ y: [2, -2, 2] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
                  className="w-10 h-10 bg-background dark:bg-[#1a1a1a] rounded-lg flex items-center justify-center shadow-md border border-border/50"
                >
                  <span className="text-sm font-bold text-primary">2</span>
                </motion.div>
                <motion.div 
                  initial={{ y: 0 }}
                  animate={{ y: [-2, 2, -2] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut", delay: 1 }}
                  className="w-10 h-10 bg-background dark:bg-[#1a1a1a] rounded-lg flex items-center justify-center shadow-md border border-border/50"
                >
                  <span className="text-sm font-bold text-primary">3</span>
                </motion.div>
                <div className="w-8 h-8 bg-primary/20 rounded-lg flex items-center justify-center">
                  <span className="text-xs font-medium text-primary">+4</span>
                </div>
              </div>
            </div>

            {/* Content area */}
            <div className="p-4 bg-muted/50 dark:bg-[#161618]">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <BookOpen className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-foreground dark:text-white text-sm font-semibold mb-1">
                    New to Kortix? Start here
                  </h3>
                  <p className="text-muted-foreground dark:text-white/60 text-xs leading-relaxed">
                    7 interactive tutorials to help you master every feature
                  </p>
                </div>
              </div>

              {/* CTA Button */}
              <div className="mt-3 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Play className="w-3 h-3" />
                  <span>Interactive walkthroughs</span>
                </div>
                <div className="flex items-center gap-1 text-xs font-medium text-primary group-hover:gap-2 transition-all">
                  <span>View tutorials</span>
                  <ArrowRight className="w-3 h-3" />
                </div>
              </div>
            </div>
          </div>
        </Link>
      </motion.div>
    </AnimatePresence>
  );
}
