'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  Image as ImageIcon,
  Presentation,
  BarChart3,
  ArrowUpRight,
  FileText,
  Search,
  Users,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';

interface SunaModesPanelProps {
  selectedMode: string | null;
  onModeSelect: (mode: string | null) => void;
  onSelectPrompt: (prompt: string) => void;
  isMobile?: boolean;
}

type ModeType = 'image' | 'slides' | 'data' | 'docs' | 'people' | 'research';

interface Mode {
  id: ModeType;
  label: string;
  icon: React.ReactNode;
  samplePrompts: string[];
  options?: {
    title: string;
    items: Array<{
      id: string;
      name: string;
      image?: string;
      description?: string;
    }>;
  };
  chartTypes?: {
    title: string;
    items: Array<{
      id: string;
      name: string;
      description?: string;
    }>;
  };
}

const modes: Mode[] = [
  {
    id: 'image',
    label: 'Image',
    icon: <ImageIcon className="w-4 h-4" />,
    samplePrompts: [
      'A majestic golden eagle soaring through misty mountain peaks at sunrise with dramatic lighting',
      'Close-up portrait of a fashion model with avant-garde makeup, studio lighting, high contrast shadows',
      'Cozy Scandinavian living room with natural wood furniture, indoor plants, and soft morning sunlight',
      'Futuristic cyberpunk street market at night with neon signs, rain-slicked pavement, and holographic displays',
      'Elegant product photography of luxury perfume bottle on marble surface with soft reflections',
      'Whimsical floating islands connected by rope bridges in a pastel sky with dreamy clouds',
      'Macro close-up of morning dew drops on vibrant flower petals with bokeh background',
      'Modern workspace desk setup with laptop, coffee, notebook, and succulent plants from above',
      'Mystical forest path with ancient trees, glowing fireflies, and ethereal light beams through fog',
      'Architectural detail of contemporary glass building facade with geometric patterns and reflections',
      'Vibrant street food vendor stall with colorful ingredients, steam rising, and warm lighting',
      'Serene Japanese zen garden with raked sand, moss-covered stones, and cherry blossom petals',
      'Dynamic action shot of athlete mid-jump against dramatic sunset sky, silhouette effect',
      'Rustic farmhouse kitchen with copper pots, fresh herbs, wooden cutting boards, and natural textures',
      'Abstract fluid art with swirling metallic gold, deep blue, and emerald green organic patterns',
    ],
    options: {
      title: 'Choose a style',
      items: [
        { id: 'photorealistic', name: 'Photorealistic', image: '/images/image-styles/photorealistic_eagle-min.png' },
        { id: 'watercolor', name: 'Watercolor', image: '/images/image-styles/watercolor_garden-min.png' },
        { id: 'digital-art', name: 'Digital Art', image: '/images/image-styles/digital_art_cyberpunk-min.png' },
        { id: 'oil-painting', name: 'Oil Painting', image: '/images/image-styles/oil_painting_villa-min.png' },
        { id: 'minimalist', name: 'Minimalist', image: '/images/image-styles/minimalist_coffee-min.png' },
        { id: 'isometric', name: 'Isometric', image: '/images/image-styles/isometric_bedroom-min.png' },
        { id: 'vintage', name: 'Vintage', image: '/images/image-styles/vintage_diner-min.png' },
        { id: 'comic', name: 'Comic Book', image: '/images/image-styles/comic_book_robot-min.png' },
        { id: 'neon', name: 'Neon', image: '/images/image-styles/neon_jellyfish-min.png' },
        { id: 'pastel', name: 'Pastel', image: '/images/image-styles/pastel_landscape-min.png' },
        { id: 'geometric', name: 'Geometric', image: '/images/image-styles/geometric_crystal-min.png' },
        { id: 'abstract', name: 'Abstract', image: '/images/image-styles/abstract_organic-min.png' },
        { id: 'anime', name: 'Anime', image: '/images/image-styles/anime_forest-min.png' },
        { id: 'impressionist', name: 'Impressionist', image: '/images/image-styles/impressionist_garden-min.png' },
        { id: 'surreal', name: 'Surreal', image: '/images/image-styles/surreal_islands-min.png' },
      ],
    },
  },
  {
    id: 'slides',
    label: 'Slides',
    icon: <Presentation className="w-4 h-4" />,
    samplePrompts: [
      'Create a Series A pitch deck with market size, traction, and financial projections',
      'Build a Q4 business review showcasing KPIs, wins, and strategic initiatives',
      'Design a product launch presentation with demo videos and customer testimonials',
      'Develop a sales enablement deck explaining our value prop and competitive advantages',
      'Create an investor update highlighting key metrics and upcoming milestones',
      'Build a customer case study presentation showing ROI and success metrics',
      'Design an all-hands presentation covering company updates and vision',
      'Develop a training deck for new product features and workflows',
      'Create a conference talk about scaling engineering teams',
      'Build a board meeting presentation with strategic recommendations',
    ],
    options: {
      title: 'Choose a template',
      items: [
        { id: 'modern', name: 'Modern', description: 'Clean and professional' },
        { id: 'bold', name: 'Bold', description: 'High impact design' },
        { id: 'elegant', name: 'Elegant', description: 'Sophisticated style' },
        { id: 'tech', name: 'Tech', description: 'Technology focused' },
        { id: 'creative', name: 'Creative', description: 'Artistic and unique' },
        { id: 'minimal', name: 'Minimal', description: 'Simple and clear' },
        { id: 'corporate', name: 'Corporate', description: 'Business standard' },
        { id: 'vibrant', name: 'Vibrant', description: 'Colorful and energetic' },
        { id: 'startup', name: 'Startup', description: 'Dynamic and innovative' },
        { id: 'professional', name: 'Professional', description: 'Polished and refined' },
        { id: 'dark', name: 'Dark', description: 'Dark mode aesthetic' },
        { id: 'playful', name: 'Playful', description: 'Fun and engaging' },
        { id: 'sophisticated', name: 'Sophisticated', description: 'Premium luxury feel' },
        { id: 'gradient', name: 'Gradient', description: 'Modern gradients' },
        { id: 'monochrome', name: 'Monochrome', description: 'Black and white' },
        { id: 'futuristic', name: 'Futuristic', description: 'Cutting-edge design' },
      ],
    },
  },
  {
    id: 'data',
    label: 'Data',
    icon: <BarChart3 className="w-4 h-4" />,
    samplePrompts: [
      'Build a financial model projecting ARR growth with different pricing scenarios',
      'Create an interactive sales dashboard tracking metrics by region and quarter',
      'Analyze 50K customer reviews and visualize sentiment trends over time',
      'Design a content calendar tracking campaigns with ROI and engagement charts',
      'Build a cohort analysis showing user retention and churn patterns',
      'Create a marketing attribution model comparing channel performance',
      'Develop a hiring tracker with pipeline metrics and time-to-fill analysis',
      'Build a budget planning spreadsheet with scenario modeling',
      'Analyze website traffic data and visualize conversion funnels',
      'Create an inventory management system with automated reorder alerts',
    ],
    options: {
      title: 'Choose output format',
      items: [
        { id: 'spreadsheet', name: 'Spreadsheet', description: 'Table with formulas' },
        { id: 'dashboard', name: 'Dashboard', description: 'Interactive charts' },
        { id: 'report', name: 'Report', description: 'Analysis with visuals' },
        { id: 'slides', name: 'Slides', description: 'Presentation format' },
      ],
    },
    chartTypes: {
      title: 'Preferred charts',
      items: [
        { id: 'bar', name: 'Bar', description: 'Vertical bar chart' },
        { id: 'line', name: 'Line', description: 'Line chart' },
        { id: 'pie', name: 'Pie', description: 'Pie chart' },
        { id: 'scatter', name: 'Scatter', description: 'Scatter plot' },
        { id: 'heatmap', name: 'Heat map', description: 'Heat map' },
        { id: 'bubble', name: 'Bubble', description: 'Bubble chart' },
        { id: 'area', name: 'Area', description: 'Area chart' },
        { id: 'funnel', name: 'Funnel', description: 'Funnel chart' },
        { id: 'treemap', name: 'Treemap', description: 'Treemap chart' },
        { id: 'sankey', name: 'Sankey', description: 'Sankey diagram' },
      ],
    },
  },
  {
    id: 'docs',
    label: 'Docs',
    icon: <FileText className="w-4 h-4" />,
    samplePrompts: [
      'Write a comprehensive PRD for an AI-powered recommendation engine',
      'Draft a technical architecture document for a scalable microservices platform',
      'Create a go-to-market strategy document for our Q2 product launch',
      'Develop a 90-day onboarding playbook for engineering managers',
      'Write an API documentation guide with examples and best practices',
      'Create a company handbook covering culture, policies, and benefits',
      'Draft a data privacy policy compliant with GDPR and CCPA',
      'Develop a customer success playbook for SaaS enterprise accounts',
      'Write a security incident response plan with escalation procedures',
      'Create a comprehensive style guide for brand and content',
    ],
    options: {
      title: 'Choose a template',
      items: [
        { id: 'prd', name: 'PRD', description: 'Product requirements document' },
        { id: 'technical', name: 'Technical', description: 'Technical documentation' },
        { id: 'proposal', name: 'Proposal', description: 'Business proposal' },
        { id: 'report', name: 'Report', description: 'Detailed report format' },
        { id: 'guide', name: 'Guide', description: 'Step-by-step guide' },
        { id: 'wiki', name: 'Wiki', description: 'Knowledge base article' },
        { id: 'policy', name: 'Policy', description: 'Policy document' },
        { id: 'meeting-notes', name: 'Meeting Notes', description: 'Meeting minutes' },
      ],
    },
  },
  {
    id: 'people',
    label: 'People',
    icon: <Users className="w-4 h-4" />,
    samplePrompts: [
      'Find VP of Engineering candidates at Series B+ AI companies in NYC',
      'Build lead list of CMOs at SaaS companies with 50-200 employees',
      'Research blockchain developers with Solidity experience open to relocation',
      'Generate prospect list of tech founders who raised funding in the last 6 months',
      'Identify Product Managers at fintech startups with 5+ years experience',
      'Find decision-makers at mid-market companies in healthcare IT',
      'Research sales leaders at B2B companies with recent ARR growth',
      'Build list of CTOs at enterprise companies adopting AI infrastructure',
      'Find UX designers with experience in mobile-first e-commerce',
      'Identify DevOps engineers at cloud-native startups in Austin',
    ],
  },
  {
    id: 'research',
    label: 'Research',
    icon: <Search className="w-4 h-4" />,
    samplePrompts: [
      'Analyze emerging trends in quantum computing and potential business applications',
      'Research top 10 competitors in the AI-powered CRM space with feature comparison',
      'Investigate regulatory requirements for launching a fintech app in the EU',
      'Compile market analysis on electric vehicle adoption rates across major markets',
      'Study the impact of remote work on commercial real estate demand in major cities',
      'Research Web3 adoption patterns among Fortune 500 companies',
      'Analyze consumer sentiment towards sustainable fashion brands',
      'Investigate the latest developments in gene therapy for rare diseases',
      'Study pricing strategies of successful D2C subscription box companies',
      'Research the competitive landscape of AI-powered cybersecurity solutions',
    ],
  },
];

// Helper function to get random prompts
const getRandomPrompts = (prompts: string[], count: number): string[] => {
  const shuffled = [...prompts].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
};

export function SunaModesPanel({ selectedMode, onModeSelect, onSelectPrompt, isMobile = false }: SunaModesPanelProps) {
  const currentMode = selectedMode ? modes.find((m) => m.id === selectedMode) : null;
  const promptCount = isMobile ? 2 : 4;
  
  // State to track current random selection of prompts
  const [randomizedPrompts, setRandomizedPrompts] = useState<string[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Randomize prompts when mode changes or on mount
  useEffect(() => {
    if (currentMode) {
      setRandomizedPrompts(getRandomPrompts(currentMode.samplePrompts, promptCount));
    }
  }, [selectedMode, currentMode, promptCount]);

  // Handler for refresh button
  const handleRefreshPrompts = () => {
    if (currentMode) {
      setIsRefreshing(true);
      setRandomizedPrompts(getRandomPrompts(currentMode.samplePrompts, promptCount));
      setTimeout(() => setIsRefreshing(false), 300);
    }
  };

  const displayedPrompts = randomizedPrompts;

  return (
    <div className="w-full space-y-4">
      {/* Mode Tabs - Only show when no mode is selected */}
      {!selectedMode && (
        <div className="flex items-center justify-center animate-in fade-in-0 zoom-in-95 duration-300">
          <div className="inline-flex gap-2">
            {modes.map((mode) => (
              <Button
                key={mode.id}
                variant="outline"
                size="sm"
                onClick={() => onModeSelect(mode.id)}
                className="flex items-center gap-2 shrink-0 transition-all duration-200 bg-background hover:bg-accent rounded-xl text-muted-foreground hover:text-foreground border-border cursor-pointer"
              >
                {mode.icon}
                <span>{mode.label}</span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Sample Prompts - Google List Style (for research, people) */}
      {selectedMode && displayedPrompts && ['research', 'people'].includes(selectedMode) && (
        <div className="space-y-2 animate-in fade-in-0 zoom-in-95 duration-300">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Sample prompts</h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefreshPrompts}
              className="h-7 px-2 text-muted-foreground hover:text-foreground transition-colors duration-200"
            >
              <motion.div
                animate={{ rotate: isRefreshing ? 360 : 0 }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </motion.div>
            </Button>
          </div>
          <div className="space-y-1">
            {displayedPrompts.map((prompt, index) => (
              <motion.div
                key={`${prompt}-${index}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  duration: 0.2,
                  delay: index * 0.03,
                  ease: "easeOut"
                }}
                className="group cursor-pointer rounded-lg hover:bg-accent/50 transition-colors duration-150"
                onClick={() => onSelectPrompt(prompt)}
              >
                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <p className="text-sm text-foreground/70 group-hover:text-foreground transition-colors leading-relaxed flex-1">
                    {prompt}
                  </p>
                  <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-foreground/60 shrink-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Sample Prompts - Card Grid Style (for image, slides, data, docs) */}
      {selectedMode && displayedPrompts && !['research', 'people'].includes(selectedMode) && (
        <div className="space-y-3 animate-in fade-in-0 zoom-in-95 duration-300">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-muted-foreground">Sample prompts</h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefreshPrompts}
              className="h-7 px-2 text-muted-foreground hover:text-foreground transition-colors duration-200"
            >
              <motion.div
                animate={{ rotate: isRefreshing ? 360 : 0 }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </motion.div>
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {displayedPrompts.map((prompt, index) => (
              <motion.div
                key={`${prompt}-${index}`}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{
                  duration: 0.3,
                  delay: index * 0.05,
                  ease: "easeOut"
                }}
              >
                <Card
                  className="p-4 cursor-pointer hover:bg-primary/5 transition-all duration-200 group border border-border rounded-xl"
                  onClick={() => onSelectPrompt(prompt)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-foreground/80 leading-relaxed">{prompt}</p>
                    <ArrowUpRight className="w-4 h-4 text-muted-foreground group-hover:text-primary shrink-0 transition-colors duration-200" />
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Mode-specific Options - Only show when a mode is selected */}
      {selectedMode && currentMode?.options && (
        <div className="space-y-3 animate-in fade-in-0 zoom-in-95 duration-300 delay-75">
          <h3 className="text-sm font-medium text-muted-foreground">
            {currentMode.options.title}
          </h3>
          
          {selectedMode === 'image' && (
            <ScrollArea className="w-full">
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 pb-2">
                {currentMode.options.items.map((item) => (
                  <Card
                    key={item.id}
                    className="flex flex-col items-center gap-2 cursor-pointer group p-2 hover:bg-primary/5 transition-all duration-200 border border-border rounded-xl overflow-hidden"
                    onClick={() => onSelectPrompt(`Generate an image using ${item.name.toLowerCase()} style`)}
                  >
                    <div className="w-full aspect-square bg-gradient-to-br from-muted/50 to-muted rounded-lg border border-border/50 group-hover:border-primary/50 group-hover:scale-105 transition-all duration-200 flex items-center justify-center overflow-hidden relative">
                      {item.image ? (
                        <img 
                          src={item.image} 
                          alt={item.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <ImageIcon className="w-8 h-8 text-muted-foreground/50 group-hover:text-primary/70 transition-colors duration-200" />
                      )}
                    </div>
                    <span className="text-xs text-center text-foreground/70 group-hover:text-foreground transition-colors duration-200 font-medium">
                      {item.name}
                    </span>
                  </Card>
                ))}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          )}

          {selectedMode === 'slides' && (
            <ScrollArea className="w-full">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 pb-2">
                {currentMode.options.items.map((item) => (
                  <Card
                    key={item.id}
                    className="flex flex-col gap-2 cursor-pointer group p-3 hover:bg-primary/5 transition-all duration-200 border border-border rounded-xl"
                    onClick={() =>
                      onSelectPrompt(
                        `Create a presentation using the ${item.name} template about ${item.description}`
                      )
                    }
                  >
                    <div className="w-full aspect-[4/3] bg-gradient-to-br from-muted/50 to-muted rounded-lg border border-border/50 flex items-center justify-center">
                      <Presentation className="w-8 h-8 text-muted-foreground/50 group-hover:text-primary/70 transition-colors duration-200" />
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-xs font-medium text-foreground group-hover:text-primary transition-colors duration-200">
                        {item.name}
                      </p>
                      {item.description && (
                        <p className="text-xs text-muted-foreground line-clamp-1">
                          {item.description}
                        </p>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          )}

          {selectedMode === 'docs' && (
            <ScrollArea className="w-full">
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 pb-2">
                {currentMode.options.items.map((item) => (
                  <Card
                    key={item.id}
                    className="flex flex-col gap-2 cursor-pointer group p-3 hover:bg-primary/5 transition-all duration-200 border border-border rounded-xl"
                    onClick={() =>
                      onSelectPrompt(
                        `Create a ${item.name} document: ${item.description}`
                      )
                    }
                  >
                    <div className="w-full aspect-[3/4] bg-gradient-to-br from-muted/50 to-muted rounded-lg border border-border/50 flex items-center justify-center">
                      <FileText className="w-8 h-8 text-muted-foreground/50 group-hover:text-primary/70 transition-colors duration-200" />
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-xs font-medium text-foreground group-hover:text-primary transition-colors duration-200">
                        {item.name}
                      </p>
                      {item.description && (
                        <p className="text-xs text-muted-foreground line-clamp-1">
                          {item.description}
                        </p>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          )}

          {selectedMode === 'data' && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {currentMode.options.items.map((item) => (
                <Card
                  key={item.id}
                  className="p-3 cursor-pointer hover:bg-primary/5 transition-all duration-200 group border border-border rounded-xl"
                  onClick={() =>
                    onSelectPrompt(`Create a ${item.name.toLowerCase()} for data analysis`)
                  }
                >
                  <div className="flex flex-col items-center gap-2 text-center">
                    <div className="w-full aspect-square bg-muted/30 rounded-xl flex items-center justify-center border border-border/50">
                      <BarChart3 className="w-6 h-6 text-muted-foreground/50 group-hover:text-primary/70 transition-colors duration-200" />
                    </div>
                    <p className="text-xs font-medium text-foreground/80 group-hover:text-primary transition-colors duration-200">
                      {item.name}
                    </p>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Chart Types Section (for Data mode) - Only show when data is selected */}
      {selectedMode === 'data' && currentMode?.chartTypes && (
        <div className="space-y-3 animate-in fade-in-0 zoom-in-95 duration-300 delay-150">
          <h3 className="text-sm font-medium text-muted-foreground">
            {currentMode.chartTypes.title}
          </h3>
          <ScrollArea className="w-full">
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 pb-2">
              {currentMode.chartTypes.items.map((chart) => (
                <Card
                  key={chart.id}
                  className="flex flex-col items-center gap-2 cursor-pointer group p-2 hover:bg-primary/5 transition-all duration-200 border border-border rounded-xl"
                  onClick={() =>
                    onSelectPrompt(`Create a ${chart.name} chart to visualize the data`)
                  }
                >
                  <div className="w-full aspect-square bg-muted/30 rounded-lg border border-border/50 flex items-center justify-center">
                    <BarChart3 className="w-6 h-6 text-muted-foreground/50 group-hover:text-primary/70 transition-colors duration-200" />
                  </div>
                  <span className="text-xs text-center text-foreground/70 group-hover:text-foreground transition-colors duration-200 font-medium">
                    {chart.name}
                  </span>
                </Card>
              ))}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </div>
      )}

    </div>
  );
}

