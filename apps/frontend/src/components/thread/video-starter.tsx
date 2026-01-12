'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  Video,
  Sparkles,
  Film,
  Wand2,
  Youtube,
  Clapperboard,
  MessageSquare,
  Tv,
  X,
  Play,
  FileText,
  Image,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SpotlightCard } from '@/components/ui/spotlight-card';

// Video templates/examples
const videoTemplates = [
  {
    id: 'youtube_intro',
    name: 'YouTube Intro',
    description: '10-second animated intro with channel branding',
    icon: <Youtube className="w-5 h-5" />,
    prompt: 'Initialize the tools. Create a 10-second YouTube intro video with my channel name [name], using modern motion graphics and an energetic vibe.',
  },
  {
    id: 'product_demo',
    name: 'Product Demo',
    description: 'Showcase product features with smooth transitions',
    icon: <Clapperboard className="w-5 h-5" />,
    prompt: 'Initialize the tools. Create a product demo video showcasing [product]. Include feature highlights, smooth transitions, and a professional look.',
  },
  {
    id: 'social_media',
    name: 'Social Media Clip',
    description: '30-second vertical video for Instagram/TikTok',
    icon: <MessageSquare className="w-5 h-5" />,
    prompt: 'Initialize the tools. Create a 30-second vertical video for Instagram/TikTok about [topic]. Make it engaging with captions and trending style.',
  },
  {
    id: 'explainer',
    name: 'Explainer Video',
    description: 'Break down complex concepts simply',
    icon: <Tv className="w-5 h-5" />,
    prompt: 'Initialize the tools. Create an explainer video that breaks down [concept] in simple terms. Use animations and clear narration style.',
  },
  {
    id: 'tutorial',
    name: 'Tutorial',
    description: 'Step-by-step instructional video',
    icon: <Play className="w-5 h-5" />,
    prompt: 'Initialize the tools. Create a tutorial video showing how to [task]. Include clear steps, screen recordings, and annotations.',
  },
  {
    id: 'testimonial',
    name: 'Testimonial',
    description: 'Customer testimonial with B-roll',
    icon: <Film className="w-5 h-5" />,
    prompt: 'Initialize the tools. Create a testimonial video featuring [customer] talking about [product/service]. Include B-roll footage and graphics.',
  },
  {
    id: 'event_highlights',
    name: 'Event Highlights',
    description: 'Compilation of event moments',
    icon: <Sparkles className="w-5 h-5" />,
    prompt: 'Initialize the tools. Create an event highlights video from [event name]. Include key moments, transitions, and background music.',
  },
  {
    id: 'announcement',
    name: 'Announcement',
    description: 'Product launch or company announcement',
    icon: <Wand2 className="w-5 h-5" />,
    prompt: 'Initialize the tools. Create an announcement video for [announcement]. Use bold typography, animations, and a professional tone.',
  },
];

// Quick creation methods
const creationMethods = [
  {
    id: 'prompt',
    label: 'From Prompt',
    description: 'Describe your video idea',
    icon: <MessageSquare className="w-6 h-6" />,
  },
  {
    id: 'script',
    label: 'From Script',
    description: 'Upload a script to visualize',
    icon: <FileText className="w-6 h-6" />,
  },
  {
    id: 'images',
    label: 'From Images',
    description: 'Create video from image sequence',
    icon: <Image className="w-6 h-6" />,
  },
];

interface VideoStarterProps {
  onSelectMethod?: (method: 'prompt' | 'script' | 'images', template?: string) => void;
  onSelectTemplate?: (templateId: string) => void;
  onClose?: () => void;
  className?: string;
}

export function VideoStarter({
  onSelectMethod,
  onSelectTemplate,
  onClose,
  className,
}: VideoStarterProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);

  const handleMethodClick = (method: 'prompt' | 'script' | 'images') => {
    if (selectedTemplate) {
      const template = videoTemplates.find(t => t.id === selectedTemplate);
      const prompt = template ? template.prompt : '';
      onSelectMethod?.(method, prompt);
    } else {
      onSelectMethod?.(method);
    }
  };

  const handleTemplateClick = (templateId: string) => {
    setSelectedTemplate(templateId);
    onSelectTemplate?.(templateId);
  };

  return (
    <div className={cn(
      'relative flex flex-col h-full min-h-0 bg-card/95 dark:bg-card/90 backdrop-blur-sm rounded-2xl overflow-hidden border border-border/50',
      className
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-rose-500/10">
            <Video className="w-4 h-4 text-rose-600 dark:text-rose-400" />
          </div>
          <h2 className="text-base font-semibold text-foreground">AI Video</h2>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="px-5 py-6 space-y-6">
          {/* Hero Section */}
          <div className="text-center">
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-rose-500/20 to-pink-500/20">
              <Video className="w-8 h-8 text-rose-600 dark:text-rose-400" />
            </div>
            <h1 className="text-xl font-bold text-foreground mb-2">
              Create Videos with AI
            </h1>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              From idea to video in minutes. Let AI handle the heavy lifting.
            </p>
          </div>

          {/* Creation Methods */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">
              Create AI Video
            </h3>
            <div className="grid grid-cols-3 gap-3">
              {creationMethods.map((method) => (
                <SpotlightCard
                  key={method.id}
                  onClick={() => handleMethodClick(method.id as 'prompt' | 'script' | 'images')}
                  className="p-4 cursor-pointer"
                >
                  <div className="flex flex-col items-center gap-2 text-center">
                    <div className="text-muted-foreground">{method.icon}</div>
                    <div>
                      <p className="text-xs font-medium text-foreground">{method.label}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{method.description}</p>
                    </div>
                  </div>
                </SpotlightCard>
              ))}
            </div>
          </div>

          {/* Video Templates */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">
              Select a video template
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {videoTemplates.map((template) => (
                <SpotlightCard
                  key={template.id}
                  onClick={() => handleTemplateClick(template.id)}
                  className={cn(
                    'p-4 cursor-pointer transition-all',
                    selectedTemplate === template.id && 'ring-2 ring-rose-500/50'
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 text-rose-500/60">{template.icon}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">{template.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{template.description}</p>
                    </div>
                  </div>
                </SpotlightCard>
              ))}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
