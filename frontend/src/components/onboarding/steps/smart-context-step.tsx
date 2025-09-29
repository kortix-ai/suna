'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Building2, User, Globe, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StepWrapper } from '../shared/step-wrapper';
import { userContext, updateUserContext } from '../shared/context';
import { UserContext } from '../shared/types';

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
    const hasBasicInfo = localContext.userType && (localContext.name || localContext.userType === 'company');
    const hasGoals = localContext.primaryGoals && localContext.primaryGoals.length > 0;
    
    if (hasBasicInfo && hasGoals) {
      // Auto-advance after a short delay
      const timer = setTimeout(() => {
        // This would trigger the next step in the parent component
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [localContext]);

  const goalOptions = [
    'Content Creation', 'SEO Optimization', 'Social Media', 'Customer Support',
    'Data Analysis', 'Lead Generation', 'Project Management', 'Design',
    'Development', 'Email Marketing', 'Sales', 'Recruitment'
  ];

  const toggleGoal = (goal: string) => {
    const currentGoals = localContext.primaryGoals || [];
    const updatedGoals = currentGoals.includes(goal)
      ? currentGoals.filter(g => g !== goal)
      : [...currentGoals, goal];
    updateContext({ primaryGoals: updatedGoals });
  };

  return (
    <StepWrapper>
      <div className="text-center space-y-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <Sparkles className="h-12 w-12 text-primary mx-auto mb-4" />
          <h2 className="text-2xl font-bold mb-3">Let's Get Smart About Your Needs</h2>
          <p className="text-muted-foreground max-w-lg mx-auto">
            Tell us a bit about yourself so we can recommend the perfect AI agents for your workflow
          </p>
        </motion.div>

        <div className="max-w-lg mx-auto space-y-6">
          {/* User Type Selection */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="space-y-3"
          >
            <Label className="text-sm font-medium">I am a...</Label>
            <div className="grid grid-cols-2 gap-3">
              <Card 
                className={`cursor-pointer transition-all hover:shadow-md ${
                  localContext.userType === 'individual' ? 'ring-2 ring-primary bg-primary/5' : ''
                }`}
                onClick={() => updateContext({ userType: 'individual' })}
              >
                <CardContent className="p-4 text-center">
                  <User className="h-6 w-6 mx-auto mb-2 text-primary" />
                  <p className="font-medium">Individual</p>
                  <p className="text-xs text-muted-foreground">Freelancer, creator, or entrepreneur</p>
                </CardContent>
              </Card>
              
              <Card 
                className={`cursor-pointer transition-all hover:shadow-md ${
                  localContext.userType === 'company' ? 'ring-2 ring-primary bg-primary/5' : ''
                }`}
                onClick={() => updateContext({ userType: 'company' })}
              >
                <CardContent className="p-4 text-center">
                  <Building2 className="h-6 w-6 mx-auto mb-2 text-primary" />
                  <p className="font-medium">Company</p>
                  <p className="text-xs text-muted-foreground">Business or organization</p>
                </CardContent>
              </Card>
            </div>
          </motion.div>

          {/* Name Input */}
          {localContext.userType && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="space-y-2"
            >
              <Label htmlFor="name" className="text-sm font-medium">
                {localContext.userType === 'individual' ? 'Your name (optional)' : 'Company name'}
              </Label>
              <Input
                id="name"
                placeholder={localContext.userType === 'individual' ? 'Enter your name' : 'Enter company name'}
                value={localContext.name || ''}
                onChange={(e) => updateContext({ name: e.target.value })}
                className="text-center"
              />
            </motion.div>
          )}

          {/* Website URL for companies */}
          {localContext.userType === 'company' && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="space-y-2"
            >
              <Label htmlFor="website" className="text-sm font-medium flex items-center gap-2">
                <Globe className="h-4 w-4" />
                Website URL (we'll analyze it for context)
              </Label>
              <div className="flex gap-2">
                <Input
                  id="website"
                  placeholder="https://yourcompany.com"
                  value={localContext.websiteUrl || ''}
                  onChange={(e) => updateContext({ websiteUrl: e.target.value })}
                  onBlur={(e) => extractWebsiteContext(e.target.value)}
                />
                {isExtracting && (
                  <Button disabled size="sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </Button>
                )}
              </div>
              {localContext.extractedContext && (
                <div className="mt-3 p-3 bg-green-50 dark:bg-green-950/20 rounded-lg border border-green-200 dark:border-green-800">
                  <p className="text-sm font-medium text-green-800 dark:text-green-300 mb-2">
                    ✨ Smart insights from your website:
                  </p>
                  <div className="space-y-1 text-sm text-green-700 dark:text-green-400">
                    <p>• Business: {localContext.extractedContext.businessType}</p>
                    <p>• Size: {localContext.extractedContext.size}</p>
                    <p>• Services: {localContext.extractedContext.services?.join(', ')}</p>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* Primary Goals */}
          {localContext.userType && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="space-y-3"
            >
              <Label className="text-sm font-medium">
                What are your primary goals? (select all that apply)
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {goalOptions.map((goal) => (
                  <Badge
                    key={goal}
                    variant={localContext.primaryGoals?.includes(goal) ? "default" : "outline"}
                    className="cursor-pointer hover:bg-primary/10 transition-colors p-2 justify-center"
                    onClick={() => toggleGoal(goal)}
                  >
                    {goal}
                  </Badge>
                ))}
              </div>
            </motion.div>
          )}

          {/* Progress indicator */}
          {localContext.userType && localContext.primaryGoals && localContext.primaryGoals.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="text-center"
            >
              <div className="inline-flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                Perfect! We're ready to recommend your ideal AI agents
              </div>
            </motion.div>
          )}
        </div>
      </div>
    </StepWrapper>
  );
};

