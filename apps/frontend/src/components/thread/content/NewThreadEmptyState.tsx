'use client';

import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { ArrowLeft, Check } from 'lucide-react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

// Import icons
import {
  Presentation,
  FileText,
  Link as LinkIcon,
  Table,
  PenTool,
  Video,
  BookOpen,
  FileCode,
  FileBarChart,
  Globe,
  FileCheck,
  Users,
  Mail,
  ShoppingBag,
  Newspaper,
  Youtube,
  Clapperboard,
  MessageSquare,
  Tv,
  Play,
  Wand2,
  TrendingUp,
  Building2,
  Target,
  Code,
  BarChart3,
  Calendar,
  Layout,
  ImageIcon,
  Smartphone,
  GraduationCap,
  BookMarked,
  Search,
  Lightbulb,
  DollarSign,
} from 'lucide-react';

// ============================================================================
// MODE CONFIGS (local definition for standalone /new page)
// ============================================================================
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

interface NewThreadEmptyStateProps {
  onSubmit: (prompt: string) => void;
  className?: string;
  sandboxId?: string | null;
  project?: {
    sandbox?: {
      id?: string;
    };
  };
}

// Silver shine spotlight effect matching Kortix brand
function SpotlightCard({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setMousePosition({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <div
      ref={ref}
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn('relative overflow-hidden', onClick && 'cursor-pointer', className)}
      style={{
        // @ts-expect-error CSS custom properties
        '--mouse-x': `${mousePosition.x}px`,
        '--mouse-y': `${mousePosition.y}px`,
      }}
    >
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

// ============================================================================
// SLIDES STARTER DATA
// ============================================================================
const presentationTemplates = [
  { id: 'minimalist', name: 'Minimalist', image: '/images/presentation-templates/minimalist-min.png' },
  { id: 'minimalist_2', name: 'Minimalist 2', image: '/images/presentation-templates/minimalist_2-min.png' },
  { id: 'black_and_white_clean', name: 'Black & White', image: '/images/presentation-templates/black_and_white_clean-min.png' },
  { id: 'colorful', name: 'Colorful', image: '/images/presentation-templates/colorful-min.png' },
  { id: 'startup', name: 'Startup', image: '/images/presentation-templates/startup-min.png' },
  { id: 'elevator_pitch', name: 'Elevator Pitch', image: '/images/presentation-templates/elevator_pitch-min.png' },
  { id: 'portfolio', name: 'Portfolio', image: '/images/presentation-templates/portfolio-min.png' },
  { id: 'textbook', name: 'Textbook', image: '/images/presentation-templates/textbook-min.png' },
  { id: 'architect', name: 'Architect', image: '/images/presentation-templates/architect-min.png' },
  { id: 'hipster', name: 'Hipster', image: '/images/presentation-templates/hipster-min.png' },
  { id: 'green', name: 'Green', image: '/images/presentation-templates/green-min.png' },
  { id: 'premium_black', name: 'Premium Black', image: '/images/presentation-templates/premium_black-min.png' },
  { id: 'premium_green', name: 'Premium Green', image: '/images/presentation-templates/premium_green-min.png' },
  { id: 'professor_gray', name: 'Professor Gray', image: '/images/presentation-templates/professor_gray-min.png' },
  { id: 'gamer_gray', name: 'Gamer Gray', image: '/images/presentation-templates/gamer_gray-min.png' },
  { id: 'competitor_analysis_blue', name: 'Analysis Blue', image: '/images/presentation-templates/competitor_analysis_blue-min.png' },
  { id: 'numbers_clean', name: 'Numbers Clean', image: '/images/presentation-templates/numbers_clean-min.png' },
  { id: 'numbers_colorful', name: 'Numbers Colorful', image: '/images/presentation-templates/numbers_colorful-min.png' },
];

const slideQuickPrompts = [
  'Pitch deck for my startup',
  'Quarterly business review',
  'Product launch presentation',
  'Conference talk about AI',
];

// ============================================================================
// SHEETS STARTER DATA
// ============================================================================
const sheetsCategories = [
  {
    id: 'financial',
    icon: DollarSign,
    label: 'Financial',
    prompts: [
      { label: 'Monthly budget tracker', prompt: 'Initialize the tools. Create a monthly budget tracker with income, expenses, savings goals, and spending categories with charts.' },
      { label: 'Revenue forecast model', prompt: 'Initialize the tools. Build a revenue forecast model with projections, growth rates, and scenario analysis.' },
      { label: 'Expense report template', prompt: 'Initialize the tools. Create an expense report template with categories, approval workflow, and summary dashboard.' },
    ],
  },
  {
    id: 'analytics',
    icon: BarChart3,
    label: 'Analytics',
    prompts: [
      { label: 'Website traffic dashboard', prompt: 'Initialize the tools. Create a website traffic dashboard with page views, sessions, bounce rates, and conversion funnels.' },
      { label: 'Sales pipeline tracker', prompt: 'Initialize the tools. Build a sales pipeline tracker with deal stages, win rates, and forecasting.' },
      { label: 'Cohort retention analysis', prompt: 'Initialize the tools. Create a cohort retention analysis showing user retention over time with heatmaps.' },
    ],
  },
  {
    id: 'project',
    icon: Calendar,
    label: 'Project',
    prompts: [
      { label: 'Project timeline / Gantt', prompt: 'Initialize the tools. Create a project timeline with Gantt chart, milestones, dependencies, and resource allocation.' },
      { label: 'Task tracker with status', prompt: 'Initialize the tools. Build a task tracker with status columns, priorities, assignees, and progress charts.' },
      { label: 'Sprint planning board', prompt: 'Initialize the tools. Create a sprint planning spreadsheet with story points, velocity tracking, and burndown chart.' },
    ],
  },
  {
    id: 'hr',
    icon: Users,
    label: 'HR & People',
    prompts: [
      { label: 'Hiring tracker', prompt: 'Initialize the tools. Create a hiring tracker with candidates, interview stages, feedback, and time-to-hire metrics.' },
      { label: 'Employee directory', prompt: 'Initialize the tools. Build an employee directory with departments, roles, contact info, and org chart data.' },
      { label: 'PTO / Leave tracker', prompt: 'Initialize the tools. Create a PTO tracker with leave balances, requests, approvals, and calendar view.' },
    ],
  },
];

// ============================================================================
// DOCS STARTER DATA
// ============================================================================
const docsCategories = [
  {
    id: 'product',
    label: 'Product',
    templates: [
      { id: 'prd', icon: FileText, label: 'PRD', description: 'Product requirements document', prompt: 'Initialize the tools. Create a comprehensive Product Requirements Document (PRD) with overview, goals, user stories, requirements, success metrics, and timeline.' },
      { id: 'spec', icon: FileCode, label: 'Tech Spec', description: 'Technical specification', prompt: 'Initialize the tools. Create a technical specification with system design, architecture, API contracts, data models, and implementation plan.' },
      { id: 'roadmap', icon: TrendingUp, label: 'Roadmap', description: 'Product roadmap document', prompt: 'Initialize the tools. Create a product roadmap document with quarterly goals, features, priorities, and dependencies.' },
    ],
  },
  {
    id: 'business',
    label: 'Business',
    templates: [
      { id: 'proposal', icon: Presentation, label: 'Proposal', description: 'Business proposal', prompt: 'Initialize the tools. Create a business proposal with executive summary, problem statement, solution, implementation plan, pricing, and expected outcomes.' },
      { id: 'report', icon: FileBarChart, label: 'Report', description: 'Business report', prompt: 'Initialize the tools. Create a detailed business report with executive summary, methodology, findings, analysis, and recommendations.' },
      { id: 'plan', icon: Target, label: 'Business Plan', description: 'Complete business plan', prompt: 'Initialize the tools. Create a business plan with market analysis, value proposition, revenue model, go-to-market strategy, and financial projections.' },
    ],
  },
  {
    id: 'internal',
    label: 'Internal',
    templates: [
      { id: 'guide', icon: BookOpen, label: 'Guide', description: 'How-to guide', prompt: 'Initialize the tools. Create a comprehensive how-to guide with introduction, step-by-step instructions, screenshots, troubleshooting, and FAQs.' },
      { id: 'wiki', icon: Globe, label: 'Wiki', description: 'Knowledge base article', prompt: 'Initialize the tools. Create a knowledge base wiki article with overview, key concepts, detailed explanations, examples, and references.' },
      { id: 'policy', icon: FileCheck, label: 'Policy', description: 'Policy document', prompt: 'Initialize the tools. Create a policy document with purpose, scope, policy statements, procedures, responsibilities, and compliance requirements.' },
      { id: 'meeting', icon: Users, label: 'Meeting Notes', description: 'Meeting minutes', prompt: 'Initialize the tools. Create meeting notes template with agenda, attendees, discussion points, decisions, action items, and next steps.' },
    ],
  },
];

// ============================================================================
// CANVAS STARTER DATA
// ============================================================================
// Menu icon component
const Menu = ({ className }: { className?: string }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>
  </svg>
);

const canvasCategories = [
  {
    id: 'web',
    label: 'Web Pages',
    templates: [
      { id: 'landing', icon: Globe, label: 'Landing Page', description: 'Hero, features, CTA', prompt: 'Initialize the tools. Create a modern landing page with hero section, feature highlights, testimonials, pricing, and call-to-action. Use a clean design with subtle gradients.' },
      { id: 'pricing', icon: DollarSign, label: 'Pricing Page', description: 'Pricing tiers comparison', prompt: 'Initialize the tools. Design a pricing page with plan comparison cards, feature checklists, toggle for monthly/annual, and highlighted recommended plan.' },
      { id: 'blog', icon: Newspaper, label: 'Blog Layout', description: 'Article page design', prompt: 'Initialize the tools. Design a blog article page with reading-optimized typography, author info, table of contents, related posts, and newsletter signup.' },
    ],
  },
  {
    id: 'components',
    label: 'Components',
    templates: [
      { id: 'card', icon: Layout, label: 'Product Card', description: 'E-commerce product card', prompt: 'Initialize the tools. Create a product card component with image, title, price, rating stars, add-to-cart button. Make it responsive with hover effects.' },
      { id: 'form', icon: FileText, label: 'Contact Form', description: 'Form with validation', prompt: 'Initialize the tools. Design a contact form with name, email, message fields, validation states, success/error messages, and submit button.' },
      { id: 'nav', icon: Menu, label: 'Navigation', description: 'Navbar with mobile menu', prompt: 'Initialize the tools. Create a responsive navigation bar with logo, menu items, dropdown, mobile hamburger menu, and sticky scroll behavior.' },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    templates: [
      { id: 'email', icon: Mail, label: 'Email Template', description: 'Newsletter design', prompt: 'Initialize the tools. Design a professional email newsletter template with header, featured article, content sections, CTA buttons, and footer with social links.' },
      { id: 'banner', icon: ImageIcon, label: 'Banner', description: 'Promotional banner', prompt: 'Initialize the tools. Create a promotional banner with headline, supporting text, CTA button, and eye-catching visuals. Make multiple sizes (leaderboard, square, skyscraper).' },
      { id: 'social', icon: Smartphone, label: 'Social Post', description: 'Instagram/Twitter post', prompt: 'Initialize the tools. Design a social media post template for Instagram with image area, text overlay, brand elements, and multiple layout variations.' },
    ],
  },
];

// ============================================================================
// VIDEO STARTER DATA
// ============================================================================
const videoCategories = [
  {
    id: 'social',
    label: 'Social Media',
    templates: [
      { id: 'youtube_intro', icon: Youtube, label: 'YouTube Intro', description: '10-sec animated intro', prompt: 'Initialize the tools. Create a 10-second YouTube intro video with channel name, modern motion graphics, and energetic music. Make it memorable and brand-consistent.' },
      { id: 'tiktok', icon: Smartphone, label: 'TikTok/Reel', description: '30-sec vertical video', prompt: 'Initialize the tools. Create a 30-second vertical video for TikTok/Instagram Reels. Include trending transitions, captions, and engaging hook in first 3 seconds.' },
      { id: 'youtube_short', icon: Play, label: 'YouTube Short', description: '60-sec short form', prompt: 'Initialize the tools. Create a 60-second YouTube Short with quick cuts, on-screen text, and a clear call-to-action at the end.' },
    ],
  },
  {
    id: 'business',
    label: 'Business',
    templates: [
      { id: 'explainer', icon: Tv, label: 'Explainer', description: 'Concept breakdown', prompt: 'Initialize the tools. Create a 2-minute explainer video that breaks down a complex concept. Use animations, clear narration, and visual metaphors.' },
      { id: 'demo', icon: Clapperboard, label: 'Product Demo', description: 'Feature showcase', prompt: 'Initialize the tools. Create a product demo video showcasing key features. Include screen recordings, highlight animations, and benefit-focused messaging.' },
      { id: 'testimonial', icon: MessageSquare, label: 'Testimonial', description: 'Customer story', prompt: 'Initialize the tools. Create a customer testimonial video template with interview-style layout, quote callouts, and company branding.' },
    ],
  },
  {
    id: 'educational',
    label: 'Educational',
    templates: [
      { id: 'tutorial', icon: GraduationCap, label: 'Tutorial', description: 'Step-by-step guide', prompt: 'Initialize the tools. Create a tutorial video with numbered steps, screen recordings, zoom-ins on important areas, and chapter markers.' },
      { id: 'course', icon: BookOpen, label: 'Course Lesson', description: 'Educational content', prompt: 'Initialize the tools. Create an educational course lesson video with intro, main content sections, key takeaways, and next lesson preview.' },
      { id: 'how_to', icon: Lightbulb, label: 'How-To', description: 'Quick how-to guide', prompt: 'Initialize the tools. Create a quick how-to video showing a specific process. Keep it concise with clear visuals and minimal narration.' },
    ],
  },
];

// ============================================================================
// RESEARCH STARTER DATA
// ============================================================================
const researchCategories = [
  {
    id: 'market',
    icon: TrendingUp,
    label: 'Market Research',
    description: 'Analyze markets, trends, and opportunities',
    prompts: [
      { label: 'Market size & TAM analysis', prompt: 'Initialize the tools. Research the total addressable market (TAM), serviceable market (SAM), and obtainable market (SOM) for [industry]. Include growth rates, key drivers, and market segments.' },
      { label: 'Industry trends report', prompt: 'Initialize the tools. Analyze current and emerging trends in [industry]. Cover technological shifts, consumer behavior changes, regulatory impacts, and future outlook.' },
      { label: 'Market opportunity assessment', prompt: 'Initialize the tools. Evaluate market opportunities in [sector]. Identify gaps, unmet needs, barriers to entry, and potential for disruption.' },
    ],
  },
  {
    id: 'competitive',
    icon: Target,
    label: 'Competitive Intelligence',
    description: 'Analyze competitors and market positioning',
    prompts: [
      { label: 'Competitor deep dive', prompt: 'Initialize the tools. Conduct a comprehensive analysis of [competitor]. Cover their products, pricing, positioning, strengths, weaknesses, and recent strategic moves.' },
      { label: 'Competitive landscape map', prompt: 'Initialize the tools. Map the competitive landscape in [market]. Identify all players, their market positions, differentiation strategies, and competitive dynamics.' },
      { label: 'Feature comparison matrix', prompt: 'Initialize the tools. Create a detailed feature comparison between [product/company] and its top 5 competitors. Include pricing, features, and unique selling points.' },
    ],
  },
  {
    id: 'company',
    icon: Building2,
    label: 'Company Research',
    description: 'Deep dive into specific companies',
    prompts: [
      { label: 'Company overview & profile', prompt: 'Initialize the tools. Research [company] comprehensively. Cover history, mission, products, leadership, culture, financials, and recent developments.' },
      { label: 'Financial analysis', prompt: 'Initialize the tools. Analyze [company] financial health. Include revenue trends, profitability, balance sheet strength, cash flow, and key financial ratios.' },
      { label: 'SWOT analysis', prompt: 'Initialize the tools. Conduct a SWOT analysis for [company]. Identify internal strengths/weaknesses and external opportunities/threats with supporting evidence.' },
    ],
  },
  {
    id: 'tech',
    icon: Code,
    label: 'Technology Research',
    description: 'Explore technologies and innovations',
    prompts: [
      { label: 'Technology deep dive', prompt: 'Initialize the tools. Research [technology] in depth. Cover how it works, current state, key players, use cases, adoption rates, and future trajectory.' },
      { label: 'Tech stack comparison', prompt: 'Initialize the tools. Compare different technology stacks for [use case]. Analyze pros/cons, performance, scalability, cost, and best-fit scenarios.' },
      { label: 'Emerging tech report', prompt: 'Initialize the tools. Research emerging technologies in [field]. Identify breakthrough innovations, early adopters, potential impact, and timeline to mainstream adoption.' },
    ],
  },
];

// ============================================================================
// MODE STARTER CONFIGURATIONS
// ============================================================================
interface ModeStarterConfig {
  title: string;
  subtitle: string;
}

const modeStarterConfigs: Record<string, ModeStarterConfig> = {
  slides: { title: 'Create Presentation', subtitle: 'Choose a template or describe what you need' },
  sheets: { title: 'Create Spreadsheet', subtitle: 'Choose a category to get started' },
  docs: { title: 'Create Document', subtitle: 'Choose a document type' },
  canvas: { title: 'Create Design', subtitle: 'Choose what you want to design' },
  video: { title: 'Create Video', subtitle: 'Choose a video type' },
  research: { title: 'Deep Research', subtitle: 'Choose a research category' },
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export function NewThreadEmptyState({ onSubmit, className }: NewThreadEmptyStateProps) {
  const [selectedMode, setSelectedMode] = useState<ModeConfig | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<typeof presentationTemplates[0] | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const handleModeClick = (mode: ModeConfig) => {
    setSelectedMode(mode);
    setPreviewTemplate(null);
    setExpandedCategory(null);
  };

  const handleBack = () => {
    if (previewTemplate) {
      setPreviewTemplate(null);
    } else if (expandedCategory) {
      setExpandedCategory(null);
    } else {
      setSelectedMode(null);
    }
  };

  const handleSubmitPrompt = (prompt: string) => {
    onSubmit(prompt);
  };

  // ============================================================================
  // SLIDES STARTER
  // ============================================================================
  const renderSlidesStarter = () => {
    const config = modeStarterConfigs.slides;

    if (previewTemplate) {
      return (
        <div className="flex flex-col h-full">
          <div className="flex-shrink-0 flex items-center justify-between pb-4 border-b border-border/50">
            <button onClick={handleBack} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <span className="text-sm font-medium">{previewTemplate.name}</span>
            <Button onClick={() => handleSubmitPrompt(`Initialize the tools. Create a presentation using the ${previewTemplate.name} template.`)}>
              <Check className="w-4 h-4 mr-1.5" />
              Use Template
            </Button>
          </div>
          <div className="flex-1 mt-6 rounded-lg border border-border/50 overflow-hidden bg-muted/20">
            <div className="aspect-video relative">
              <Image src={previewTemplate.image} alt={previewTemplate.name} fill className="object-contain" />
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
              <ArrowLeft className="w-4 h-4 text-muted-foreground" />
            </button>
            <div>
              <h2 className="text-lg font-semibold">{config.title}</h2>
              <p className="text-sm text-muted-foreground">{config.subtitle}</p>
            </div>
          </div>

          {/* Quick Start Pills */}
          <div className="flex flex-wrap gap-2 mb-5">
            {slideQuickPrompts.map((prompt, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.03 }}
              >
                <SpotlightCard className="rounded-full">
                  <button
                    onClick={() => handleSubmitPrompt(`Initialize the tools. ${prompt}`)}
                    className="px-3 py-1.5 text-xs rounded-full bg-background/80 border border-border/60 hover:bg-accent hover:border-foreground/20 transition-all"
                  >
                    {prompt}
                  </button>
                </SpotlightCard>
              </motion.div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground mb-3">Templates</p>
        </div>

        <ScrollArea className="flex-1 -mx-1 px-1">
          <div className="grid grid-cols-3 gap-3 pb-4">
            {presentationTemplates.map((template, index) => (
              <motion.div
                key={template.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: index * 0.02 }}
              >
                <SpotlightCard onClick={() => setPreviewTemplate(template)} className="rounded-lg">
                  <div className="relative aspect-[16/10] rounded-lg overflow-hidden border border-border/50 transition-all hover:border-foreground/30 hover:shadow-md group bg-muted/20">
                    <Image src={template.image} alt={template.name} fill className="object-cover" sizes="250px" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
                      <span className="text-xs font-medium text-white">{template.name}</span>
                    </div>
                  </div>
                </SpotlightCard>
              </motion.div>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  };

  // ============================================================================
  // SHEETS STARTER
  // ============================================================================
  const renderSheetsStarter = () => {
    const config = modeStarterConfigs.sheets;

    if (expandedCategory) {
      const category = sheetsCategories.find(c => c.id === expandedCategory);
      if (!category) return null;
      const CatIcon = category.icon;

      return (
        <div className="flex flex-col h-full">
          <div className="flex-shrink-0 mb-5">
            <div className="flex items-center gap-3 mb-5">
              <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                <ArrowLeft className="w-4 h-4 text-muted-foreground" />
              </button>
              <CatIcon className="w-5 h-5 text-muted-foreground" />
              <div>
                <h2 className="text-lg font-semibold">{category.label} Spreadsheets</h2>
                <p className="text-sm text-muted-foreground">Choose a template</p>
              </div>
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="space-y-2 pb-4">
              {category.prompts.map((prompt, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04 }}
                >
                  <SpotlightCard onClick={() => handleSubmitPrompt(prompt.prompt)} className="rounded-lg">
                    <div className="p-3 rounded-lg border border-border/50 bg-background/80 hover:bg-accent hover:border-foreground/20 transition-all">
                      <span className="text-sm text-foreground">{prompt.label}</span>
                    </div>
                  </SpotlightCard>
                </motion.div>
              ))}
            </div>
          </ScrollArea>
        </div>
      );
    }

    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 mb-5">
          <div className="flex items-center gap-3 mb-5">
            <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
              <ArrowLeft className="w-4 h-4 text-muted-foreground" />
            </button>
            <div>
              <h2 className="text-lg font-semibold">{config.title}</h2>
              <p className="text-sm text-muted-foreground">{config.subtitle}</p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="grid grid-cols-2 gap-3 pb-4">
            {sheetsCategories.map((category, index) => {
              const CatIcon = category.icon;
              return (
                <motion.div
                  key={category.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: index * 0.04 }}
                >
                  <SpotlightCard onClick={() => setExpandedCategory(category.id)} className="rounded-lg">
                    <div className="p-5 rounded-lg border border-border/50 bg-background/80 hover:bg-accent hover:border-foreground/20 transition-all h-full">
                      <CatIcon className="w-6 h-6 text-muted-foreground mb-3" />
                      <h4 className="text-base font-medium mb-1">{category.label}</h4>
                      <p className="text-xs text-muted-foreground">{category.prompts.length} templates</p>
                    </div>
                  </SpotlightCard>
                </motion.div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    );
  };

  // ============================================================================
  // DOCS STARTER
  // ============================================================================
  const renderDocsStarter = () => {
    const config = modeStarterConfigs.docs;

    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 mb-5">
          <div className="flex items-center gap-3 mb-5">
            <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
              <ArrowLeft className="w-4 h-4 text-muted-foreground" />
            </button>
            <div>
              <h2 className="text-lg font-semibold">{config.title}</h2>
              <p className="text-sm text-muted-foreground">{config.subtitle}</p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="space-y-6 pb-4">
            {docsCategories.map((category, catIndex) => (
              <motion.div
                key={category.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: catIndex * 0.08 }}
              >
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{category.label}</p>
                <div className="grid grid-cols-2 gap-2">
                  {category.templates.map((template) => {
                    const TempIcon = template.icon;
                    return (
                      <SpotlightCard key={template.id} onClick={() => handleSubmitPrompt(template.prompt)} className="rounded-lg">
                        <div className="p-3 rounded-lg border border-border/50 bg-background/80 hover:bg-accent hover:border-foreground/20 transition-all h-full">
                          <div className="flex items-start gap-2">
                            <TempIcon className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium mb-0.5">{template.label}</p>
                              <p className="text-xs text-muted-foreground">{template.description}</p>
                            </div>
                          </div>
                        </div>
                      </SpotlightCard>
                    );
                  })}
                </div>
              </motion.div>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  };

  // ============================================================================
  // CANVAS STARTER
  // ============================================================================
  const renderCanvasStarter = () => {
    const config = modeStarterConfigs.canvas;

    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 mb-5">
          <div className="flex items-center gap-3 mb-5">
            <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
              <ArrowLeft className="w-4 h-4 text-muted-foreground" />
            </button>
            <div>
              <h2 className="text-lg font-semibold">{config.title}</h2>
              <p className="text-sm text-muted-foreground">{config.subtitle}</p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="space-y-6 pb-4">
            {canvasCategories.map((category, catIndex) => (
              <motion.div
                key={category.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: catIndex * 0.08 }}
              >
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{category.label}</p>
                <div className="grid grid-cols-3 gap-2">
                  {category.templates.map((template) => {
                    const TempIcon = template.icon;
                    return (
                      <SpotlightCard key={template.id} onClick={() => handleSubmitPrompt(template.prompt)} className="rounded-lg">
                        <div className="p-3 rounded-lg border border-border/50 bg-background/80 hover:bg-accent hover:border-foreground/20 transition-all text-center h-full">
                          <TempIcon className="w-5 h-5 text-muted-foreground mx-auto mb-2" />
                          <p className="text-xs font-medium mb-0.5">{template.label}</p>
                          <p className="text-[10px] text-muted-foreground">{template.description}</p>
                        </div>
                      </SpotlightCard>
                    );
                  })}
                </div>
              </motion.div>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  };

  // ============================================================================
  // VIDEO STARTER
  // ============================================================================
  const renderVideoStarter = () => {
    const config = modeStarterConfigs.video;

    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 mb-5">
          <div className="flex items-center gap-3 mb-5">
            <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
              <ArrowLeft className="w-4 h-4 text-muted-foreground" />
            </button>
            <div>
              <h2 className="text-lg font-semibold">{config.title}</h2>
              <p className="text-sm text-muted-foreground">{config.subtitle}</p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="space-y-6 pb-4">
            {videoCategories.map((category, catIndex) => (
              <motion.div
                key={category.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: catIndex * 0.08 }}
              >
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">{category.label}</p>
                <div className="grid grid-cols-3 gap-2">
                  {category.templates.map((template) => {
                    const TempIcon = template.icon;
                    return (
                      <SpotlightCard key={template.id} onClick={() => handleSubmitPrompt(template.prompt)} className="rounded-lg">
                        <div className="p-3 rounded-lg border border-border/50 bg-background/80 hover:bg-accent hover:border-foreground/20 transition-all h-full">
                          <div className="flex items-start gap-2">
                            <TempIcon className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium mb-0.5">{template.label}</p>
                              <p className="text-xs text-muted-foreground">{template.description}</p>
                            </div>
                          </div>
                        </div>
                      </SpotlightCard>
                    );
                  })}
                </div>
              </motion.div>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  };

  // ============================================================================
  // RESEARCH STARTER
  // ============================================================================
  const renderResearchStarter = () => {
    const config = modeStarterConfigs.research;

    if (expandedCategory) {
      const category = researchCategories.find(c => c.id === expandedCategory);
      if (!category) return null;
      const CatIcon = category.icon;

      return (
        <div className="flex flex-col h-full">
          <div className="flex-shrink-0 mb-5">
            <div className="flex items-center gap-3 mb-5">
              <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                <ArrowLeft className="w-4 h-4 text-muted-foreground" />
              </button>
              <CatIcon className="w-5 h-5 text-muted-foreground" />
              <div>
                <h2 className="text-lg font-semibold">{category.label}</h2>
                <p className="text-sm text-muted-foreground">{category.description}</p>
              </div>
            </div>
          </div>

          <ScrollArea className="flex-1">
            <div className="space-y-2 pb-4">
              {category.prompts.map((prompt, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04 }}
                >
                  <SpotlightCard onClick={() => handleSubmitPrompt(prompt.prompt)} className="rounded-lg">
                    <div className="p-3 rounded-lg border border-border/50 bg-background/80 hover:bg-accent hover:border-foreground/20 transition-all">
                      <span className="text-sm text-foreground">{prompt.label}</span>
                    </div>
                  </SpotlightCard>
                </motion.div>
              ))}
            </div>
          </ScrollArea>
        </div>
      );
    }

    return (
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 mb-5">
          <div className="flex items-center gap-3 mb-5">
            <button onClick={handleBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
              <ArrowLeft className="w-4 h-4 text-muted-foreground" />
            </button>
            <div>
              <h2 className="text-lg font-semibold">{config.title}</h2>
              <p className="text-sm text-muted-foreground">{config.subtitle}</p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="grid grid-cols-2 gap-3 pb-4">
            {researchCategories.map((category, index) => {
              const CatIcon = category.icon;
              return (
                <motion.div
                  key={category.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: index * 0.04 }}
                >
                  <SpotlightCard onClick={() => setExpandedCategory(category.id)} className="rounded-lg">
                    <div className="p-5 rounded-lg border border-border/50 bg-background/80 hover:bg-accent hover:border-foreground/20 transition-all h-full">
                      <CatIcon className="w-6 h-6 text-muted-foreground mb-3" />
                      <h4 className="text-base font-medium mb-1">{category.label}</h4>
                      <p className="text-xs text-muted-foreground mb-2">{category.description}</p>
                    </div>
                  </SpotlightCard>
                </motion.div>
              );
            })}
          </div>
        </ScrollArea>
      </div>
    );
  };

  // ============================================================================
  // MODE SELECTOR (DEFAULT VIEW)
  // ============================================================================
  if (selectedMode) {
    return (
      <div className={cn('flex flex-col h-[650px] max-w-3xl w-full mx-auto', className)}>
        <AnimatePresence mode="wait">
          <motion.div
            key={selectedMode.id + (previewTemplate?.id || '') + (expandedCategory || '')}
            initial={{ opacity: 0, x: 15 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -15 }}
            transition={{ duration: 0.2 }}
            className="h-full"
          >
            {selectedMode.id === 'slides' && renderSlidesStarter()}
            {selectedMode.id === 'sheets' && renderSheetsStarter()}
            {selectedMode.id === 'docs' && renderDocsStarter()}
            {selectedMode.id === 'canvas' && renderCanvasStarter()}
            {selectedMode.id === 'video' && renderVideoStarter()}
            {selectedMode.id === 'research' && renderResearchStarter()}
          </motion.div>
        </AnimatePresence>
      </div>
    );
  }

  // Default view - show all modes as pills (matching homepage)
  return (
    <div className={cn('flex flex-col gap-6 max-w-3xl w-full mx-auto', className)}>
      <div className="flex items-center gap-2">
        <img
          src="/kortix-logomark-white.svg"
          alt="Kortix"
          className="dark:invert-0 invert"
          style={{ height: '14px', width: 'auto' }}
        />
      </div>

      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">What would you like to create?</h2>
        <p className="text-sm text-muted-foreground">Choose a mode to get started with templates and examples</p>
      </div>

      {/* Mode Pills - matching homepage style */}
      <div className="flex items-center flex-wrap gap-2">
        {modeConfigs.map((mode, index) => (
          <motion.div
            key={mode.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: index * 0.03 }}
            whileHover={{ scale: 1.04, y: -2 }}
            whileTap={{ scale: 0.96 }}
          >
            <SpotlightCard className="rounded-full">
              <button
                onClick={() => handleModeClick(mode)}
                className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-background/80 border border-border/60 hover:bg-accent hover:border-foreground/20 transition-all"
              >
                <div className="text-muted-foreground">{mode.icon}</div>
                <span className="text-sm font-medium">{mode.name}</span>
              </button>
            </SpotlightCard>
          </motion.div>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        Or type anything in the chat below to get started
      </p>
    </div>
  );
}
