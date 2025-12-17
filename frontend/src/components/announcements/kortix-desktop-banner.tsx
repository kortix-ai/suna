'use client';

import * as React from 'react';
import { useState, useEffect } from 'react';
import { X, Download } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

const STORAGE_KEY = 'kortix-desktop-banner-dismissed';

export function KortixDesktopBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Check if banner was previously dismissed
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (!dismissed) {
      // Show banner after a short delay
      const timer = setTimeout(() => {
        setIsVisible(true);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleClose = () => {
    setIsVisible(false);
    localStorage.setItem(STORAGE_KEY, 'true');
  };

  const handleDownload = () => {
    // Link to Kortix Desktop download page
    window.open('https://kortix.ai/desktop', '_blank');
  };

  if (!mounted) return null;

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.95 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="fixed bottom-4 right-4 z-[100] w-[280px]"
        >
          <div className="relative bg-white dark:bg-[#2a2a2a] rounded-xl shadow-xl overflow-hidden border border-border/60 dark:border-[#232324]">
            {/* Close button */}
            <button
              onClick={handleClose}
              className="absolute top-2 right-2 z-10 w-6 h-6 flex items-center justify-center rounded-full bg-black/10 hover:bg-black/20 dark:bg-black/80 dark:hover:bg-black transition-colors"
            >
              <X className="h-3 w-3 text-foreground dark:text-white" />
            </button>

            {/* Illustration area - compact */}
            <div className="relative h-[80px] bg-muted dark:bg-[#e8e4df] flex items-center justify-center">
              {/* Card/Window mockup */}
              <div className="w-[160px] h-[50px] bg-background dark:bg-white rounded-lg p-2 relative flex items-center justify-center border border-border/40 dark:border-transparent">
                {/* Left placeholder icons - 3 icons */}
                <div className="flex gap-1 absolute bottom-1.5 left-2">
                  <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                  <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                  <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                </div>
                
                {/* Kortix logo - centered */}
                <div className="w-8 h-8 bg-foreground dark:bg-[#1a1a1a] rounded-lg flex items-center justify-center">
                  <KortixLogo size={16} className="invert dark:invert" />
                </div>
                
                {/* Right placeholder icons - 3 icons */}
                <div className="flex gap-1 absolute bottom-1.5 right-2">
                  <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                  <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                  <div className="w-2.5 h-2.5 bg-muted-foreground/30 dark:bg-gray-300 rounded-sm" />
                </div>
              </div>
            </div>

            {/* Content area */}
            <div className="p-4 bg-muted/50 dark:bg-[#161618]">
              <h3 className="text-foreground dark:text-white text-sm font-semibold mb-1">
                Kortix for Desktop is here
              </h3>
              <p className="text-muted-foreground dark:text-white/60 text-xs leading-relaxed mb-3">
                Type, speak, or screenshot with Kortix—from anywhere on your Mac
              </p>

              {/* Download button */}
              <Button
                onClick={handleDownload}
                variant="outline"
                size="sm"
                className="w-full h-9 !bg-foreground hover:!bg-foreground/90 dark:!bg-white dark:hover:!bg-gray-100 !border-transparent !text-background dark:!text-black text-xs rounded-lg gap-1.5"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
