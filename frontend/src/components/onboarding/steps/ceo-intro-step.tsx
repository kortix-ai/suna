'use client';

import { motion } from 'framer-motion';
import { Play, Users, Zap, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { StepWrapper } from '../shared/step-wrapper';

export const CEOIntroStep = () => {
  return (
    <StepWrapper className="text-center max-w-3xl">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6 }}
        className="space-y-8"
      >
        {/* Video placeholder */}
        <div className="relative">
          <div className="aspect-video bg-gradient-to-br from-primary/20 to-primary/5 rounded-xl flex items-center justify-center border border-primary/20">
            <div className="text-center space-y-4">
              <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                <Play className="h-8 w-8 text-primary ml-1" />
              </div>
              <div>
                <p className="text-lg font-medium">Welcome Message from Marko</p>
                <p className="text-sm text-muted-foreground">CEO & Founder</p>
              </div>
            </div>
          </div>
        </div>

        {/* Welcome content */}
        <div className="space-y-6">
          <div>
            <h1 className="text-3xl font-bold mb-4">
              Welcome to Your AI Workforce
            </h1>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              I'm Marko, and I'm excited to help you build a team of AI agents that will 
              supercharge your productivity and help you achieve your goals faster than ever.
            </p>
          </div>

          {/* Value propositions */}
          <div className="grid md:grid-cols-3 gap-6 mt-8">
            <Card className="border-0 shadow-none bg-primary/5">
              <CardContent className="p-6 text-center">
                <Users className="h-8 w-8 text-primary mx-auto mb-3" />
                <h3 className="font-semibold mb-2">Build Your Team</h3>
                <p className="text-sm text-muted-foreground">
                  Choose from specialized AI agents tailored to your needs
                </p>
              </CardContent>
            </Card>
            
            <Card className="border-0 shadow-none bg-primary/5">
              <CardContent className="p-6 text-center">
                <Zap className="h-8 w-8 text-primary mx-auto mb-3" />
                <h3 className="font-semibold mb-2">Work Faster</h3>
                <p className="text-sm text-muted-foreground">
                  Automate tasks and get 10x more done with AI assistance
                </p>
              </CardContent>
            </Card>
            
            <Card className="border-0 shadow-none bg-primary/5">
              <CardContent className="p-6 text-center">
                <Target className="h-8 w-8 text-primary mx-auto mb-3" />
                <h3 className="font-semibold mb-2">Achieve Goals</h3>
                <p className="text-sm text-muted-foreground">
                  Focus on what matters while AI handles the rest
                </p>
              </CardContent>
            </Card>
          </div>

          {/* CTA */}
          <div className="pt-4">
            <p className="text-muted-foreground mb-6">
              Let's get started with a quick setup to personalize your AI workforce
            </p>
          </div>
        </div>
      </motion.div>
    </StepWrapper>
  );
};

