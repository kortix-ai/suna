'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
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
  Check,
  Table,
  LayoutDashboard,
  FileBarChart,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';

interface SunaModesPanelProps {
  selectedMode: string | null;
  onModeSelect: (mode: string | null) => void;
  onSelectPrompt: (prompt: string) => void;
  isMobile?: boolean;
  selectedCharts?: string[];
  onChartsChange?: (charts: string[]) => void;
  selectedOutputFormat?: string | null;
  onOutputFormatChange?: (format: string | null) => void;
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
        { id: 'wordcloud', name: 'Word cloud', description: 'Word cloud visualization' },
        { id: 'stacked', name: 'Stacked bar', description: 'Stacked bar chart' },
        { id: 'area', name: 'Area', description: 'Area chart' },
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
      'Find VP of Engineering candidates at Series B+ AI/ML startups in San Francisco Bay Area with 10+ years experience and proven track record scaling engineering teams',
      'Build lead list of CMOs at B2B SaaS companies ($10M-$50M ARR) who recently raised Series A/B funding - include email patterns and tech stack',
      'Research Senior Blockchain Engineers with Solidity/Rust experience at top crypto projects, open to relocation to Dubai or Singapore',
      'Generate prospect list of technical founders at Seed-Series A startups in Enterprise AI who raised $2M-$15M in last 6 months',
      'Identify Senior Product Managers at fintech companies with 5-10 years experience from FAANG or unicorns, skilled in 0-1 product development',
      'Find CIOs and VP Engineering at mid-market healthcare IT companies (500-5000 employees) with $500K+ IT budgets planning cloud migration',
      'Research VP Sales at B2B SaaS companies showing 100%+ YoY growth, with 7+ years closing $100K+ deals and PLG experience',
      'Build list of CTOs at enterprise companies actively implementing AI infrastructure with multi-million dollar budgets in 2024',
      'Find Senior UX/UI Designers with mobile-first consumer app experience and 1M+ user portfolios, actively looking or open to opportunities',
      'Identify Senior DevOps Engineers at cloud-native startups with Kubernetes/Terraform expertise and 5-8 years building infrastructure for 10M+ users',
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

// Output format icon component
const OutputFormatIcon = ({ type, className }: { type: string; className?: string }) => {
  const baseClasses = cn('w-full h-full', className);
  
  switch (type) {
    case 'spreadsheet':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          {/* Table background */}
          <rect x="10" y="20" width="80" height="60" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="4"/>
          
          {/* Header row background */}
          <rect x="10" y="20" width="80" height="12" fill="currentColor" opacity="0.15" rx="4" />
          
          {/* Grid lines - horizontal */}
          <line x1="10" y1="32" x2="90" y2="32" stroke="currentColor" strokeWidth="2" opacity="0.4"/>
          <line x1="10" y1="44" x2="90" y2="44" stroke="currentColor" strokeWidth="1" opacity="0.25"/>
          <line x1="10" y1="56" x2="90" y2="56" stroke="currentColor" strokeWidth="1" opacity="0.25"/>
          <line x1="10" y1="68" x2="90" y2="68" stroke="currentColor" strokeWidth="1" opacity="0.25"/>
          
          {/* Grid lines - vertical */}
          <line x1="30" y1="20" x2="30" y2="80" stroke="currentColor" strokeWidth="1.5" opacity="0.3"/>
          <line x1="50" y1="20" x2="50" y2="80" stroke="currentColor" strokeWidth="1" opacity="0.25"/>
          <line x1="70" y1="20" x2="70" y2="80" stroke="currentColor" strokeWidth="1" opacity="0.25"/>
          
          {/* Data cells */}
          <rect x="14" y="24" width="12" height="5" fill="currentColor" opacity="0.7" rx="1"/>
          <rect x="34" y="36" width="12" height="5" fill="currentColor" opacity="0.5" rx="1"/>
          <rect x="54" y="48" width="12" height="5" fill="currentColor" opacity="0.4" rx="1"/>
          <rect x="74" y="60" width="12" height="5" fill="currentColor" opacity="0.5" rx="1"/>
          <rect x="14" y="48" width="12" height="5" fill="currentColor" opacity="0.4" rx="1"/>
          <rect x="34" y="60" width="12" height="5" fill="currentColor" opacity="0.5" rx="1"/>
          
          {/* Formula bar */}
          <rect x="10" y="10" width="80" height="7" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.2" rx="2"/>
          <text x="13" y="15" fontSize="6" opacity="0.4">fx</text>
          <rect x="22" y="12" width="30" height="3" fill="currentColor" opacity="0.3" rx="0.5"/>
        </svg>
      );
    
    case 'dashboard':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          {/* Top left widget - KPI */}
          <rect x="10" y="15" width="35" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3" rx="4"/>
          <rect x="10" y="15" width="35" height="8" fill="currentColor" opacity="0.1" rx="4"/>
          <circle cx="17" cy="19" r="2" fill="currentColor" opacity="0.6"/>
          <rect x="22" y="17.5" width="18" height="3" fill="currentColor" opacity="0.4" rx="1"/>
          <text x="15" y="36" fontSize="12" opacity="0.7" fontWeight="600">42K</text>
          
          {/* Top right widget - Line chart */}
          <rect x="52" y="15" width="38" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3" rx="4"/>
          <path d="M 58,35 L 65,30 L 72,32 L 79,28 L 84,31" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.6" strokeLinecap="round"/>
          <circle cx="58" cy="35" r="1.5" fill="currentColor" opacity="0.7"/>
          <circle cx="65" cy="30" r="1.5" fill="currentColor" opacity="0.7"/>
          <circle cx="72" cy="32" r="1.5" fill="currentColor" opacity="0.7"/>
          <circle cx="79" cy="28" r="1.5" fill="currentColor" opacity="0.7"/>
          <circle cx="84" cy="31" r="1.5" fill="currentColor" opacity="0.7"/>
          
          {/* Bottom widget - Bar chart */}
          <rect x="10" y="50" width="80" height="35" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3" rx="4"/>
          <rect x="18" y="65" width="8" height="15" fill="currentColor" opacity="0.5" rx="1"/>
          <rect x="32" y="60" width="8" height="20" fill="currentColor" opacity="0.6" rx="1"/>
          <rect x="46" y="62" width="8" height="18" fill="currentColor" opacity="0.5" rx="1"/>
          <rect x="60" y="55" width="8" height="25" fill="currentColor" opacity="0.7" rx="1"/>
          <rect x="74" y="58" width="8" height="22" fill="currentColor" opacity="0.6" rx="1"/>
          <line x1="10" y1="80" x2="90" y2="80" stroke="currentColor" strokeWidth="1" opacity="0.2"/>
        </svg>
      );
    
    case 'report':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          {/* Document */}
          <rect x="20" y="10" width="60" height="80" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="3"/>
          
          {/* Page fold effect */}
          <path d="M 70,10 L 80,20 L 80,10 Z" fill="currentColor" opacity="0.1"/>
          
          {/* Title */}
          <rect x="28" y="20" width="44" height="5" fill="currentColor" opacity="0.8" rx="1"/>
          
          {/* Subtitle */}
          <rect x="28" y="28" width="30" height="3" fill="currentColor" opacity="0.4" rx="0.5"/>
          
          {/* Paragraph lines */}
          <rect x="28" y="36" width="44" height="2" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="28" y="40" width="40" height="2" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="28" y="44" width="42" height="2" fill="currentColor" opacity="0.3" rx="0.5"/>
          
          {/* Chart section */}
          <rect x="28" y="52" width="44" height="22" fill="currentColor" opacity="0.05" rx="2"/>
          <rect x="34" y="64" width="6" height="8" fill="currentColor" opacity="0.6" rx="0.5"/>
          <rect x="42" y="60" width="6" height="12" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="50" y="62" width="6" height="10" fill="currentColor" opacity="0.6" rx="0.5"/>
          <rect x="58" y="58" width="6" height="14" fill="currentColor" opacity="0.8" rx="0.5"/>
          <line x1="28" y1="72" x2="72" y2="72" stroke="currentColor" strokeWidth="0.5" opacity="0.3"/>
          
          {/* More text */}
          <rect x="28" y="78" width="38" height="2" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="28" y="82" width="44" height="2" fill="currentColor" opacity="0.3" rx="0.5"/>
        </svg>
      );
    
    case 'slides':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          {/* Main slide */}
          <rect x="15" y="20" width="70" height="52" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.4" rx="3"/>
          
          {/* Title area */}
          <rect x="22" y="28" width="35" height="5" fill="currentColor" opacity="0.8" rx="1"/>
          
          {/* Subtitle */}
          <rect x="22" y="36" width="25" height="3" fill="currentColor" opacity="0.5" rx="0.5"/>
          
          {/* Content bullets */}
          <circle cx="24" cy="46" r="1" fill="currentColor" opacity="0.6"/>
          <rect x="28" y="45" width="20" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          
          <circle cx="24" cy="52" r="1" fill="currentColor" opacity="0.6"/>
          <rect x="28" y="51" width="18" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          
          <circle cx="24" cy="58" r="1" fill="currentColor" opacity="0.6"/>
          <rect x="28" y="57" width="22" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          
          {/* Image placeholder */}
          <rect x="58" y="44" width="20" height="20" fill="currentColor" opacity="0.1" rx="2"/>
          <circle cx="68" cy="54" r="6" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3"/>
          <path d="M 60,60 L 65,55 L 70,58 L 76,52" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.4"/>
          
          {/* Slide indicators */}
          <rect x="20" y="78" width="10" height="6" fill="currentColor" opacity="0.3" rx="1"/>
          <rect x="35" y="78" width="10" height="6" fill="currentColor" opacity="0.7" rx="1"/>
          <rect x="50" y="78" width="10" height="6" fill="currentColor" opacity="0.3" rx="1"/>
          <rect x="65" y="78" width="10" height="6" fill="currentColor" opacity="0.3" rx="1"/>
        </svg>
      );
    
    default:
      return <Table className="w-6 h-6" />;
  }
};

// Slide template icon component
const SlideTemplateIcon = ({ type, className }: { type: string; className?: string }) => {
  const baseClasses = cn('w-full h-full', className);
  
  switch (type) {
    case 'modern':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="15" y="20" width="70" height="50" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="3"/>
          <rect x="20" y="28" width="30" height="4" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="20" y="36" width="20" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          <line x1="20" y1="44" x2="38" y2="44" stroke="currentColor" strokeWidth="1" opacity="0.3"/>
          <rect x="20" y="48" width="25" height="2" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="20" y="52" width="22" height="2" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="55" y="28" width="25" height="25" fill="currentColor" opacity="0.15" rx="2"/>
          <circle cx="67.5" cy="40.5" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.5"/>
          <rect x="25" y="75" width="50" height="3" fill="currentColor" opacity="0.2" rx="1"/>
        </svg>
      );
    
    case 'bold':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="10" y="15" width="80" height="55" fill="currentColor" opacity="0.15" rx="4"/>
          <rect x="15" y="22" width="35" height="8" fill="currentColor" opacity="0.9" rx="2"/>
          <rect x="15" y="35" width="28" height="4" fill="currentColor" opacity="0.7" rx="1"/>
          <rect x="15" y="43" width="32" height="4" fill="currentColor" opacity="0.7" rx="1"/>
          <rect x="15" y="51" width="30" height="4" fill="currentColor" opacity="0.7" rx="1"/>
          <rect x="55" y="22" width="30" height="18" fill="currentColor" opacity="0.8" rx="2"/>
          <circle cx="70" cy="31" r="5" fill="var(--background)" opacity="0.9"/>
          <rect x="10" y="75" width="80" height="8" fill="currentColor" opacity="0.9" rx="2"/>
        </svg>
      );
    
    case 'elegant':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <line x1="30" y1="25" x2="70" y2="25" stroke="currentColor" strokeWidth="0.5" opacity="0.3"/>
          <rect x="35" y="32" width="30" height="5" fill="currentColor" opacity="0.7" rx="1"/>
          <rect x="40" y="42" width="20" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          <circle cx="50" cy="55" r="1" fill="currentColor" opacity="0.5"/>
          <rect x="30" y="60" width="40" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="32" y="64" width="36" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="34" y="68" width="32" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <line x1="30" y1="78" x2="70" y2="78" stroke="currentColor" strokeWidth="0.5" opacity="0.3"/>
          <path d="M 48,25 L 50,20 L 52,25" stroke="currentColor" strokeWidth="0.5" fill="none" opacity="0.4"/>
        </svg>
      );
    
    case 'tech':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="15" y="20" width="70" height="50" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4" rx="2"/>
          <path d="M 15,30 L 85,30" stroke="currentColor" strokeWidth="1" opacity="0.3"/>
          <circle cx="20" cy="25" r="1.5" fill="currentColor" opacity="0.6"/>
          <circle cx="26" cy="25" r="1.5" fill="currentColor" opacity="0.6"/>
          <circle cx="32" cy="25" r="1.5" fill="currentColor" opacity="0.6"/>
          <rect x="20" y="36" width="25" height="3" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="20" y="42" width="18" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          <path d="M 55,38 L 60,43 L 55,48" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.6"/>
          <path d="M 65,38 L 75,38 L 75,58 L 65,58" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.5"/>
          <rect x="20" y="52" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
          <path d="M 20,58 L 32,58 M 26,52 L 26,64" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
        </svg>
      );
    
    case 'creative':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <path d="M 20,25 Q 25,20 35,25 L 40,35 Q 30,30 20,35 Z" opacity="0.6"/>
          <circle cx="70" cy="30" r="8" opacity="0.5"/>
          <path d="M 15,45 L 45,45 L 42,55 L 18,55 Z" opacity="0.7"/>
          <rect x="50" y="48" width="35" height="2" fill="currentColor" opacity="0.4" rx="1" transform="rotate(-5 67.5 49)"/>
          <rect x="50" y="54" width="30" height="2" fill="currentColor" opacity="0.4" rx="1" transform="rotate(3 65 55)"/>
          <circle cx="25" cy="68" r="3" opacity="0.6"/>
          <circle cx="40" cy="65" r="5" opacity="0.5"/>
          <circle cx="60" cy="70" r="4" opacity="0.7"/>
          <path d="M 70,65 L 80,70 L 75,75 Z" opacity="0.6"/>
        </svg>
      );
    
    case 'minimal':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="30" y="35" width="40" height="3" fill="currentColor" opacity="0.8" rx="0.5"/>
          <rect x="35" y="45" width="30" height="1.5" fill="currentColor" opacity="0.4" rx="0.5"/>
          <rect x="35" y="50" width="30" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="35" y="55" width="30" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <circle cx="50" cy="68" r="1.5" fill="currentColor" opacity="0.5"/>
        </svg>
      );
    
    case 'corporate':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="10" y="15" width="80" height="60" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="2"/>
          <rect x="10" y="15" width="80" height="12" fill="currentColor" opacity="0.15"/>
          <rect x="18" y="35" width="30" height="4" fill="currentColor" opacity="0.7" rx="1"/>
          <rect x="18" y="42" width="25" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          <rect x="18" y="47" width="28" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          <rect x="18" y="52" width="26" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          <rect x="55" y="35" width="28" height="20" fill="currentColor" opacity="0.2" rx="2"/>
          <rect x="60" y="45" width="5" height="8" fill="currentColor" opacity="0.6" rx="0.5"/>
          <rect x="68" y="42" width="5" height="11" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="76" y="40" width="5" height="13" fill="currentColor" opacity="0.8" rx="0.5"/>
          <rect x="35" y="80" width="30" height="3" fill="currentColor" opacity="0.5" rx="1"/>
        </svg>
      );
    
    case 'vibrant':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="15" y="20" width="70" height="50" fill="currentColor" opacity="0.12" rx="4"/>
          <circle cx="30" cy="35" r="8" fill="currentColor" opacity="0.7"/>
          <circle cx="50" cy="32" r="10" fill="currentColor" opacity="0.8"/>
          <circle cx="70" cy="36" r="7" fill="currentColor" opacity="0.6"/>
          <rect x="20" y="50" width="15" height="3" fill="currentColor" opacity="0.9" rx="1"/>
          <rect x="40" y="50" width="20" height="3" fill="currentColor" opacity="0.85" rx="1"/>
          <rect x="65" y="50" width="12" height="3" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="22" y="58" width="10" height="2" fill="currentColor" opacity="0.5" rx="0.5"/>
          <rect x="42" y="58" width="15" height="2" fill="currentColor" opacity="0.5" rx="0.5"/>
          <rect x="67" y="58" width="8" height="2" fill="currentColor" opacity="0.5" rx="0.5"/>
        </svg>
      );
    
    case 'startup':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <path d="M 50,25 L 55,35 L 45,35 Z" opacity="0.8"/>
          <rect x="48" y="35" width="4" height="15" opacity="0.7"/>
          <circle cx="35" cy="55" r="3" opacity="0.4"/>
          <circle cx="50" cy="50" r="5" opacity="0.6"/>
          <circle cx="65" cy="55" r="3" opacity="0.4"/>
          <path d="M 30,60 Q 50,50 70,60" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.5"/>
          <rect x="32" y="65" width="36" height="2" fill="currentColor" opacity="0.6" rx="1"/>
          <rect x="35" y="70" width="30" height="2" fill="currentColor" opacity="0.4" rx="1"/>
          <circle cx="25" cy="40" r="1.5" opacity="0.3"/>
          <circle cx="75" cy="42" r="1.5" opacity="0.3"/>
          <circle cx="28" cy="32" r="1" opacity="0.25"/>
        </svg>
      );
    
    case 'professional':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="20" y="22" width="60" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.35" rx="2"/>
          <rect x="25" y="28" width="25" height="4" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="25" y="36" width="20" height="2" fill="currentColor" opacity="0.5" rx="0.5"/>
          <rect x="25" y="40" width="22" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          <rect x="25" y="44" width="18" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          <line x1="25" y1="52" x2="75" y2="52" stroke="currentColor" strokeWidth="1" opacity="0.25"/>
          <rect x="25" y="56" width="15" height="2" fill="currentColor" opacity="0.5" rx="0.5"/>
          <rect x="25" y="60" width="18" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          <rect x="55" y="28" width="20" height="15" fill="currentColor" opacity="0.2" rx="1"/>
          <rect x="60" y="56" width="8" height="10" fill="currentColor" opacity="0.6" rx="0.5"/>
          <rect x="70" y="60" width="8" height="6" fill="currentColor" opacity="0.5" rx="0.5"/>
        </svg>
      );
    
    case 'dark':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="15" y="20" width="70" height="50" fill="currentColor" opacity="0.9" rx="3"/>
          <rect x="20" y="26" width="25" height="4" fill="var(--background)" opacity="0.8" rx="1"/>
          <rect x="20" y="34" width="18" height="2" fill="var(--background)" opacity="0.5" rx="0.5"/>
          <rect x="20" y="38" width="20" height="2" fill="var(--background)" opacity="0.4" rx="0.5"/>
          <rect x="20" y="42" width="16" height="2" fill="var(--background)" opacity="0.4" rx="0.5"/>
          <circle cx="65" cy="38" r="10" fill="var(--background)" opacity="0.3"/>
          <circle cx="65" cy="38" r="6" fill="currentColor" opacity="0.9"/>
          <rect x="20" y="55" width="60" height="10" fill="var(--background)" opacity="0.2" rx="1"/>
        </svg>
      );
    
    case 'playful':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <circle cx="30" cy="30" r="8" opacity="0.7"/>
          <rect x="45" y="25" width="30" height="4" opacity="0.8" rx="2" transform="rotate(-3 60 27)"/>
          <rect x="48" y="33" width="25" height="2" opacity="0.5" rx="1" transform="rotate(2 60.5 34)"/>
          <path d="M 20,45 Q 25,50 30,45 T 40,45" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.6"/>
          <circle cx="55" cy="48" r="4" opacity="0.6"/>
          <circle cx="68" cy="46" r="5" opacity="0.7"/>
          <path d="M 20,60 L 35,58 L 33,68 L 22,65 Z" opacity="0.65"/>
          <rect x="45" y="60" width="20" height="3" opacity="0.6" rx="1.5" transform="rotate(-2 55 61.5)"/>
          <rect x="48" y="67" width="15" height="2" opacity="0.5" rx="1" transform="rotate(3 55.5 68)"/>
          <circle cx="75" cy="65" r="3" opacity="0.5"/>
        </svg>
      );
    
    case 'sophisticated':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="25" y="25" width="50" height="40" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3" rx="1"/>
          <line x1="25" y1="35" x2="75" y2="35" stroke="currentColor" strokeWidth="0.5" opacity="0.25"/>
          <circle cx="30" cy="30" r="2" opacity="0.6"/>
          <rect x="35" y="29" width="15" height="2" fill="currentColor" opacity="0.5" rx="0.5"/>
          <line x1="28" y1="40" x2="72" y2="40" stroke="currentColor" strokeWidth="0.5" opacity="0.2"/>
          <line x1="28" y1="45" x2="72" y2="45" stroke="currentColor" strokeWidth="0.5" opacity="0.2"/>
          <line x1="28" y1="50" x2="72" y2="50" stroke="currentColor" strokeWidth="0.5" opacity="0.2"/>
          <line x1="28" y1="55" x2="72" y2="55" stroke="currentColor" strokeWidth="0.5" opacity="0.2"/>
          <rect x="52" y="42" width="18" height="18" fill="currentColor" opacity="0.15" rx="1"/>
          <path d="M 30,70 L 35,75 L 40,70" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.4"/>
          <path d="M 60,70 L 65,75 L 70,70" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.4"/>
        </svg>
      );
    
    case 'gradient':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <defs>
            <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style={{ stopColor: 'currentColor', stopOpacity: 0.8 }} />
              <stop offset="100%" style={{ stopColor: 'currentColor', stopOpacity: 0.3 }} />
            </linearGradient>
          </defs>
          <rect x="15" y="20" width="70" height="50" fill="url(#grad1)" rx="3"/>
          <rect x="22" y="28" width="28" height="5" fill="var(--background)" opacity="0.9" rx="1"/>
          <rect x="22" y="37" width="20" height="2" fill="var(--background)" opacity="0.6" rx="0.5"/>
          <rect x="22" y="42" width="22" height="2" fill="var(--background)" opacity="0.5" rx="0.5"/>
          <circle cx="65" cy="40" r="12" fill="var(--background)" opacity="0.4"/>
          <rect x="22" y="55" width="56" height="8" fill="var(--background)" opacity="0.3" rx="1"/>
        </svg>
      );
    
    case 'monochrome':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="20" y="25" width="60" height="45" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.8" rx="1"/>
          <rect x="25" y="32" width="25" height="5" fill="currentColor" opacity="0.9" rx="0.5"/>
          <rect x="25" y="40" width="20" height="2" fill="currentColor" opacity="0.6" rx="0.5"/>
          <rect x="25" y="44" width="22" height="2" fill="currentColor" opacity="0.5" rx="0.5"/>
          <rect x="25" y="48" width="18" height="2" fill="currentColor" opacity="0.5" rx="0.5"/>
          <rect x="55" y="32" width="20" height="20" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="60" y="37" width="10" height="10" fill="var(--background)" opacity="0.9"/>
          <rect x="25" y="58" width="50" height="8" fill="currentColor" opacity="0.3" rx="0.5"/>
        </svg>
      );
    
    case 'futuristic':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <path d="M 20,25 L 80,25 L 75,65 L 25,65 Z" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4"/>
          <path d="M 25,30 L 75,30" stroke="currentColor" strokeWidth="1" opacity="0.3"/>
          <rect x="28" y="35" width="20" height="3" fill="currentColor" opacity="0.8" rx="0.5" transform="skewX(-5)"/>
          <rect x="28" y="42" width="15" height="2" fill="currentColor" opacity="0.5" rx="0.5" transform="skewX(-5)"/>
          <path d="M 55,38 L 68,38 L 66,48 L 53,48 Z" fill="currentColor" opacity="0.6"/>
          <circle cx="60" cy="43" r="3" fill="var(--background)" opacity="0.8"/>
          <path d="M 28,52 L 50,52 M 32,56 L 48,56" stroke="currentColor" strokeWidth="1.5" opacity="0.4"/>
          <circle cx="30" cy="38" r="1.5" fill="currentColor" opacity="0.7"/>
          <circle cx="70" cy="52" r="1.5" fill="currentColor" opacity="0.6"/>
          <path d="M 30,72 L 35,68 L 40,72 L 35,76 Z" fill="currentColor" opacity="0.5"/>
          <path d="M 60,72 L 65,68 L 70,72 L 65,76 Z" fill="currentColor" opacity="0.5"/>
        </svg>
      );
    
    default:
      return <Presentation className="w-6 h-6" />;
  }
};

// Docs template icon component
const DocsTemplateIcon = ({ type, className }: { type: string; className?: string }) => {
  const baseClasses = cn('w-full h-full', className);
  
  switch (type) {
    case 'prd':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="20" y="15" width="60" height="70" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="3"/>
          <rect x="25" y="22" width="30" height="5" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="25" y="30" width="20" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          
          <rect x="25" y="38" width="15" height="3" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="25" y="44" width="48" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="48" width="45" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          
          <rect x="25" y="55" width="18" height="3" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="28" y="60" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
          <path d="M 29,61 L 30,62.5 L 31.5,60.5" stroke="currentColor" strokeWidth="0.8" fill="none" opacity="0.7"/>
          <rect x="33" y="61" width="20" height="1.5" fill="currentColor" opacity="0.4" rx="0.5"/>
          <rect x="28" y="65" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
          <rect x="33" y="66" width="18" height="1.5" fill="currentColor" opacity="0.4" rx="0.5"/>
          
          <rect x="25" y="73" width="15" height="3" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="25" y="78" width="30" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
        </svg>
      );
    
    case 'technical':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="20" y="15" width="60" height="70" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="3"/>
          <rect x="25" y="22" width="25" height="4" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="25" y="29" width="18" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          
          <rect x="25" y="37" width="48" height="15" fill="currentColor" opacity="0.1" rx="2"/>
          <text x="28" y="44" fontSize="6" opacity="0.5" fontFamily="monospace">{'<code>'}</text>
          <rect x="30" y="46" width="20" height="1" fill="currentColor" opacity="0.4" rx="0.3"/>
          <rect x="32" y="49" width="18" height="1" fill="currentColor" opacity="0.4" rx="0.3"/>
          
          <rect x="25" y="57" width="15" height="2.5" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="25" y="62" width="48" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="66" width="45" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="70" width="40" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          
          <circle cx="72" cy="25" r="3" fill="currentColor" opacity="0.6"/>
          <path d="M 70,25 L 71,26 L 74,23" stroke="var(--background)" strokeWidth="1" fill="none"/>
        </svg>
      );
    
    case 'proposal':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="20" y="15" width="60" height="70" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="3"/>
          
          <circle cx="50" cy="28" r="6" fill="currentColor" opacity="0.6"/>
          <path d="M 50,34 L 50,40" stroke="currentColor" strokeWidth="2" opacity="0.6"/>
          <path d="M 50,40 L 46,45 M 50,40 L 54,45" stroke="currentColor" strokeWidth="2" opacity="0.6"/>
          
          <rect x="30" y="50" width="40" height="3" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="32" y="56" width="36" height="2" fill="currentColor" opacity="0.5" rx="0.5"/>
          
          <rect x="25" y="63" width="22" height="15" fill="currentColor" opacity="0.15" rx="2"/>
          <rect x="29" y="68" width="5" height="6" fill="currentColor" opacity="0.6" rx="0.5"/>
          <rect x="36" y="70" width="5" height="4" fill="currentColor" opacity="0.5" rx="0.5"/>
          
          <rect x="52" y="63" width="22" height="15" fill="currentColor" opacity="0.15" rx="2"/>
          <circle cx="63" cy="70" r="4" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.6"/>
          <path d="M 66,73 L 69,76" stroke="currentColor" strokeWidth="1.5" opacity="0.6"/>
        </svg>
      );
    
    case 'report':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="20" y="15" width="60" height="70" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="3"/>
          <rect x="25" y="22" width="35" height="4" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="25" y="29" width="25" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          
          <line x1="25" y1="37" x2="75" y2="37" stroke="currentColor" strokeWidth="1" opacity="0.2"/>
          
          <rect x="25" y="42" width="48" height="18" fill="currentColor" opacity="0.08" rx="2"/>
          <rect x="30" y="52" width="5" height="6" fill="currentColor" opacity="0.6" rx="0.5"/>
          <rect x="37" y="50" width="5" height="8" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="44" y="48" width="5" height="10" fill="currentColor" opacity="0.8" rx="0.5"/>
          <rect x="51" y="50" width="5" height="8" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="58" y="53" width="5" height="5" fill="currentColor" opacity="0.6" rx="0.5"/>
          <line x1="25" y1="58" x2="73" y2="58" stroke="currentColor" strokeWidth="0.5" opacity="0.3"/>
          
          <rect x="25" y="66" width="48" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="70" width="45" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="74" width="40" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="78" width="43" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
        </svg>
      );
    
    case 'guide':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="20" y="15" width="60" height="70" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="3"/>
          <rect x="25" y="22" width="28" height="4" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="25" y="29" width="20" height="2" fill="currentColor" opacity="0.4" rx="0.5"/>
          
          <circle cx="30" cy="41" r="4" fill="currentColor" opacity="0.7"/>
          <text x="28" y="44" fontSize="6" fill="var(--background)" fontWeight="bold">1</text>
          <rect x="37" y="38" width="15" height="2.5" fill="currentColor" opacity="0.6" rx="0.5"/>
          <rect x="37" y="42" width="30" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          
          <circle cx="30" cy="53" r="4" fill="currentColor" opacity="0.7"/>
          <text x="28" y="56" fontSize="6" fill="var(--background)" fontWeight="bold">2</text>
          <rect x="37" y="50" width="18" height="2.5" fill="currentColor" opacity="0.6" rx="0.5"/>
          <rect x="37" y="54" width="32" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          
          <circle cx="30" cy="65" r="4" fill="currentColor" opacity="0.7"/>
          <text x="28" y="68" fontSize="6" fill="var(--background)" fontWeight="bold">3</text>
          <rect x="37" y="62" width="16" height="2.5" fill="currentColor" opacity="0.6" rx="0.5"/>
          <rect x="37" y="66" width="28" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          
          <circle cx="30" cy="77" r="4" fill="currentColor" opacity="0.7"/>
          <text x="28" y="80" fontSize="6" fill="var(--background)" fontWeight="bold">4</text>
          <rect x="37" y="74" width="20" height="2.5" fill="currentColor" opacity="0.6" rx="0.5"/>
        </svg>
      );
    
    case 'wiki':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="20" y="15" width="60" height="70" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="3"/>
          
          <path d="M 30,23 L 35,32 L 40,23 L 45,32 L 50,23" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.6" strokeLinecap="round"/>
          
          <rect x="25" y="38" width="25" height="3" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="25" y="44" width="48" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="48" width="45" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="52" width="40" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          
          <rect x="25" y="59" width="20" height="3" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="25" y="65" width="35" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="69" width="38" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          
          <rect x="55" y="38" width="18" height="14" fill="currentColor" opacity="0.12" rx="2"/>
          <circle cx="64" cy="45" r="3" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.5"/>
          <path d="M 57,49 L 60,46 L 64,48 L 71,43" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.5"/>
          
          <path d="M 30,78 L 35,75 L 40,78" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.4" strokeLinecap="round"/>
          <path d="M 45,78 L 50,75 L 55,78" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.4" strokeLinecap="round"/>
        </svg>
      );
    
    case 'policy':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="20" y="15" width="60" height="70" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="3"/>
          
          <path d="M 48,20 L 50,25 L 52,20" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.4"/>
          <circle cx="50" cy="30" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" opacity="0.6"/>
          <path d="M 50,35 L 50,38" stroke="currentColor" strokeWidth="1.5" opacity="0.6"/>
          <circle cx="50" cy="39" r="1" fill="currentColor" opacity="0.6"/>
          
          <rect x="30" y="45" width="40" height="3" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="32" y="51" width="36" height="2" fill="currentColor" opacity="0.5" rx="0.5"/>
          
          <line x1="28" y1="58" x2="72" y2="58" stroke="currentColor" strokeWidth="0.5" opacity="0.2"/>
          
          <rect x="25" y="62" width="48" height="1.5" fill="currentColor" opacity="0.4" rx="0.5"/>
          <rect x="25" y="66" width="45" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="70" width="48" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="74" width="40" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="78" width="45" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          
          <rect x="60" y="80" width="15" height="3" fill="currentColor" opacity="0.15" rx="1"/>
          <text x="62" y="83" fontSize="5" opacity="0.5">Sign</text>
        </svg>
      );
    
    case 'meeting-notes':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="20" y="15" width="60" height="70" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.3" rx="3"/>
          
          <circle cx="28" cy="23" r="2" fill="currentColor" opacity="0.6"/>
          <circle cx="35" cy="23" r="2" fill="currentColor" opacity="0.6"/>
          <circle cx="42" cy="23" r="2" fill="currentColor" opacity="0.6"/>
          
          <rect x="25" y="30" width="30" height="3.5" fill="currentColor" opacity="0.8" rx="1"/>
          <rect x="58" y="30" width="15" height="3" fill="currentColor" opacity="0.5" rx="1"/>
          
          <rect x="25" y="38" width="12" height="2.5" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="25" y="43" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
          <rect x="30" y="44" width="25" height="1.5" fill="currentColor" opacity="0.4" rx="0.5"/>
          <rect x="25" y="48" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
          <path d="M 26,49 L 27,50.5 L 28.5,48.5" stroke="currentColor" strokeWidth="0.8" fill="none" opacity="0.7"/>
          <rect x="30" y="49" width="28" height="1.5" fill="currentColor" opacity="0.4" rx="0.5"/>
          <rect x="25" y="53" width="3" height="3" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5"/>
          <rect x="30" y="54" width="22" height="1.5" fill="currentColor" opacity="0.4" rx="0.5"/>
          
          <rect x="25" y="62" width="15" height="2.5" fill="currentColor" opacity="0.7" rx="0.5"/>
          <rect x="25" y="67" width="35" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="71" width="40" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          <rect x="25" y="75" width="32" height="1.5" fill="currentColor" opacity="0.3" rx="0.5"/>
          
          <circle cx="72" cy="78" r="4" fill="currentColor" opacity="0.6"/>
          <path d="M 70,78 L 71.5,79.5 L 74,77" stroke="var(--background)" strokeWidth="1" fill="none"/>
        </svg>
      );
    
    default:
      return <FileText className="w-6 h-6" />;
  }
};

// Chart icon component
const ChartIcon = ({ type, className }: { type: string; className?: string }) => {
  const baseClasses = cn('w-full h-full', className);
  
  switch (type) {
    case 'bar':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <rect x="15" y="50" width="14" height="35" opacity="0.7" rx="2"/>
          <rect x="35" y="35" width="14" height="50" opacity="0.8" rx="2"/>
          <rect x="55" y="45" width="14" height="40" opacity="0.7" rx="2"/>
          <rect x="75" y="25" width="14" height="60" opacity="0.85" rx="2"/>
          <line x1="10" y1="85" x2="95" y2="85" stroke="currentColor" strokeWidth="1.5" opacity="0.3"/>
        </svg>
      );
    
    case 'line':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="none">
          {/* Grid lines */}
          <line x1="10" y1="85" x2="90" y2="85" stroke="currentColor" strokeWidth="1" opacity="0.2"/>
          <line x1="10" y1="70" x2="90" y2="70" stroke="currentColor" strokeWidth="0.5" opacity="0.1" strokeDasharray="2,2"/>
          <line x1="10" y1="55" x2="90" y2="55" stroke="currentColor" strokeWidth="0.5" opacity="0.1" strokeDasharray="2,2"/>
          <line x1="10" y1="40" x2="90" y2="40" stroke="currentColor" strokeWidth="0.5" opacity="0.1" strokeDasharray="2,2"/>
          <line x1="10" y1="25" x2="90" y2="25" stroke="currentColor" strokeWidth="0.5" opacity="0.1" strokeDasharray="2,2"/>
          
          {/* Line path */}
          <path d="M 15,70 L 30,50 L 45,55 L 60,35 L 75,30 L 90,40" 
                stroke="currentColor" 
                strokeWidth="2.5" 
                opacity="0.7"
                strokeLinecap="round" 
                strokeLinejoin="round"
                fill="none"/>
          
          {/* Area fill */}
          <path d="M 15,70 L 30,50 L 45,55 L 60,35 L 75,30 L 90,40 L 90,85 L 15,85 Z" 
                fill="currentColor" 
                opacity="0.1"/>
          
          {/* Data points */}
          <circle cx="15" cy="70" r="3" fill="currentColor" opacity="0.8"/>
          <circle cx="30" cy="50" r="3" fill="currentColor" opacity="0.8"/>
          <circle cx="45" cy="55" r="3" fill="currentColor" opacity="0.8"/>
          <circle cx="60" cy="35" r="3" fill="currentColor" opacity="0.8"/>
          <circle cx="75" cy="30" r="3" fill="currentColor" opacity="0.8"/>
          <circle cx="90" cy="40" r="3" fill="currentColor" opacity="0.8"/>
        </svg>
      );
    
    case 'pie':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          {/* Slice 1: 40% (144 degrees) - from top to right-bottom */}
          <path d="M 50,50 L 50,15 A 35,35 0 0,1 78.5,73.5 Z" opacity="0.8" />
          
          {/* Slice 2: 30% (108 degrees) - continuing clockwise */}
          <path d="M 50,50 L 78.5,73.5 A 35,35 0 0,1 21.5,73.5 Z" opacity="0.6" />
          
          {/* Slice 3: 20% (72 degrees) - continuing clockwise */}
          <path d="M 50,50 L 21.5,73.5 A 35,35 0 0,1 28.5,26.5 Z" opacity="0.7" />
          
          {/* Slice 4: 10% (36 degrees) - completing the circle */}
          <path d="M 50,50 L 28.5,26.5 A 35,35 0 0,1 50,15 Z" opacity="0.5" />
          
          {/* Optional donut hole */}
          <circle cx="50" cy="50" r="15" fill="var(--background)" />
        </svg>
      );
    
    case 'scatter':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          {/* Grid lines */}
          <line x1="10" y1="85" x2="90" y2="85" stroke="currentColor" strokeWidth="1" opacity="0.15"/>
          <line x1="10" y1="15" x2="10" y2="85" stroke="currentColor" strokeWidth="1" opacity="0.15"/>
          
          {/* Data points with varying sizes */}
          <circle cx="22" cy="65" r="3.5" opacity="0.7"/>
          <circle cx="28" cy="48" r="2.5" opacity="0.6"/>
          <circle cx="35" cy="60" r="4" opacity="0.75"/>
          <circle cx="42" cy="42" r="3" opacity="0.65"/>
          <circle cx="48" cy="52" r="3.5" opacity="0.7"/>
          <circle cx="54" cy="35" r="2.5" opacity="0.6"/>
          <circle cx="58" cy="45" r="4" opacity="0.75"/>
          <circle cx="65" cy="30" r="3" opacity="0.65"/>
          <circle cx="70" cy="38" r="3.5" opacity="0.7"/>
          <circle cx="75" cy="25" r="2.5" opacity="0.6"/>
          <circle cx="80" cy="32" r="3" opacity="0.65"/>
          <circle cx="84" cy="20" r="2" opacity="0.5"/>
          
          {/* Trend line */}
          <path d="M 20,70 Q 50,50 85,20" stroke="currentColor" strokeWidth="1" opacity="0.2" fill="none" strokeDasharray="3,3"/>
        </svg>
      );
    
    case 'heatmap':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          {/* Grid with varying opacities to simulate heat */}
          <rect x="15" y="20" width="13" height="13" opacity="0.3" rx="2"/>
          <rect x="30" y="20" width="13" height="13" opacity="0.5" rx="2"/>
          <rect x="45" y="20" width="13" height="13" opacity="0.7" rx="2"/>
          <rect x="60" y="20" width="13" height="13" opacity="0.4" rx="2"/>
          <rect x="75" y="20" width="13" height="13" opacity="0.6" rx="2"/>
          
          <rect x="15" y="35" width="13" height="13" opacity="0.4" rx="2"/>
          <rect x="30" y="35" width="13" height="13" opacity="0.8" rx="2"/>
          <rect x="45" y="35" width="13" height="13" opacity="0.9" rx="2"/>
          <rect x="60" y="35" width="13" height="13" opacity="0.7" rx="2"/>
          <rect x="75" y="35" width="13" height="13" opacity="0.5" rx="2"/>
          
          <rect x="15" y="50" width="13" height="13" opacity="0.5" rx="2"/>
          <rect x="30" y="50" width="13" height="13" opacity="0.7" rx="2"/>
          <rect x="45" y="50" width="13" height="13" opacity="0.85" rx="2"/>
          <rect x="60" y="50" width="13" height="13" opacity="0.9" rx="2"/>
          <rect x="75" y="50" width="13" height="13" opacity="0.6" rx="2"/>
          
          <rect x="15" y="65" width="13" height="13" opacity="0.3" rx="2"/>
          <rect x="30" y="65" width="13" height="13" opacity="0.4" rx="2"/>
          <rect x="45" y="65" width="13" height="13" opacity="0.6" rx="2"/>
          <rect x="60" y="65" width="13" height="13" opacity="0.8" rx="2"/>
          <rect x="75" y="65" width="13" height="13" opacity="0.7" rx="2"/>
        </svg>
      );
    
    case 'bubble':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          {/* Grid lines */}
          <line x1="10" y1="85" x2="90" y2="85" stroke="currentColor" strokeWidth="0.5" opacity="0.1"/>
          <line x1="10" y1="15" x2="10" y2="85" stroke="currentColor" strokeWidth="0.5" opacity="0.1"/>
          
          {/* Bubbles with better distribution */}
          <circle cx="25" cy="65" r="12" opacity="0.3" stroke="currentColor" strokeWidth="1" fill="currentColor"/>
          <circle cx="45" cy="45" r="18" opacity="0.4" stroke="currentColor" strokeWidth="1" fill="currentColor"/>
          <circle cx="65" cy="55" r="14" opacity="0.35" stroke="currentColor" strokeWidth="1" fill="currentColor"/>
          <circle cx="75" cy="28" r="20" opacity="0.45" stroke="currentColor" strokeWidth="1" fill="currentColor"/>
          <circle cx="30" cy="35" r="10" opacity="0.3" stroke="currentColor" strokeWidth="1" fill="currentColor"/>
          <circle cx="80" cy="70" r="8" opacity="0.35" stroke="currentColor" strokeWidth="1" fill="currentColor"/>
          <circle cx="55" cy="25" r="6" opacity="0.3" stroke="currentColor" strokeWidth="1" fill="currentColor"/>
        </svg>
      );
    
    case 'wordcloud':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          <text x="50" y="30" fontSize="18" textAnchor="middle" opacity="0.9" fontWeight="700">DATA</text>
          <text x="28" y="45" fontSize="14" textAnchor="middle" opacity="0.7" fontWeight="600">cloud</text>
          <text x="72" y="48" fontSize="12" textAnchor="middle" opacity="0.6" fontWeight="500">analysis</text>
          <text x="50" y="60" fontSize="16" textAnchor="middle" opacity="0.8" fontWeight="600">VISUAL</text>
          <text x="25" y="72" fontSize="10" textAnchor="middle" opacity="0.5">metrics</text>
          <text x="75" y="70" fontSize="11" textAnchor="middle" opacity="0.55" fontWeight="500">insights</text>
          <text x="50" y="80" fontSize="9" textAnchor="middle" opacity="0.4">report</text>
          <text x="35" y="55" fontSize="8" textAnchor="middle" opacity="0.4">big</text>
          <text x="65" y="35" fontSize="8" textAnchor="middle" opacity="0.4">text</text>
        </svg>
      );
    
    case 'stacked':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="currentColor">
          {/* Base line */}
          <line x1="10" y1="85" x2="90" y2="85" stroke="currentColor" strokeWidth="1.5" opacity="0.3"/>
          
          {/* Stacked bars with gradient effect */}
          <rect x="15" y="60" width="14" height="25" opacity="0.4" rx="1"/>
          <rect x="15" y="42" width="14" height="18" opacity="0.6" rx="1"/>
          <rect x="15" y="30" width="14" height="12" opacity="0.8" rx="1"/>
          
          <rect x="33" y="50" width="14" height="35" opacity="0.4" rx="1"/>
          <rect x="33" y="35" width="14" height="15" opacity="0.6" rx="1"/>
          <rect x="33" y="25" width="14" height="10" opacity="0.8" rx="1"/>
          
          <rect x="51" y="55" width="14" height="30" opacity="0.4" rx="1"/>
          <rect x="51" y="38" width="14" height="17" opacity="0.6" rx="1"/>
          <rect x="51" y="28" width="14" height="10" opacity="0.8" rx="1"/>
          
          <rect x="69" y="45" width="14" height="40" opacity="0.4" rx="1"/>
          <rect x="69" y="28" width="14" height="17" opacity="0.6" rx="1"/>
          <rect x="69" y="18" width="14" height="10" opacity="0.8" rx="1"/>
        </svg>
      );
    
    case 'area':
      return (
        <svg viewBox="0 0 100 100" className={baseClasses} fill="none">
          {/* Grid lines */}
          <line x1="10" y1="85" x2="90" y2="85" stroke="currentColor" strokeWidth="1" opacity="0.15"/>
          
          {/* Multiple area layers */}
          <path d="M 10,75 Q 25,65 40,68 T 70,55 Q 85,50 90,60 L 90,85 L 10,85 Z" 
                fill="currentColor" 
                opacity="0.2"/>
          <path d="M 10,65 Q 30,45 50,50 T 90,35 L 90,85 L 10,85 Z" 
                fill="currentColor" 
                opacity="0.25"/>
          
          {/* Top lines */}
          <path d="M 10,75 Q 25,65 40,68 T 70,55 Q 85,50 90,60" 
                stroke="currentColor" 
                strokeWidth="1.5" 
                opacity="0.5" 
                strokeLinecap="round"/>
          <path d="M 10,65 Q 30,45 50,50 T 90,35" 
                stroke="currentColor" 
                strokeWidth="2" 
                opacity="0.7" 
                strokeLinecap="round"/>
        </svg>
      );
    
    default:
      return <BarChart3 className="w-6 h-6 text-muted-foreground/50" />;
  }
};

export function SunaModesPanel({ 
  selectedMode, 
  onModeSelect, 
  onSelectPrompt, 
  isMobile = false,
  selectedCharts: controlledSelectedCharts,
  onChartsChange,
  selectedOutputFormat: controlledSelectedOutputFormat,
  onOutputFormatChange
}: SunaModesPanelProps) {
  const currentMode = selectedMode ? modes.find((m) => m.id === selectedMode) : null;
  const promptCount = isMobile ? 2 : 4;
  
  // State to track current random selection of prompts
  const [randomizedPrompts, setRandomizedPrompts] = useState<string[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // State for multi-select charts (use controlled state if provided)
  const [uncontrolledSelectedCharts, setUncontrolledSelectedCharts] = useState<string[]>([]);
  const selectedCharts = controlledSelectedCharts ?? uncontrolledSelectedCharts;
  const setSelectedCharts = onChartsChange ?? setUncontrolledSelectedCharts;
  
  // State for selected output format (use controlled state if provided)
  const [uncontrolledSelectedOutputFormat, setUncontrolledSelectedOutputFormat] = useState<string | null>(null);
  const selectedOutputFormat = controlledSelectedOutputFormat ?? uncontrolledSelectedOutputFormat;
  const setSelectedOutputFormat = onOutputFormatChange ?? setUncontrolledSelectedOutputFormat;

  // Randomize prompts when mode changes or on mount
  useEffect(() => {
    if (currentMode) {
      setRandomizedPrompts(getRandomPrompts(currentMode.samplePrompts, promptCount));
    }
  }, [selectedMode, currentMode, promptCount]);
  
  // Reset selections when mode changes
  useEffect(() => {
    setSelectedCharts([]);
    setSelectedOutputFormat(null);
  }, [selectedMode, setSelectedCharts, setSelectedOutputFormat]);

  // Handler for refresh button
  const handleRefreshPrompts = () => {
    if (currentMode) {
      setIsRefreshing(true);
      setRandomizedPrompts(getRandomPrompts(currentMode.samplePrompts, promptCount));
      setTimeout(() => setIsRefreshing(false), 300);
    }
  };
  
  // Handler for chart selection toggle
  const handleChartToggle = (chartId: string) => {
    const newCharts = selectedCharts.includes(chartId) 
      ? selectedCharts.filter(id => id !== chartId)
      : [...selectedCharts, chartId];
    setSelectedCharts(newCharts);
  };
  
  // Handler for output format selection
  const handleOutputFormatSelect = (formatId: string) => {
    const newFormat = selectedOutputFormat === formatId ? null : formatId;
    setSelectedOutputFormat(newFormat);
  };
  
  // Handler for prompt selection - just pass through without modification
  const handlePromptSelect = (prompt: string) => {
    onSelectPrompt(prompt);
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
                onClick={() => handlePromptSelect(prompt)}
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
                  onClick={() => handlePromptSelect(prompt)}
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
                    onClick={() => handlePromptSelect(`Generate an image using ${item.name.toLowerCase()} style`)}
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
                      handlePromptSelect(
                        `Create a presentation using the ${item.name} template about ${item.description}`
                      )
                    }
                  >
                    <div className="w-full aspect-[4/3] bg-gradient-to-br from-muted/50 to-muted rounded-lg border border-border/50 flex items-center justify-center p-3">
                      <SlideTemplateIcon 
                        type={item.id} 
                        className="text-foreground/50 group-hover:text-primary/70 transition-colors duration-200" 
                      />
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
                      handlePromptSelect(
                        `Create a ${item.name} document: ${item.description}`
                      )
                    }
                  >
                    <div className="w-full aspect-[3/4] bg-gradient-to-br from-muted/50 to-muted rounded-lg border border-border/50 flex items-center justify-center p-3">
                      <DocsTemplateIcon 
                        type={item.id} 
                        className="text-foreground/50 group-hover:text-primary/70 transition-colors duration-200" 
                      />
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
              {currentMode.options.items.map((item) => {
                const isSelected = selectedOutputFormat === item.id;
                return (
                  <Card
                    key={item.id}
                    className={cn(
                      "p-3 cursor-pointer transition-all duration-200 group rounded-xl relative",
                      isSelected 
                        ? "bg-primary/10 border-primary border-2 shadow-sm" 
                        : "border border-border hover:bg-primary/5 hover:border-primary/30"
                    )}
                    onClick={() => handleOutputFormatSelect(item.id)}
                  >
                    <AnimatePresence>
                      {isSelected && (
                        <motion.div
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="absolute -top-2 -right-2 w-6 h-6 bg-primary rounded-full flex items-center justify-center shadow-md z-10"
                        >
                          <Check className="w-4 h-4 text-primary-foreground" strokeWidth={3} />
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <div className="flex flex-col items-center gap-2.5 text-center">
                      <div className={cn(
                        "w-full aspect-square rounded-lg flex items-center justify-center p-3 transition-all duration-200",
                        isSelected 
                          ? "bg-primary/15" 
                          : "bg-muted/30 group-hover:bg-muted/50"
                      )}>
                        <OutputFormatIcon 
                          type={item.id} 
                          className={cn(
                            "transition-colors duration-200",
                            isSelected 
                              ? "text-primary" 
                              : "text-foreground/50 group-hover:text-primary/70"
                          )} 
                        />
                      </div>
                      <div className="space-y-0.5">
                        <p className={cn(
                          "text-xs font-semibold transition-colors duration-200",
                          isSelected 
                            ? "text-primary" 
                            : "text-foreground/80 group-hover:text-primary"
                        )}>
                          {item.name}
                        </p>
                        {item.description && (
                          <p className="text-xs text-muted-foreground">
                            {item.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
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
              {currentMode.chartTypes.items.map((chart) => {
                const isSelected = selectedCharts.includes(chart.id);
                return (
                  <motion.div
                    key={chart.id}
                    whileTap={{ scale: 0.95 }}
                    transition={{ duration: 0.1 }}
                  >
                    <Card
                      className={cn(
                        "flex flex-col items-center gap-2 cursor-pointer group p-3 transition-all duration-200 rounded-xl relative",
                        isSelected 
                          ? "bg-primary/10 border-primary border-2 shadow-sm" 
                          : "border border-border hover:bg-primary/5 hover:border-primary/30"
                      )}
                      onClick={() => handleChartToggle(chart.id)}
                    >
                      <AnimatePresence>
                        {isSelected && (
                          <motion.div
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0, opacity: 0 }}
                            transition={{ duration: 0.2, type: "spring", stiffness: 300 }}
                            className="absolute -top-2 -right-2 w-5 h-5 bg-primary rounded-full flex items-center justify-center shadow-md z-10"
                          >
                            <Check className="w-3 h-3 text-primary-foreground" strokeWidth={3} />
                          </motion.div>
                        )}
                      </AnimatePresence>
                      <div className={cn(
                        "w-full aspect-square rounded-lg flex items-center justify-center p-2.5 transition-all duration-200",
                        isSelected 
                          ? "bg-primary/15" 
                          : "bg-muted/20 group-hover:bg-muted/35"
                      )}>
                        <ChartIcon 
                          type={chart.id} 
                          className={cn(
                            "transition-colors duration-200",
                            isSelected 
                              ? "text-primary" 
                              : "text-foreground/60 group-hover:text-primary"
                          )} 
                        />
                      </div>
                      <span className={cn(
                        "text-xs text-center transition-colors duration-200 font-medium",
                        isSelected 
                          ? "text-primary" 
                          : "text-foreground/70 group-hover:text-foreground"
                      )}>
                        {chart.name}
                      </span>
                    </Card>
                  </motion.div>
                );
              })}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </div>
      )}

    </div>
  );
}

