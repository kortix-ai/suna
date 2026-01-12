'use client';

import React, { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  Presentation,
  Table,
  FileText,
  PenTool,
  Video,
  BookOpen,
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useAuth } from '@/components/AuthProvider';
import { useOptimisticAgentStart } from '@/hooks/threads/use-optimistic-agent-start';
import { KortixLoader } from '@/components/ui/kortix-loader';

// Silver shine spotlight effect for mode pills
interface SpotlightPillProps {
  children: React.ReactNode;
  className?: string;
}

function SpotlightPill({ children, className }: SpotlightPillProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setMousePosition({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn('relative overflow-hidden rounded-full', className)}
      style={{
        // @ts-expect-error - CSS custom properties
        '--mouse-x': `${mousePosition.x}px`,
        '--mouse-y': `${mousePosition.y}px`,
      }}
    >
      {/* Silver shine spotlight effect */}
      {isHovered && (
        <div
          className="pointer-events-none absolute inset-0 transition-opacity duration-300 bg-[radial-gradient(120px_circle_at_var(--mouse-x)_var(--mouse-y),rgba(0,0,0,0.08),transparent_50%)] dark:bg-[radial-gradient(120px_circle_at_var(--mouse-x)_var(--mouse-y),rgba(255,255,255,0.15),transparent_50%)]"
          style={{ opacity: isHovered ? 1 : 0 }}
        />
      )}
      {children}
    </div>
  );
}

export interface ModeConfig {
  id: string;
  name: string;
  icon: React.ReactNode;
  iconName: string;
  description: string;
  examplePrompts: string[];
}

export const modeConfigs: ModeConfig[] = [
  {
    id: 'slides',
    name: 'Slides',
    icon: <Presentation className="w-4 h-4" />,
    iconName: 'Presentation',
    description: 'Create stunning presentations',
    examplePrompts: [
      'Create a pitch deck for a SaaS startup',
      'Make a quarterly business review presentation',
      'Design a product launch presentation',
      'Build a conference talk about AI trends',
    ],
  },
  {
    id: 'sheets',
    name: 'Sheets',
    icon: <Table className="w-4 h-4" />,
    iconName: 'Table',
    description: 'Build and analyze spreadsheets',
    examplePrompts: [
      'Create a sales tracking spreadsheet',
      'Build a budget planner with charts',
      'Analyze this CSV and find insights',
      'Create a project timeline tracker',
    ],
  },
  {
    id: 'docs',
    name: 'Docs',
    icon: <FileText className="w-4 h-4" />,
    iconName: 'FileText',
    description: 'Write and format documents',
    examplePrompts: [
      'Write a technical documentation',
      'Draft a project proposal',
      'Create a meeting notes template',
      'Write a product requirements document',
    ],
  },
  {
    id: 'canvas',
    name: 'Canvas',
    icon: <PenTool className="w-4 h-4" />,
    iconName: 'PenTool',
    description: 'Design and create visuals',
    examplePrompts: [
      'Design a social media banner',
      'Create an infographic about climate change',
      'Build a wireframe for a mobile app',
      'Design a logo concept',
    ],
  },
  {
    id: 'video',
    name: 'Video',
    icon: <Video className="w-4 h-4" />,
    iconName: 'Video',
    description: 'Generate and edit videos',
    examplePrompts: [
      'Create a product demo video script',
      'Generate a short explainer video',
      'Edit this video with transitions',
      'Create a video thumbnail design',
    ],
  },
  {
    id: 'research',
    name: 'Research',
    icon: <BookOpen className="w-4 h-4" />,
    iconName: 'BookOpen',
    description: 'Deep research and analysis',
    examplePrompts: [
      'Research the competitive landscape for AI tools',
      'Analyze market trends in renewable energy',
      'Create a comprehensive report on Web3',
      'Research best practices for remote work',
    ],
  },
];

export function getModeConfig(modeId: string): ModeConfig | undefined {
  return modeConfigs.find(m => m.id === modeId);
}

interface ModeSelectorProps {
  className?: string;
}

export function ModeSelector({ className }: ModeSelectorProps) {
  const router = useRouter();
  const { user } = useAuth();
  const { startAgent, isStarting } = useOptimisticAgentStart('/dashboard');
  const [selectedModeId, setSelectedModeId] = useState<string | null>(null);

  const handleModeSelect = async (mode: ModeConfig) => {
    if (!user) {
      router.push('/auth/login?returnUrl=/dashboard');
      return;
    }

    if (isStarting) return;

    setSelectedModeId(mode.id);

    // Store mode config for the thread page to pick up
    const modeConfigData = {
      id: mode.id,
      name: mode.name,
      iconName: mode.iconName,
      description: mode.description,
      examplePrompts: mode.examplePrompts,
    };
    
    console.log('[ModeSelector] Starting mode:', mode.id);
    sessionStorage.setItem('thread_mode', mode.id);
    sessionStorage.setItem('thread_mode_config', JSON.stringify(modeConfigData));
    sessionStorage.setItem('thread_mode_bootstrap', 'true');

    // Map mode id to modeStarter param - all modes have starters now
    const modeStarterMap: Record<string, string> = {
      slides: 'presentation',
      sheets: 'sheets',
      docs: 'docs',
      canvas: 'canvas',
      video: 'video',
      research: 'research',
    };
    const modeStarterParam = modeStarterMap[mode.id];

    // Mode-specific prompts - starters guide the user to describe their needs
    // All prompts include "Initialize the tools" to ensure tools are ready immediately
    const modePromptMap: Record<string, string> = {
      slides: `Initialize the tools. I want to create a presentation. Help me get started.`,
      sheets: `Initialize the tools. I want to work with spreadsheets.`,
      docs: `Initialize the tools. I want to create a document. Help me get started.`,
      canvas: `Initialize the tools. I want to design something. Help me get started.`,
      video: `Initialize the tools. I want to create a video. Help me get started.`,
      research: `Initialize the tools. I need to conduct research. Help me get started.`,
    };
    const modePrompt = modePromptMap[mode.id] || `I want to create ${mode.name.toLowerCase()}. Help me get started.`;

    // Create and stage starter files for modes that need them
    let starterFileIds: string[] = [];
    if (mode.id === 'sheets' || mode.id === 'docs' || mode.id === 'canvas') {
      const { createAndStageStarterFile } = await import('@/utils/starter-files');
      const fileId = await createAndStageStarterFile(mode.id as 'sheets' | 'docs' | 'canvas');
      if (fileId) {
        starterFileIds.push(fileId);
        console.log(`[ModeSelector] Staged starter file for ${mode.id}: ${fileId}`);
      }
    }

    // Always use optimistic agent start - this creates thread AND starts agent
    // Pass modeStarter param so the thread page shows the starter experience
    // Pass mode for backend context (stored in project metadata)
    // Pass fileIds if we staged starter files
    const result = await startAgent({
      message: modePrompt,
      agentId: undefined,
      modeStarter: modeStarterParam,
      mode: mode.id,
      fileIds: starterFileIds.length > 0 ? starterFileIds : undefined,
    });

    console.log('[ModeSelector] Agent start result:', result);

    if (!result) {
      setSelectedModeId(null);
      sessionStorage.removeItem('thread_mode');
      sessionStorage.removeItem('thread_mode_config');
      sessionStorage.removeItem('thread_mode_bootstrap');
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className={cn('w-full max-w-3xl mx-auto', className)}>
        {/* Mode Cards - Horizontal scroll on mobile, grid on desktop */}
        <div className="flex items-center justify-center gap-2 flex-wrap">
          {modeConfigs.map((mode, index) => (
            <Tooltip key={mode.id}>
              <TooltipTrigger asChild>
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ 
                    duration: 0.2, 
                    delay: index * 0.03,
                    ease: [0.23, 1, 0.32, 1]
                  }}
                  whileHover={{ scale: 1.04, y: -2 }}
                  whileTap={{ scale: 0.96 }}
                >
                  <SpotlightPill>
                    <button
                      onClick={() => handleModeSelect(mode)}
                      disabled={isStarting}
                      className={cn(
                        'group relative z-10 flex items-center gap-2 px-3.5 py-2 rounded-full cursor-pointer',
                        'bg-background/80 dark:bg-background/60',
                        'border border-border/60',
                        'transition-all duration-150 ease-out',
                        'hover:bg-accent hover:border-foreground/20 hover:shadow-md',
                        'dark:hover:bg-accent/50 dark:hover:border-foreground/25',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        selectedModeId === mode.id && 'bg-accent dark:bg-accent/50 border-foreground/20 shadow-md'
                      )}
                    >
                      {/* Icon */}
                      <div className={cn(
                        'flex items-center justify-center',
                        'text-muted-foreground',
                        'transition-all duration-150',
                        'group-hover:text-foreground group-hover:scale-110',
                        selectedModeId === mode.id && 'text-foreground scale-110'
                      )}>
                        {selectedModeId === mode.id && isStarting ? (
                          <KortixLoader size="small" customSize={14} />
                        ) : (
                          mode.icon
                        )}
                      </div>

                      {/* Label */}
                      <span className={cn(
                        'text-sm font-medium',
                        'text-muted-foreground',
                        'transition-colors duration-150',
                        'group-hover:text-foreground',
                        selectedModeId === mode.id && 'text-foreground'
                      )}>
                        {mode.name}
                      </span>
                    </button>
                  </SpotlightPill>
                </motion.div>
              </TooltipTrigger>
              <TooltipContent 
                side="bottom" 
                sideOffset={8}
                className="text-xs font-medium"
              >
                {mode.description}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}
