'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  BookOpen,
  Sparkles,
  Search,
  Globe,
  FileText,
  TrendingUp,
  Microscope,
  Building2,
  X,
  DollarSign,
  Users,
  Zap,
  BarChart3,
  Target,
  Briefcase,
  GraduationCap,
  Heart,
  Leaf,
  Code,
  ShoppingBag,
  Plane,
  Shield,
  Lightbulb,
  Newspaper,
  Database,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

// Example use cases for research
const useCases = [
  {
    icon: <Search className="w-5 h-5" />,
    title: 'Deep web research',
    description: 'Search across multiple sources and synthesize findings',
  },
  {
    icon: <Globe className="w-5 h-5" />,
    title: 'Real-time information',
    description: 'Get the latest news, trends, and developments',
  },
  {
    icon: <Sparkles className="w-5 h-5" />,
    title: 'Comprehensive reports',
    description: 'Generate detailed reports with sources and citations',
  },
];

// Comprehensive research prompts organized by category
const researchPrompts = [
  // Market Research
  {
    category: 'Market Research',
    icon: <TrendingUp className="w-4 h-4" />,
    prompts: [
      {
        label: 'Market size analysis',
        prompt: 'Initialize the tools. Research the market size and growth projections for [industry/market]. Include TAM, SAM, SOM, CAGR, key growth drivers, and market segmentation.',
      },
      {
        label: 'Market trends',
        prompt: 'Initialize the tools. Analyze current and emerging trends in [industry]. Identify key drivers, consumer behavior shifts, and future market direction.',
      },
      {
        label: 'Market opportunity',
        prompt: 'Initialize the tools. Evaluate market opportunities in [sector/niche]. Assess market gaps, unmet needs, competitive landscape, and entry barriers.',
      },
      {
        label: 'Market segmentation',
        prompt: 'Initialize the tools. Research market segmentation for [product/service category]. Identify key customer segments, demographics, psychographics, and buying behaviors.',
      },
      {
        label: 'Pricing research',
        prompt: 'Initialize the tools. Research pricing strategies and price points for [product/service] in [market]. Include competitor pricing, value-based pricing, and price elasticity analysis.',
      },
    ],
  },
  // Company Analysis
  {
    category: 'Company Analysis',
    icon: <Building2 className="w-4 h-4" />,
    prompts: [
      {
        label: 'Company overview',
        prompt: 'Initialize the tools. Research [company name] comprehensively. Include company history, mission, vision, organizational structure, and key milestones.',
      },
      {
        label: 'Financial analysis',
        prompt: 'Initialize the tools. Analyze [company name] financial performance. Include revenue, profitability, growth trends, balance sheet, cash flow, and key financial ratios.',
      },
      {
        label: 'Product portfolio',
        prompt: 'Initialize the tools. Research [company name] products and services. Detail product features, pricing, market positioning, and customer reviews.',
      },
      {
        label: 'Leadership team',
        prompt: 'Initialize the tools. Research [company name] leadership team and key executives. Include backgrounds, experience, recent moves, and strategic direction.',
      },
      {
        label: 'Recent news & events',
        prompt: 'Initialize the tools. Find recent news, press releases, and major events related to [company name]. Include product launches, partnerships, acquisitions, and market moves.',
      },
      {
        label: 'Competitive positioning',
        prompt: 'Initialize the tools. Analyze [company name] competitive position in [market]. Compare strengths, weaknesses, market share, and differentiation strategies.',
      },
    ],
  },
  // Industry Analysis
  {
    category: 'Industry Analysis',
    icon: <BarChart3 className="w-4 h-4" />,
    prompts: [
      {
        label: 'Industry overview',
        prompt: 'Initialize the tools. Provide a comprehensive overview of [industry]. Include industry size, structure, key players, value chain, and business models.',
      },
      {
        label: 'Industry trends',
        prompt: 'Initialize the tools. Research current and future trends shaping [industry]. Identify technological, regulatory, and market forces driving change.',
      },
      {
        label: 'Industry challenges',
        prompt: 'Initialize the tools. Identify major challenges and pain points in [industry]. Include regulatory issues, market constraints, and operational difficulties.',
      },
      {
        label: 'Industry outlook',
        prompt: 'Initialize the tools. Forecast the future outlook for [industry]. Include growth projections, emerging opportunities, threats, and industry evolution.',
      },
    ],
  },
  // Competitive Intelligence
  {
    category: 'Competitive Intelligence',
    icon: <Target className="w-4 h-4" />,
    prompts: [
      {
        label: 'Competitor analysis',
        prompt: 'Initialize the tools. Conduct competitive analysis of [company/product] vs [competitors]. Compare features, pricing, positioning, market share, and strengths/weaknesses.',
      },
      {
        label: 'Competitive landscape',
        prompt: 'Initialize the tools. Map the competitive landscape in [market]. Identify direct and indirect competitors, market positioning, and competitive dynamics.',
      },
      {
        label: 'Competitive strategies',
        prompt: 'Initialize the tools. Research competitive strategies used by [company/industry]. Analyze go-to-market approaches, pricing strategies, and differentiation tactics.',
      },
      {
        label: 'Market share analysis',
        prompt: 'Initialize the tools. Research market share data for [industry/product category]. Identify market leaders, share distribution, and market concentration.',
      },
    ],
  },
  // Academic Research
  {
    category: 'Academic Research',
    icon: <GraduationCap className="w-4 h-4" />,
    prompts: [
      {
        label: 'Literature review',
        prompt: 'Initialize the tools. Conduct a comprehensive literature review on [research topic]. Find relevant academic papers, summarize key findings, identify research gaps, and cite sources.',
      },
      {
        label: 'Research methodology',
        prompt: 'Initialize the tools. Research methodologies used in [research field/topic]. Compare different approaches, their strengths, limitations, and best practices.',
      },
      {
        label: 'Academic papers',
        prompt: 'Initialize the tools. Find and analyze recent academic papers on [topic]. Summarize key contributions, methodologies, findings, and implications.',
      },
      {
        label: 'Research gaps',
        prompt: 'Initialize the tools. Identify research gaps and unanswered questions in [field/topic]. Analyze existing literature to find areas needing further investigation.',
      },
    ],
  },
  // Technology Research
  {
    category: 'Technology Research',
    icon: <Code className="w-4 h-4" />,
    prompts: [
      {
        label: 'Tech trends',
        prompt: 'Initialize the tools. Research emerging technology trends in [field/industry]. Include new technologies, adoption rates, use cases, and future potential.',
      },
      {
        label: 'Technology comparison',
        prompt: 'Initialize the tools. Compare [technology A] vs [technology B]. Analyze features, performance, use cases, pros/cons, and market adoption.',
      },
      {
        label: 'Tech stack research',
        prompt: 'Initialize the tools. Research technology stacks used for [application type/use case]. Compare options, best practices, and industry standards.',
      },
      {
        label: 'Innovation research',
        prompt: 'Initialize the tools. Research recent innovations and breakthroughs in [technology field]. Include patents, research papers, and commercial applications.',
      },
    ],
  },
  // Financial Research
  {
    category: 'Financial Research',
    icon: <DollarSign className="w-4 h-4" />,
    prompts: [
      {
        label: 'Stock analysis',
        prompt: 'Initialize the tools. Research [company ticker/name] stock. Analyze financial performance, valuation metrics, analyst ratings, recent news, and investment thesis.',
      },
      {
        label: 'Economic analysis',
        prompt: 'Initialize the tools. Research economic conditions and outlook for [region/sector]. Include GDP, inflation, employment, interest rates, and economic indicators.',
      },
      {
        label: 'Investment research',
        prompt: 'Initialize the tools. Research investment opportunities in [sector/asset class]. Analyze risk-return profiles, market conditions, and investment strategies.',
      },
      {
        label: 'Financial markets',
        prompt: 'Initialize the tools. Research current state of [financial market/asset class]. Include trends, volatility, key drivers, and market outlook.',
      },
    ],
  },
  // Consumer Research
  {
    category: 'Consumer Research',
    icon: <Users className="w-4 h-4" />,
    prompts: [
      {
        label: 'Consumer behavior',
        prompt: 'Initialize the tools. Research consumer behavior patterns for [product/service category]. Include buying habits, preferences, decision factors, and trends.',
      },
      {
        label: 'Customer insights',
        prompt: 'Initialize the tools. Research customer insights for [product/service]. Analyze needs, pain points, satisfaction levels, and feedback trends.',
      },
      {
        label: 'Demographics research',
        prompt: 'Initialize the tools. Research demographics and psychographics of [target audience]. Include age, income, location, interests, and lifestyle factors.',
      },
      {
        label: 'Brand perception',
        prompt: 'Initialize the tools. Research brand perception and reputation of [brand/company]. Analyze customer sentiment, reviews, social media mentions, and brand associations.',
      },
    ],
  },
  // Business Research
  {
    category: 'Business Research',
    icon: <Briefcase className="w-4 h-4" />,
    prompts: [
      {
        label: 'Business model analysis',
        prompt: 'Initialize the tools. Research business models in [industry]. Analyze revenue streams, cost structures, value propositions, and profitability models.',
      },
      {
        label: 'Partnership opportunities',
        prompt: 'Initialize the tools. Research potential partnership opportunities for [company/product]. Identify complementary businesses, strategic alliances, and collaboration potential.',
      },
      {
        label: 'M&A research',
        prompt: 'Initialize the tools. Research mergers and acquisitions in [industry]. Analyze recent deals, deal structures, valuations, and strategic rationale.',
      },
      {
        label: 'Startup ecosystem',
        prompt: 'Initialize the tools. Research the startup ecosystem in [location/industry]. Include funding trends, key players, accelerators, and success factors.',
      },
    ],
  },
  // Healthcare Research
  {
    category: 'Healthcare Research',
    icon: <Heart className="w-4 h-4" />,
    prompts: [
      {
        label: 'Medical research',
        prompt: 'Initialize the tools. Research [medical condition/treatment]. Include symptoms, causes, treatment options, recent studies, and clinical trial data.',
      },
      {
        label: 'Healthcare trends',
        prompt: 'Initialize the tools. Research current trends in healthcare and medicine. Include new treatments, technologies, policy changes, and industry developments.',
      },
      {
        label: 'Pharmaceutical research',
        prompt: 'Initialize the tools. Research [drug/medication]. Include indications, efficacy, side effects, clinical trials, and regulatory status.',
      },
    ],
  },
  // Sustainability Research
  {
    category: 'Sustainability',
    icon: <Leaf className="w-4 h-4" />,
    prompts: [
      {
        label: 'Environmental impact',
        prompt: 'Initialize the tools. Research environmental impact of [industry/practice]. Include carbon footprint, resource usage, waste, and sustainability initiatives.',
      },
      {
        label: 'ESG research',
        prompt: 'Initialize the tools. Research ESG (Environmental, Social, Governance) practices of [company/industry]. Analyze sustainability initiatives, social impact, and governance.',
      },
      {
        label: 'Renewable energy',
        prompt: 'Initialize the tools. Research renewable energy trends and technologies. Include solar, wind, battery storage, adoption rates, and market outlook.',
      },
    ],
  },
  // Product Research
  {
    category: 'Product Research',
    icon: <ShoppingBag className="w-4 h-4" />,
    prompts: [
      {
        label: 'Product comparison',
        prompt: 'Initialize the tools. Compare [product A] vs [product B]. Analyze features, pricing, reviews, pros/cons, and use cases to help make a decision.',
      },
      {
        label: 'Product reviews',
        prompt: 'Initialize the tools. Research reviews and ratings for [product]. Aggregate customer feedback, expert reviews, and identify common themes.',
      },
      {
        label: 'Product market fit',
        prompt: 'Initialize the tools. Research market fit for [product/concept]. Analyze target market needs, competitive alternatives, and product-market fit indicators.',
      },
    ],
  },
  // Travel Research
  {
    category: 'Travel Research',
    icon: <Plane className="w-4 h-4" />,
    prompts: [
      {
        label: 'Destination research',
        prompt: 'Initialize the tools. Research [destination] for travel. Include attractions, best time to visit, local culture, safety, accommodation options, and travel tips.',
      },
      {
        label: 'Travel planning',
        prompt: 'Initialize the tools. Research travel options and recommendations for [destination/itinerary]. Include flights, hotels, activities, restaurants, and local insights.',
      },
    ],
  },
  // Security Research
  {
    category: 'Security Research',
    icon: <Shield className="w-4 h-4" />,
    prompts: [
      {
        label: 'Cybersecurity threats',
        prompt: 'Initialize the tools. Research current cybersecurity threats and trends. Include attack vectors, vulnerabilities, best practices, and security solutions.',
      },
      {
        label: 'Data privacy',
        prompt: 'Initialize the tools. Research data privacy regulations and practices. Include GDPR, CCPA, compliance requirements, and privacy best practices.',
      },
    ],
  },
  // Innovation Research
  {
    category: 'Innovation Research',
    icon: <Lightbulb className="w-4 h-4" />,
    prompts: [
      {
        label: 'Innovation trends',
        prompt: 'Initialize the tools. Research innovation trends in [industry/field]. Identify breakthrough technologies, disruptive innovations, and future possibilities.',
      },
      {
        label: 'Patent research',
        prompt: 'Initialize the tools. Research patents related to [technology/innovation]. Analyze patent landscape, key players, and intellectual property trends.',
      },
    ],
  },
  // News & Current Events
  {
    category: 'News & Current Events',
    icon: <Newspaper className="w-4 h-4" />,
    prompts: [
      {
        label: 'Breaking news',
        prompt: 'Initialize the tools. Research latest breaking news and developments on [topic/event]. Include multiple sources, verified information, and context.',
      },
      {
        label: 'Current events analysis',
        prompt: 'Initialize the tools. Analyze current events related to [topic]. Provide context, background, multiple perspectives, and implications.',
      },
    ],
  },
  // Data & Statistics
  {
    category: 'Data & Statistics',
    icon: <Database className="w-4 h-4" />,
    prompts: [
      {
        label: 'Statistical analysis',
        prompt: 'Initialize the tools. Research statistics and data on [topic]. Include relevant datasets, trends, correlations, and statistical insights.',
      },
      {
        label: 'Data trends',
        prompt: 'Initialize the tools. Research data trends and patterns in [field]. Analyze historical data, identify trends, and forecast future patterns.',
      },
    ],
  },
];

interface ResearchStarterProps {
  onSelectPrompt: (prompt: string, placeholderInfo?: { start: number; end: number }) => void;
  onClose?: () => void;
  className?: string;
}

// Helper to extract placeholder info from prompt
function extractPlaceholderInfo(prompt: string): { start: number; end: number } | undefined {
  const placeholderRegex = /\[([^\]]+)\]/;
  const match = prompt.match(placeholderRegex);
  if (match && match.index !== undefined) {
    return {
      start: match.index,
      end: match.index + match[0].length,
    };
  }
  return undefined;
}

// Helper to format label with highlighted placeholders
function formatLabelWithPlaceholders(label: string, prompt: string): React.ReactNode {
  const placeholderRegex = /\[([^\]]+)\]/;
  const match = prompt.match(placeholderRegex);
  if (!match) return label;
  
  // Show placeholder in label if it exists
  return (
    <span>
      {label}
      <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 text-[10px] font-medium">
        {match[1]}
      </span>
    </span>
  );
}

export function ResearchStarter({
  onSelectPrompt,
  onClose,
  className,
}: ResearchStarterProps) {
  return (
    <div className={cn(
      'relative flex flex-col h-full min-h-0 bg-card/95 dark:bg-card/90 backdrop-blur-sm rounded-2xl overflow-hidden border border-border/50',
      className
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10">
            <BookOpen className="w-4 h-4 text-amber-600 dark:text-amber-400" />
          </div>
          <h2 className="text-base font-semibold text-foreground">AI Research</h2>
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
      <div className="flex-1 overflow-y-auto">
        {/* Hero Section */}
        <div className="px-6 py-8 text-center border-b border-border/30">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-500/20">
              <BookOpen className="w-8 h-8 text-amber-600 dark:text-amber-400" />
            </div>
            <h1 className="text-xl font-bold text-foreground mb-2">
              Deep Research with AI
            </h1>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Let AI search the web, analyze sources, and compile comprehensive research reports.
            </p>
          </motion.div>
        </div>

        {/* Use Cases */}
        <div className="px-5 py-5 space-y-3">
          {useCases.map((useCase, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1, duration: 0.2 }}
              className="flex items-start gap-3 p-3 rounded-xl bg-muted/30 border border-border/30"
            >
              <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-600 dark:text-amber-400">
                {useCase.icon}
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{useCase.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{useCase.description}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Research Prompt Examples - Organized by Category */}
        <div className="px-5 py-4 border-t border-border/30">
          <h3 className="text-sm font-semibold text-foreground mb-4">
            Research Prompt Examples
          </h3>
          <div className="space-y-6">
            {researchPrompts.map((category, categoryIndex) => (
              <motion.div
                key={category.category}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 + categoryIndex * 0.05, duration: 0.2 }}
                className="space-y-2"
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-shrink-0 text-amber-600 dark:text-amber-400">
                    {category.icon}
                  </div>
                  <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                    {category.category}
                  </h4>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {category.prompts.map((item, promptIndex) => {
                    const placeholderInfo = extractPlaceholderInfo(item.prompt);
                    return (
                      <motion.button
                        key={promptIndex}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ 
                          delay: 0.3 + categoryIndex * 0.05 + promptIndex * 0.02, 
                          duration: 0.15 
                        }}
                        onClick={() => onSelectPrompt(item.prompt, placeholderInfo)}
                        className={cn(
                          'flex items-start gap-2 p-2.5 rounded-lg text-left',
                          'bg-muted/40 hover:bg-accent border border-border/50 hover:border-foreground/20',
                          'transition-all duration-150 cursor-pointer',
                          'group text-xs'
                        )}
                      >
                        <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors leading-snug flex items-center flex-wrap gap-1">
                          {formatLabelWithPlaceholders(item.label, item.prompt)}
                        </span>
                      </motion.button>
                    );
                  })}
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Research Preview with Overlay - Compact */}
        <div className="px-5 py-3 border-t border-border/30">
          <div className="relative rounded-lg border border-border/50 overflow-hidden bg-white dark:bg-zinc-900 p-3">
            {/* Search results mock */}
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <div className="w-3 h-3 rounded bg-amber-500/30 flex-shrink-0 mt-0.5" />
                <div className="flex-1 space-y-1">
                  <div className="h-2.5 w-3/4 rounded bg-muted/40" />
                  <div className="h-1.5 w-full rounded bg-muted/20" />
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-3 h-3 rounded bg-amber-500/30 flex-shrink-0 mt-0.5" />
                <div className="flex-1 space-y-1">
                  <div className="h-2.5 w-2/3 rounded bg-muted/40" />
                  <div className="h-1.5 w-5/6 rounded bg-muted/20" />
                </div>
              </div>
            </div>
            {/* Overlay */}
            <div className="absolute inset-0 flex items-center justify-center bg-background/70 dark:bg-background/80 backdrop-blur-[2px]">
              <div className="text-center px-3">
                <Search className="w-5 h-5 mx-auto mb-1.5 text-amber-500/60" />
                <p className="text-xs font-medium text-muted-foreground">
                  Your research will appear here
                </p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                  Describe what you want to research
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer CTA */}
      <div className="px-5 py-4 border-t border-border/50 bg-card/80">
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          <span>Ready — describe your research topic in the chat below</span>
        </div>
      </div>
    </div>
  );
}
