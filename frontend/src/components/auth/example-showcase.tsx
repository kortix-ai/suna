'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import Image from 'next/image';
import { Computer, CornerDownLeft, Paperclip, Mic, Zap, FolderOpen, Globe, CircleDashed, Presentation, BarChart3, FileText, Search, Image as ImageIcon, ChevronRight, File, Database } from 'lucide-react';
import { motion } from 'framer-motion';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

type ViewType = 'terminal' | 'files' | 'browser';
type IconType = 'computer' | 'presentation' | 'chart' | 'file' | 'search' | 'image' | 'database';
type ContentType = 'empty' | 'image' | 'files' | 'slides' | 'table' | 'markdown' | 'search';

// Google Drive icon component
const GoogleDriveIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 87.3 78" className={className}>
    <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
    <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47" />
    <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335" />
    <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
    <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
    <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
  </svg>
);

// Helper to get icon component
const getIconComponent = (iconType?: IconType) => {
  switch (iconType) {
    case 'presentation': return Presentation;
    case 'chart': return BarChart3;
    case 'file': return FileText;
    case 'search': return Search;
    case 'image': return ImageIcon;
    case 'database': return Database;
    default: return Computer;
  }
};

interface Step {
  type: 'message' | 'toolcall';
  aiText?: string;
  title?: string;
  view?: ViewType;
  icon?: IconType;
  // Content to show in computer
  contentType?: ContentType;
  contentImage?: string;
  contentSlides?: string[];
  contentFiles?: { name: string; type: 'folder' | 'file' }[];
  contentMarkdown?: string;
  // Keep content from previous step
  keepContent?: boolean;
}

// Example showcase data with steps
const exampleShowcases = [
  {
    id: 'slides',
    title: 'Presentations',
    description: 'Research and create presentation about neural networks',
    steps: [
      {
        type: 'message',
        aiText: "I'll research neural networks and create a presentation for you..."
      } as Step,
      {
        type: 'toolcall',
        title: 'Researching',
        view: 'browser' as ViewType,
        icon: 'search',
        contentType: 'image' as ContentType,
        contentImage: '/showcase/presentation/browser.png'
      } as Step,
      {
        type: 'toolcall',
        title: 'Creating File',
        view: 'files' as ViewType,
        icon: 'file',
        contentType: 'files' as ContentType,
        contentFiles: [
          { name: 'downloads', type: 'folder' },
          { name: 'notes.md', type: 'file' },
          { name: 'data.csv', type: 'file' },
          { name: 'projects', type: 'folder' },
          { name: 'research.txt', type: 'file' },
          { name: 'neural_networks.pptx', type: 'file' },
        ]
      } as Step,
      {
        type: 'toolcall',
        title: 'Creating Slides',
        view: 'terminal' as ViewType,
        icon: 'presentation',
        contentType: 'slides' as ContentType,
        contentSlides: ['/showcase/presentation/slide1.png', '/showcase/presentation/slide2.png']
      } as Step,
    ],
  },
  {
    id: 'data',
    title: 'Data Analysis',
    description: 'Analyze Q4 sales performance from Google Drive',
    steps: [
      {
        type: 'message',
        aiText: "I'll load your sales data and create a comprehensive analysis..."
      } as Step,
      {
        type: 'toolcall',
        title: 'Loading from Google Drive',
        view: 'browser' as ViewType,
        icon: 'database',
        contentType: 'table' as ContentType
      } as Step,
      {
        type: 'toolcall',
        title: 'Creating Visualization',
        view: 'terminal' as ViewType,
        icon: 'chart',
        contentType: 'image' as ContentType,
        contentImage: '/showcase/data/dashboard.png'
      } as Step,
      {
        type: 'toolcall',
        title: 'Researching Market',
        view: 'terminal' as ViewType,
        icon: 'search',
        keepContent: true
      } as Step,
      {
        type: 'toolcall',
        title: 'Creating Report',
        view: 'terminal' as ViewType,
        icon: 'file',
        contentType: 'markdown' as ContentType,
        contentMarkdown: `# Executive Summary

**Revenue:** $6.89M (+81.6% YoY)
**Profit Margin:** 31.1%

## Key Findings

### ✅ What's Working
- Sales: $3.94M revenue, 4.5/5 satisfaction
- Growth: Nearly doubled YoY
- Retention: Churn decreased 18.4%

### ⚠️ Critical Issues
1. Support: 10.1% churn rate
2. Engineering: 70% expense ratio
3. Marketing: Diminishing ROI

## Recommendations

**Priority #1: Fix Support**
- Hire 5-7 specialists
- Target: 4.5+ satisfaction by Q2`
      } as Step,
    ],
  },
  {
    id: 'image',
    title: 'Image',
    description: 'Create logo for our company',
    steps: [
      {
        type: 'message',
        aiText: "I see you mentioned LUXY before. I'll create a professional logo for your brand..."
      } as Step,
      {
        type: 'toolcall',
        title: 'Researching Brand',
        view: 'browser' as ViewType,
        icon: 'search',
        contentType: 'search' as ContentType
      } as Step,
      {
        type: 'toolcall',
        title: 'Creating Logo',
        view: 'terminal' as ViewType,
        icon: 'image',
        contentType: 'image' as ContentType,
        contentImage: '/showcase/image/logo.png'
      } as Step,
      {
        type: 'toolcall',
        title: 'Creating Brand Board',
        view: 'terminal' as ViewType,
        icon: 'presentation',
        contentType: 'image' as ContentType,
        contentImage: '/showcase/image/mockup-board.png'
      } as Step,
    ],
  },
];

export function ExampleShowcase() {
  const [activeExample, setActiveExample] = useState(0);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [aiText, setAiText] = useState('');
  const [selectedView, setSelectedView] = useState<ViewType>('terminal');
  const [currentSlide, setCurrentSlide] = useState(0);
  const [displayedContent, setDisplayedContent] = useState<Step | null>(null);

  const currentExample = exampleShowcases[activeExample];
  const userMessage = currentExample.description;
  const currentStep = currentExample.steps[currentStepIndex];

  // Different timing per example
  const isSlowExample = currentExample.id === 'data' || currentExample.id === 'image';
  const AUTOPLAY_DURATION = isSlowExample ? 18000 : 14000; // 18s for data/image, 14s for others
  const STEP_DURATION = isSlowExample ? 2800 : 1800; // 2.8s for data/image, 1.8s for others
  const SLIDE_DURATION = 1500; // Time per slide

  // Auto-play - switch examples
  useEffect(() => {
    const autoplayTimer = setTimeout(() => {
      setActiveExample((prev) => (prev + 1) % exampleShowcases.length);
      setCurrentStepIndex(0);
    }, AUTOPLAY_DURATION);

    return () => {
      clearTimeout(autoplayTimer);
    };
  }, [activeExample]);

  // Step progression
  useEffect(() => {
    setCurrentStepIndex(0);
    setAiText('');
    setSelectedView('terminal');
    setCurrentSlide(0);
    setDisplayedContent(null);
  }, [activeExample]);

  // Animate through steps
  useEffect(() => {
    const step = currentExample.steps[currentStepIndex];
    if (!step) return;

    // Handle message step with typing
    if (step.type === 'message') {
      setAiText('');
      let index = 0;
      const fullText = step.aiText || '';
      const typingInterval = setInterval(() => {
        if (index <= fullText.length) {
          setAiText(fullText.slice(0, index));
          index++;
        } else {
          clearInterval(typingInterval);
          // Move to next step after typing
          setTimeout(() => {
            if (currentStepIndex < currentExample.steps.length - 1) {
              setCurrentStepIndex(prev => prev + 1);
            }
          }, 300);
        }
      }, 15);

      return () => clearInterval(typingInterval);
    }

    // Handle tool call step
    if (step.type === 'toolcall') {
      if (step.view) {
        setSelectedView(step.view);
      }
      setCurrentSlide(0);

      // Update displayed content (unless keepContent is true)
      if (!step.keepContent) {
        setDisplayedContent(step);
      }

      // If slides, cycle through them
      if (step.contentType === 'slides' && step.contentSlides && step.contentSlides.length > 1) {
        const slideTimer = setTimeout(() => {
          setCurrentSlide(1);
        }, SLIDE_DURATION);

        const nextStepTimer = setTimeout(() => {
          if (currentStepIndex < currentExample.steps.length - 1) {
            setCurrentStepIndex(prev => prev + 1);
          }
        }, STEP_DURATION + SLIDE_DURATION);

        return () => {
          clearTimeout(slideTimer);
          clearTimeout(nextStepTimer);
        };
      }

      const timer = setTimeout(() => {
        if (currentStepIndex < currentExample.steps.length - 1) {
          setCurrentStepIndex(prev => prev + 1);
        }
      }, STEP_DURATION);

      return () => clearTimeout(timer);
    }
  }, [currentStepIndex, currentExample, activeExample]);

  return (
    <div className="relative z-10 w-full max-w-5xl px-8">
      {/* Main Card - 16:9 aspect ratio */}
      <Card className="!rounded-3xl !p-0 overflow-hidden aspect-video select-none">
        {/* 50/50 Split Layout */}
        <div className="flex h-full">
          {/* Left Side - Chat */}
          <div className="flex-1 flex flex-col bg-background">
            {/* Chat Messages Area */}
            <div className="flex-1 p-4 space-y-3 overflow-hidden">
              {/* User Message - with proper bubble style */}
              <div className="flex justify-end">
                <div className="flex max-w-[90%] rounded-3xl rounded-br-lg bg-card border px-3 py-2 break-words overflow-hidden">
                  <p className="text-[10px] leading-relaxed">{exampleShowcases[activeExample].description}</p>
                </div>
              </div>

              {/* Show all steps up to current (history) */}
              {currentExample.steps.slice(0, currentStepIndex + 1).map((step, idx) => {
                const isCurrentStep = idx === currentStepIndex;

                if (step.type === 'message') {
                  const displayText = isCurrentStep ? aiText : (step.aiText || '');
                  const isTyping = isCurrentStep && aiText.length < (step.aiText?.length || 0);

                  return (
                    <div key={idx} className="flex justify-start">
                      <div className="max-w-[90%] space-y-1">
                        <div className="flex items-center gap-1 mb-1">
                          <KortixLogo size={10} />
                          <span className="text-[10px] font-medium">Kortix</span>
                        </div>
                        <p className="text-[9px] leading-relaxed text-foreground">
                          {displayText}
                          {isTyping && <span className="inline-block w-0.5 h-2.5 bg-primary ml-0.5 animate-pulse" />}
                        </p>
                      </div>
                    </div>
                  );
                }

                if (step.type === 'toolcall') {
                  const IconComponent = getIconComponent(step.icon);
                  return (
                    <div key={idx} className="my-1">
                      <button
                        onClick={() => setCurrentStepIndex(idx)}
                        className="inline-flex items-center gap-1 h-6 px-1.5 py-1 text-xs text-muted-foreground bg-card rounded-lg border border-neutral-200 dark:border-neutral-700/50 whitespace-nowrap cursor-pointer hover:bg-card/80 transition-colors"
                      >
                        <IconComponent className="h-2.5 w-2.5 text-muted-foreground flex-shrink-0" />
                        <span className="font-mono text-[9px] text-foreground">{step.title}</span>
                        {isCurrentStep && (
                          <CircleDashed className="h-2.5 w-2.5 text-muted-foreground flex-shrink-0 animate-spin ml-0.5" />
                        )}
                      </button>
                    </div>
                  );
                }

                return null;
              })}
            </div>

            {/* Example Selector - Above chat input */}
            <div className="bg-background px-4 pt-3 pb-2">
              <div className="flex gap-1.5 flex-wrap">
                {exampleShowcases.map((example, idx) => (
                  <motion.button
                    key={example.id}
                    onClick={() => setActiveExample(idx)}
                    animate={{
                      width: activeExample === idx ? 'auto' : 'fit-content',
                      paddingLeft: activeExample === idx ? '14px' : '10px',
                      paddingRight: activeExample === idx ? '14px' : '10px',
                    }}
                    transition={{
                      duration: 0.3,
                      ease: [0.4, 0, 0.2, 1]
                    }}
                    className={`py-1 rounded-lg text-[10px] font-medium transition-colors cursor-pointer ${activeExample === idx
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-card border text-foreground hover:bg-card/80'
                      }`}
                  >
                    {example.title}
                  </motion.button>
                ))}
              </div>
            </div>

            {/* Input Area - multiline with border */}
            <div className="bg-background px-4 pb-4">
              <div className="flex flex-col border rounded-2xl bg-card px-3 py-2">
                {/* Text input - shows user message */}
                <textarea
                  disabled
                  rows={1}
                  value={userMessage}
                  className="w-full bg-transparent text-[10px] outline-none text-foreground resize-none leading-relaxed mb-2"
                />

                {/* Footer - buttons at bottom */}
                <div className="flex items-center justify-between gap-1.5">
                  {/* Left buttons - separate with borders */}
                  <div className="flex gap-1 flex-shrink-0">
                    <button className="p-1 rounded-lg border">
                      <Paperclip className="w-3 h-3 text-muted-foreground" />
                    </button>
                    <button className="p-1 rounded-lg border">
                      <GoogleDriveIcon className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Right buttons */}
                  <div className="flex gap-1 items-center flex-shrink-0">
                    <button className="px-2 py-1 rounded-lg border bg-background flex items-center gap-1">
                      <span className="text-[8px] font-medium">Kortix</span>
                      <svg className="w-2 h-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    <button className="p-1 rounded-lg">
                      <Mic className="w-3 h-3 text-muted-foreground" />
                    </button>
                    <button className="p-1.5 rounded-lg bg-primary text-primary-foreground flex items-center justify-center">
                      <CornerDownLeft className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Side - Kortix Computer (Floating) */}
          <div className="flex-1 bg-background p-4">
            <Card className="w-full h-full !rounded-2xl !p-0 !gap-0 overflow-hidden flex flex-col">
              {/* Computer Header */}
              <div className="border-b px-3 py-2 flex items-center justify-between bg-card shrink-0">
                <div className="flex items-center gap-1.5">
                  <KortixLogo size={12} />
                  <span className="text-xs font-medium">Kortix Computer</span>
                </div>
                <div className="flex items-center gap-0.5 border rounded-full bg-card p-1 relative">
                  <div className="p-1 relative z-10 pointer-events-none">
                    {selectedView === 'terminal' && (
                      <motion.div
                        layoutId="active-view"
                        className="absolute inset-0 bg-primary rounded-xl"
                        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                      />
                    )}
                    <Zap className={`w-3 h-3 relative z-10 transition-colors ${selectedView === 'terminal'
                      ? 'text-primary-foreground'
                      : 'text-foreground'
                      }`} />
                  </div>
                  <div className="p-1 relative z-10 pointer-events-none">
                    {selectedView === 'files' && (
                      <motion.div
                        layoutId="active-view"
                        className="absolute inset-0 bg-primary rounded-xl"
                        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                      />
                    )}
                    <FolderOpen className={`w-3 h-3 relative z-10 transition-colors ${selectedView === 'files'
                      ? 'text-primary-foreground'
                      : 'text-foreground'
                      }`} />
                  </div>
                  <div className="p-1 relative z-10 pointer-events-none">
                    {selectedView === 'browser' && (
                      <motion.div
                        layoutId="active-view"
                        className="absolute inset-0 bg-primary rounded-xl"
                        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                      />
                    )}
                    <Globe className={`w-3 h-3 relative z-10 transition-colors ${selectedView === 'browser'
                      ? 'text-primary-foreground'
                      : 'text-foreground'
                      }`} />
                  </div>
                </div>
              </div>

              {/* Computer Content - Dynamic based on displayedContent */}
              <div className="relative flex-1 min-h-0 overflow-hidden">
                {/* Empty state */}
                {(!displayedContent?.contentType || displayedContent.contentType === 'empty') && (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <Computer className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
                      <p className="text-[9px] text-muted-foreground">Processing...</p>
                    </div>
                  </div>
                )}

                {/* Image content */}
                {displayedContent?.contentType === 'image' && displayedContent.contentImage && (
                  <>
                    {displayedContent.contentImage.includes('logo.png') || displayedContent.contentImage.includes('mockup') ? (
                      <div className="h-full w-full p-3">
                        <div className={`w-full h-full rounded-xl border relative overflow-hidden ${displayedContent.contentImage.includes('logo.png') ? 'bg-white' : ''}`}>
                          <Image
                            src={displayedContent.contentImage}
                            alt={currentExample.title}
                            fill
                            className="object-contain"
                            quality={100}
                            sizes="50vw"
                            unoptimized={true}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className={`h-full w-full relative ${displayedContent.contentImage.includes('dashboard') ? 'bg-black' : ''}`}>
                        <Image
                          src={displayedContent.contentImage}
                          alt={currentExample.title}
                          fill
                          className="object-contain"
                          quality={100}
                          sizes="50vw"
                          unoptimized={true}
                        />
                      </div>
                    )}
                  </>
                )}

                {/* Files content - grid layout */}
                {displayedContent?.contentType === 'files' && displayedContent.contentFiles && (
                  <div className="p-3 h-full grid grid-cols-3 gap-1.5 content-start">
                    {displayedContent.contentFiles.map((file, idx) => (
                      <div
                        key={idx}
                        className={`flex flex-col items-center justify-center p-1.5 rounded-lg ${idx === displayedContent.contentFiles!.length - 1
                          ? 'bg-primary/10 border border-primary/20'
                          : ''
                          }`}
                      >
                        {file.type === 'folder' ? (
                          <FolderOpen className="w-5 h-5 text-primary mb-0.5" />
                        ) : (
                          <FileText className="w-5 h-5 text-muted-foreground mb-0.5" />
                        )}
                        <span className="text-[7px] text-foreground text-center truncate w-full">{file.name}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Slides content */}
                {displayedContent?.contentType === 'slides' && displayedContent.contentSlides && (
                  <div className="h-full relative">
                    <Image
                      src={displayedContent.contentSlides[currentSlide] || displayedContent.contentSlides[0]}
                      alt={`Slide ${currentSlide + 1}`}
                      fill
                      className="object-contain transition-opacity duration-300"
                      quality={100}
                      sizes="50vw"
                      unoptimized={true}
                    />
                    {/* Minimal slide indicators */}
                    <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1.5">
                      {displayedContent.contentSlides.map((_, idx) => (
                        <div
                          key={idx}
                          className={`transition-all ${idx === currentSlide
                            ? 'w-4 h-1 rounded-full bg-primary'
                            : 'w-1 h-1 rounded-full bg-muted-foreground/30'
                            }`}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* Table content - mock spreadsheet */}
                {displayedContent?.contentType === 'table' && (
                  <div className="p-3 h-full overflow-hidden">
                    <div className="border rounded-xl overflow-hidden h-full">
                      <table className="w-full text-[7px]">
                        <thead className="border-b">
                          <tr>
                            <th className="px-2 py-1 text-left font-medium text-foreground">Date</th>
                            <th className="px-2 py-1 text-left font-medium text-foreground">Dept</th>
                            <th className="px-2 py-1 text-right font-medium text-foreground">Revenue</th>
                            <th className="px-2 py-1 text-right font-medium text-foreground">Expenses</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            ['2024-01', 'Sales', '245,000', '89,000'],
                            ['2024-02', 'Sales', '268,000', '92,000'],
                            ['2024-03', 'Sales', '289,000', '95,000'],
                            ['2024-04', 'Sales', '312,000', '98,000'],
                            ['2024-05', 'Sales', '298,000', '101,000'],
                            ['2024-06', 'Sales', '334,000', '105,000'],
                          ].map((row, idx) => (
                            <tr key={idx} className="border-b last:border-b-0">
                              <td className="px-2 py-1 text-foreground">{row[0]}</td>
                              <td className="px-2 py-1 text-foreground">{row[1]}</td>
                              <td className="px-2 py-1 text-right text-foreground">{row[2]}</td>
                              <td className="px-2 py-1 text-right text-foreground">{row[3]}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Search content - browser search view */}
                {displayedContent?.contentType === 'search' && (
                  <div className="p-3 h-full overflow-hidden">
                    <div className="border rounded-xl h-full overflow-hidden flex flex-col">
                      {/* Google search bar */}
                      <div className="py-2 flex items-center justify-center border-b">
                        <div className="flex items-center gap-2 border rounded-full px-3 py-1 w-full max-w-[160px]">
                          <Search className="w-2.5 h-2.5 text-muted-foreground" />
                          <span className="text-[8px] text-foreground">LUXY brand identity</span>
                        </div>
                      </div>
                      {/* Search results */}
                      <div className="flex-1 p-2 space-y-2 overflow-auto">
                        <div className="space-y-0.5">
                          <p className="text-[7px] text-muted-foreground">luxy.com</p>
                          <p className="text-[9px] text-primary font-medium">LUXY - Luxury Brand Guidelines</p>
                          <p className="text-[7px] text-muted-foreground">Premium lifestyle brand focusing on minimalist elegance...</p>
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[7px] text-muted-foreground">designtrends.com</p>
                          <p className="text-[9px] text-primary font-medium">Brand Identity Best Practices 2024</p>
                          <p className="text-[7px] text-muted-foreground">Key trends: clean typography, bold colors, memorable logos...</p>
                        </div>
                        <div className="space-y-0.5">
                          <p className="text-[7px] text-muted-foreground">logodesign.io</p>
                          <p className="text-[9px] text-primary font-medium">Logo Design Principles</p>
                          <p className="text-[7px] text-muted-foreground">Creating timeless, scalable brand marks...</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Markdown content - editor view */}
                {displayedContent?.contentType === 'markdown' && displayedContent.contentMarkdown && (
                  <div className="p-3 h-full overflow-hidden">
                    <div className="border rounded-xl h-full overflow-auto p-3 bg-card">
                      <div className="prose prose-sm max-w-none">
                        {displayedContent.contentMarkdown.split('\n').map((line, idx) => {
                          // Helper to render text with inline bold
                          const renderText = (text: string, className: string) => {
                            const parts = text.split(/(\*\*.*?\*\*)/g);
                            return (
                              <span className={className}>
                                {parts.map((part, i) => {
                                  if (part.startsWith('**') && part.endsWith('**')) {
                                    return <strong key={i} className="font-bold">{part.slice(2, -2)}</strong>;
                                  }
                                  return <span key={i}>{part}</span>;
                                })}
                              </span>
                            );
                          };

                          if (line.startsWith('# ')) {
                            return <h1 key={idx} className="text-sm font-bold text-foreground mb-2">{line.slice(2)}</h1>;
                          }
                          if (line.startsWith('## ')) {
                            return <h2 key={idx} className="text-xs font-bold text-foreground mt-3 mb-1.5">{line.slice(3)}</h2>;
                          }
                          if (line.startsWith('### ')) {
                            return <h3 key={idx} className="text-[11px] font-semibold text-foreground mt-2 mb-1">{line.slice(4)}</h3>;
                          }
                          if (line.startsWith('- ')) {
                            return <p key={idx} className="text-[10px] text-muted-foreground ml-3 leading-relaxed">• {renderText(line.slice(2), '')}</p>;
                          }
                          if (line.match(/^\d+\./)) {
                            return <p key={idx} className="text-[10px] text-muted-foreground ml-3 leading-relaxed">{renderText(line, '')}</p>;
                          }
                          if (line.trim() === '') {
                            return <div key={idx} className="h-2" />;
                          }
                          return <p key={idx} className="leading-relaxed">{renderText(line, 'text-[10px] text-muted-foreground')}</p>;
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      </Card>
    </div>
  );
}
