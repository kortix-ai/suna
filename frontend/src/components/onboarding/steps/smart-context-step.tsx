'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { StepWrapper } from '../shared/step-wrapper';
import { userContext, updateUserContext } from '../shared/context';
import type { UserContext } from '../shared/types';

export const SmartContextStep = () => {
  const [localContext, setLocalContext] = useState<UserContext>(userContext);
  const [isExtracting, setIsExtracting] = useState(false);

  const updateContext = (updates: Partial<UserContext>) => {
    const newContext = { ...localContext, ...updates };
    setLocalContext(newContext);
    updateUserContext(newContext);
  };

  // Simulate website content extraction
  const extractWebsiteContext = async (url: string) => {
    if (!url || isExtracting) return;
    
    setIsExtracting(true);
    
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Mock extracted data
    const mockExtracted = {
      businessType: "Digital Agency",
      services: ["SEO", "Content Marketing", "Social Media", "Analytics"],
      size: "Small Agency (10-25 people)"
    };
    
    updateContext({ 
      extractedContext: mockExtracted,
      industry: mockExtracted.businessType,
      companySize: mockExtracted.size,
      primaryGoals: mockExtracted.services
    });
    setIsExtracting(false);
  };

  // Auto-progress after context is filled
  useEffect(() => {
    const hasBasicInfo = localContext.websiteUrl && localContext.websiteUrl.trim().length > 10;
    
    if (hasBasicInfo) {
      // Auto-advance after a short delay
      const timer = setTimeout(() => {
        // This would trigger the next step in the parent component
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [localContext]);


  return (
    <StepWrapper>
      <div className="text-center space-y-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h2 className="text-4xl font-bold mb-4">
            {localContext.userType === 'company' ? 'Tell us about your company' : 'Tell us about yourself'}
          </h2>
          <p className="text-lg text-muted-foreground mb-8">
            {localContext.userType === 'company' 
              ? 'Help us understand your business better'
              : 'Help us understand what you do'}
          </p>
        </motion.div>

        <div className="w-full max-w-2xl mx-auto space-y-6">
          {/* Main description textarea */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="space-y-3"
          >
            <Label htmlFor="description" className="text-base font-semibold text-center block">
              {localContext.userType === 'company' ? 'What does your company do?' : 'What do you do?'}
            </Label>
            <div className="relative">
              <Textarea
                id="description"
                placeholder={localContext.userType === 'company' 
                  ? "Share your company website or describe what you do...\n\nExamples:\n• https://yourcompany.com\n• We help B2B SaaS companies scale their growth\n• Digital marketing agency for startups"
                  : "Share your website or describe what you do...\n\nExamples:\n• https://myportfolio.com\n• Freelance graphic designer specializing in branding\n• Help small businesses with digital marketing"
                }
                value={localContext.websiteUrl || ''}
                onChange={(e) => updateContext({ websiteUrl: e.target.value })}
                onBlur={(e) => extractWebsiteContext(e.target.value)}
                className="min-h-[120px] text-base leading-relaxed border-2 focus:border-primary transition-colors resize-none"
                rows={5}
              />
              {isExtracting && (
                <div className="absolute top-3 right-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground bg-background/80 backdrop-blur-sm px-2 py-1 rounded-md">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Analyzing...
                  </div>
                </div>
              )}
            </div>
            
            {localContext.extractedContext && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.3 }}
                className="mt-4 p-4 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/20 dark:to-emerald-950/20 rounded-xl border border-green-200 dark:border-green-800"
              >
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-2 w-2 bg-green-500 rounded-full animate-pulse" />
                  <p className="text-sm font-semibold text-green-800 dark:text-green-300">
                    Great! Here's what we learned:
                  </p>
                </div>
                <div className="grid gap-2 text-sm">
                  <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                    <span className="font-medium">Focus:</span>
                    <span>{localContext.extractedContext.businessType}</span>
                  </div>
                  <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                    <span className="font-medium">Scale:</span>
                    <span>{localContext.extractedContext.size}</span>
                  </div>
                  <div className="flex items-start gap-2 text-green-700 dark:text-green-400">
                    <span className="font-medium">Areas:</span>
                    <span>{localContext.extractedContext.services?.join(', ')}</span>
                  </div>
                </div>
              </motion.div>
            )}
          </motion.div>

          {/* Progress indicator */}
          {localContext.websiteUrl && localContext.websiteUrl.trim().length > 10 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="text-center mt-6"
            >
              <div className="inline-flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-primary/10 to-primary/5 rounded-full border border-primary/20">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
                  <div className="w-2 h-2 bg-primary/60 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }} />
                  <div className="w-2 h-2 bg-primary/30 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }} />
                </div>
                <span className="text-sm font-medium text-primary">
                  Perfect! Ready to find your AI assistants
                </span>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </StepWrapper>
  );
};

