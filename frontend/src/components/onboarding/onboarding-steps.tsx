'use client';

import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Bot, 
  Sparkles, 
  Zap, 
  Shield, 
  MessageSquare, 
  Workflow,
  Palette,
  Users,
  ArrowRight,
  CheckCircle2,
  Brain,
  Globe,
  FileText,
  Settings
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { OnboardingStep } from '@/hooks/use-onboarding';
import { UserTypeStep } from './user-type-step';

// Welcome Step
export const WelcomeStep = () => (
  <div className="text-center space-y-8">
    <motion.div
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="relative mx-auto w-32 h-32 mb-8"
    >
      <div className="absolute inset-0 bg-gradient-to-r from-primary/20 to-purple-500/20 rounded-full animate-pulse" />
      <div className="absolute inset-2 bg-background rounded-full flex items-center justify-center">
        <Sparkles className="h-16 w-16 text-primary" />
      </div>
    </motion.div>
    
    <div className="space-y-4 max-w-2xl mx-auto">
      <h3 className="text-2xl font-semibold text-foreground">
        Welcome to Your AI Journey! 🎉
      </h3>
      <p className="text-lg text-muted-foreground">
        You've successfully subscribed to Suna! Let's take a quick tour to help you get the most out of your AI assistant.
      </p>
      <div className="flex flex-wrap justify-center gap-2 mt-6">
        <Badge variant="secondary" className="flex items-center gap-1">
          <Bot className="h-3 w-3" />
          AI Agents
        </Badge>
        <Badge variant="secondary" className="flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          Smart Conversations
        </Badge>
        <Badge variant="secondary" className="flex items-center gap-1">
          <Workflow className="h-3 w-3" />
          Automation
        </Badge>
        <Badge variant="secondary" className="flex items-center gap-1">
          <Shield className="h-3 w-3" />
          Secure & Private
        </Badge>
      </div>
    </div>
  </div>
);

// Features Overview Step
export const FeaturesOverviewStep = () => (
  <div className="space-y-8">
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
      >
        <Card className="h-full">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Bot className="h-6 w-6 text-primary" />
              </div>
              <CardTitle className="text-lg">AI Agents</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <CardDescription className="text-base">
              Create and customize AI agents for specific tasks. From research to content creation, your agents work 24/7.
            </CardDescription>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
      >
        <Card className="h-full">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Brain className="h-6 w-6 text-primary" />
              </div>
              <CardTitle className="text-lg">Smart Conversations</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <CardDescription className="text-base">
              Have natural conversations with AI that remembers context and learns from your preferences.
            </CardDescription>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
      >
        <Card className="h-full">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-muted/50 rounded-lg">
                <Globe className="h-6 w-6 text-foreground" />
              </div>
              <CardTitle className="text-lg">Web Integration</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <CardDescription className="text-base">
              Your AI can browse the web, access real-time data, and interact with online services seamlessly.
            </CardDescription>
          </CardContent>
        </Card>
      </motion.div>

      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.4 }}
      >
        <Card className="h-full">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-muted/50 rounded-lg">
                <Workflow className="h-6 w-6 text-foreground" />
              </div>
              <CardTitle className="text-lg">Workflow Automation</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <CardDescription className="text-base">
              Set up automated workflows and triggers to handle repetitive tasks without manual intervention.
            </CardDescription>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  </div>
);

// Quick Start Guide Step
export const QuickStartStep = () => (
  <div className="space-y-8">
    <div className="text-center">
      <h3 className="text-xl font-semibold mb-4">Let's Get You Started</h3>
      <p className="text-muted-foreground">
        Follow these simple steps to begin your AI journey
      </p>
    </div>
    
    <div className="space-y-4 max-w-2xl mx-auto">
      {[
        {
          icon: MessageSquare,
          title: "Start a Conversation",
          description: "Click on 'New Chat' and ask your AI anything. Try: 'Help me write a professional email'",
          color: "text-primary"
        },
        {
          icon: Bot,
          title: "Explore Agents",
          description: "Visit the Agents section to discover pre-built AI assistants for specific tasks",
          color: "text-primary"
        },
        {
          icon: Settings,
          title: "Customize Your Experience",
          description: "Go to Settings to personalize your AI's behavior and preferences",
          color: "text-foreground"
        },
        {
          icon: Workflow,
          title: "Set Up Automation",
          description: "Create workflows to automate repetitive tasks and save time",
          color: "text-foreground"
        }
      ].map((step, index) => (
        <motion.div
          key={index}
          initial={{ x: -20, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ delay: index * 0.1 }}
          className="flex items-start gap-4 p-4 rounded-lg border bg-card"
        >
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium">
            {index + 1}
          </div>
          <div className="flex-shrink-0 mt-1">
            <step.icon className={`h-5 w-5 ${step.color}`} />
          </div>
          <div className="flex-1">
            <h4 className="font-medium text-foreground">{step.title}</h4>
            <p className="text-sm text-muted-foreground mt-1">{step.description}</p>
          </div>
        </motion.div>
      ))}
    </div>
  </div>
);

// Completion Step
export const CompletionStep = () => (
  <div className="text-center space-y-8">
    <motion.div
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="relative mx-auto w-24 h-24 mb-8"
    >
      <div className="absolute inset-0 bg-gradient-to-r from-primary/20 to-purple-500/20 rounded-full animate-pulse" />
      <div className="absolute inset-2 bg-background rounded-full flex items-center justify-center">
        <CheckCircle2 className="h-12 w-12 text-primary" />
      </div>
    </motion.div>
    
    <div className="space-y-4 max-w-2xl mx-auto">
      <h3 className="text-2xl font-semibold text-foreground">
        You're All Set! 🚀
      </h3>
      <p className="text-lg text-muted-foreground">
        Congratulations! You've completed the onboarding. You're now ready to harness the full power of AI assistance.
      </p>
      
      <div className="bg-muted/50 rounded-lg p-6 mt-8">
        <h4 className="font-semibold text-foreground mb-3">What's Next?</h4>
        <div className="space-y-2 text-left">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
            <span className="text-sm text-muted-foreground">Start your first conversation</span>
          </div>
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
            <span className="text-sm text-muted-foreground">Explore available agents</span>
          </div>
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
            <span className="text-sm text-muted-foreground">Customize your preferences</span>
          </div>
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
            <span className="text-sm text-muted-foreground">Set up your first automation</span>
          </div>
        </div>
      </div>
    </div>
  </div>
);

// Default onboarding steps
export const defaultOnboardingSteps: OnboardingStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Suna',
    description: 'Your AI journey starts here',
    content: <WelcomeStep />,
    canSkip: false,
    actionLabel: 'Get Started'
  },
  {
    id: 'user-type',
    title: 'About You',
    description: 'Help us personalize your experience',
    content: <UserTypeStep />,
    canSkip: false,
    actionLabel: 'Continue'
  },
  {
    id: 'features',
    title: 'Discover What\'s Possible',
    description: 'Explore the powerful features at your fingertips',
    content: <FeaturesOverviewStep />,
    canSkip: true,
    actionLabel: 'Continue'
  },
  {
    id: 'quickstart',
    title: 'Quick Start Guide',
    description: 'Learn the essentials to get productive fast',
    content: <QuickStartStep />,
    canSkip: true,
    actionLabel: 'Next'
  },
  {
    id: 'completion',
    title: 'Ready to Go!',
    description: 'You\'re all set to start using Suna',
    content: <CompletionStep />,
    canSkip: false,
    actionLabel: 'Enter Dashboard'
  }
];