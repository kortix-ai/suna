'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import {
  BarChart3,
  Briefcase,
  Settings,
  TrendingUp,
  Users,
  Shield,
  Target,
  Brain,
  Globe,
  Heart,
  PenTool,
  Camera,
  Calendar,
  DollarSign,
  Rocket,
  RefreshCw,
} from 'lucide-react';

type PromptExample = {
  title: string;
  query: string;
  icon: React.ReactNode;
};

const allPrompts: PromptExample[] = [
  {
    title: 'Find best bakeries map',
    query: '1. Search Google Maps for "best bakeries in {{city}}"\n2. Create a custom list with top {{number}} bakeries\n3. For each bakery, gather:\n   - Customer ratings and popular items\n   - Hours, location, and specialties\n   - Price range and must-try pastries\n4. Generate a summary with recommendations',
    icon: <Globe className="text-blue-700 dark:text-blue-400" size={16} />,
  },
  {
    title: 'Research education data',
    query: '1. Access UNESCO database for {{topic}} education statistics\n2. Compile data on:\n   - Student enrollment ratios by region\n   - Teacher-to-student ratios globally\n   - Education spending as % of GDP\n3. Create structured spreadsheet with trends\n4. Generate executive summary with key insights',
    icon: <BarChart3 className="text-purple-700 dark:text-purple-400" size={16} />,
  },
  {
    title: 'Plan travel itinerary',
    query: '1. Research {{destination}} on TripAdvisor for {{duration}} day trip\n2. Find top attractions, restaurants, and activities\n3. Optimize daily schedule by location and hours\n4. Include transportation, weather, and backup plans\n5. Create day-by-day itinerary with time blocks',
    icon: <Calendar className="text-rose-700 dark:text-rose-400" size={16} />,
  },
  {
    title: 'Analyze news coverage',
    query: '1. Search {{news_outlet}} for {{topic}} articles from past {{time_period}}\n2. Categorize coverage and identify key themes\n3. Track expert sources and data points\n4. Create timeline of major developments\n5. Generate report with insights and coverage gaps',
    icon: <PenTool className="text-indigo-700 dark:text-indigo-400" size={16} />,
  },
  // {
  //   title: 'Book restaurant reservations',
  //   query: '1. Search OpenTable for restaurants in {{city}} for {{occasion}}\n2. Filter by date, party size, and cuisine preferences\n3. Check reviews and menu highlights\n4. Make reservations at {{number}} restaurants\n5. Create itinerary with confirmation details',
  //   icon: <Users className="text-emerald-700 dark:text-emerald-400" size={16} />,
  // },
  {
    title: 'Build financial model',
    query: '1. Create {{model_type}} model for {{company_type}} business\n2. Gather historical data and industry benchmarks\n3. Build revenue forecasts and expense projections\n4. Include DCF, LTV/CAC, or NPV analysis\n5. Design Excel dashboard with scenarios',
    icon: <DollarSign className="text-orange-700 dark:text-orange-400" size={16} />,
  },
  {
    title: 'Develop market strategy',
    query: '1. Create go-to-market strategy for {{product_type}} launch\n2. Analyze target market and competitive landscape\n3. Design market entry and pricing strategy\n4. Build financial projections and timeline\n5. Create presentation with recommendations',
    icon: <Target className="text-cyan-700 dark:text-cyan-400" size={16} />,
  },
  {
    title: 'Research company intelligence',
    query: '1. Research {{company_name}} comprehensively\n2. Gather recent news, funding, and leadership info\n3. Analyze competitive position and market share\n4. Research key personnel background\n5. Create detailed profile with actionable insights',
    icon: <Briefcase className="text-teal-700 dark:text-teal-400" size={16} />,
  },
  {
    title: 'Audit calendar productivity',
    query: '1. Analyze {{calendar_app}} data from past {{months}} months\n2. Assess meeting frequency and focus time\n3. Identify optimization opportunities\n4. Analyze meeting effectiveness patterns\n5. Generate recommendations and implementation plan',
    icon: <Calendar className="text-violet-700 dark:text-violet-400" size={16} />,
  },
  {
    title: 'Research industry trends',
    query: '1. Research {{industry}} trends from {{data_sources}}\n2. Gather investment activity and technology developments\n3. Analyze market drivers and opportunities\n4. Identify emerging themes and gaps\n5. Create comprehensive report with recommendations',
    icon: <TrendingUp className="text-pink-700 dark:text-pink-400" size={16} />,
  },
  {
    title: 'Automate support tickets',
    query: '1. Monitor {{support_platform}} for incoming tickets\n2. Categorize issues and assess urgency\n3. Search {{knowledge_base}} for solutions\n4. Auto-respond or escalate based on confidence\n5. Track metrics and generate daily reports',
    icon: <Shield className="text-yellow-600 dark:text-yellow-300" size={16} />,
  },
  {
    title: 'Research legal compliance',
    query: '1. Research {{legal_topic}} across {{jurisdictions}}\n2. Compare state requirements and fees\n3. Analyze decision factors and implications\n4. Gather practical implementation details\n5. Create comparison spreadsheet with recommendations',
    icon: <Settings className="text-red-700 dark:text-red-400" size={16} />,
  },
  {
    title: 'Compile data analysis',
    query: '1. Gather {{data_topic}} from {{data_sources}}\n2. Clean and standardize datasets\n3. Analyze patterns and calculate trends\n4. Create spreadsheet with visualizations\n5. Provide strategic recommendations',
    icon: <BarChart3 className="text-slate-700 dark:text-slate-400" size={16} />,
  },
  {
    title: 'Plan social media content',
    query: '1. Create {{duration}} social strategy for {{brand}}\n2. Research trending topics and competitor content\n3. Develop content calendar with {{posts_per_week}} posts\n4. Create platform-specific content and scheduling\n5. Set up analytics and monthly reporting',
    icon: <Camera className="text-stone-700 dark:text-stone-400" size={16} />,
  },
  {
    title: 'Compare products',
    query: '1. Research {{product_category}} options comprehensively\n2. Gather scientific studies and expert opinions\n3. Analyze benefits, drawbacks, and costs\n4. Research current expert consensus\n5. Create comparison report with personalized recommendations',
    icon: <Brain className="text-fuchsia-700 dark:text-fuchsia-400" size={16} />,
  },
  {
    title: 'Analyze market opportunities',
    query: '1. Research {{market_topic}} for investment opportunities\n2. Analyze market size, growth, and key players\n3. Identify investment themes and risks\n4. Assess market challenges and barriers\n5. Create investment presentation with recommendations',
    icon: <Rocket className="text-green-600 dark:text-green-300" size={16} />,
  },
  {
    title: 'Process invoices & documents',
    query: '1. Scan {{document_folder}} for PDF invoices\n2. Extract key data: numbers, dates, amounts, vendors\n3. Organize data with standardized fields\n4. Build comprehensive tracking spreadsheet\n5. Generate monthly financial reports',
    icon: <Heart className="text-amber-700 dark:text-amber-400" size={16} />,
  },
  {
    title: 'Source talent & candidates',
    query: '1. Search for {{job_title}} candidates in {{location}}\n2. Use LinkedIn, GitHub, and job boards\n3. Evaluate skills, experience, and culture fit\n4. Create ranked candidate pipeline\n5. Develop personalized outreach strategy',
    icon: <Users className="text-blue-600 dark:text-blue-300" size={16} />,
  },
  {
    title: 'Build professional website',
    query: '1. Research {{person_name}} online comprehensively\n2. Analyze professional brand and achievements\n3. Design website structure and content\n4. Create optimized pages with portfolio\n5. Implement SEO and performance features',
    icon: <Globe className="text-red-600 dark:text-red-300" size={16} />,
  },
];

const getRandomPrompts = (count: number = 3): PromptExample[] => {
  const shuffled = [...allPrompts].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
};

export const Examples = ({
  onSelectPrompt,
  count = 3,
}: {
  onSelectPrompt?: (query: string) => void;
  count?: number;
}) => {
  const [displayedPrompts, setDisplayedPrompts] = useState<PromptExample[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    setDisplayedPrompts(getRandomPrompts(count));
  }, [count]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    setDisplayedPrompts(getRandomPrompts(count));
    setTimeout(() => setIsRefreshing(false), 300);
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      <div className="group relative">
        <div className="flex gap-2 justify-center py-2 flex-wrap">
          {displayedPrompts.map((prompt, index) => (
            <motion.div
              key={`${prompt.title}-${index}`}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{
                duration: 0.3,
                delay: index * 0.03,
                ease: "easeOut"
              }}
            >
              <Button
                variant="outline"
                className="w-fit h-fit px-3 py-2 rounded-full border-neutral-200 dark:border-neutral-800 bg-neutral-50 hover:bg-neutral-100 dark:bg-neutral-900 dark:hover:bg-neutral-800 text-sm font-normal text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => onSelectPrompt && onSelectPrompt(prompt.query)}
              >
                <div className="flex items-center gap-2">
                  <div className="flex-shrink-0">
                    {React.cloneElement(prompt.icon as React.ReactElement, { size: 14 })}
                  </div>
                  <span className="whitespace-nowrap">{prompt.title}</span>
                </div>
              </Button>
            </motion.div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          className="absolute -top-4 right-1 h-5 w-5 p-0 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <motion.div
            animate={{ rotate: isRefreshing ? 360 : 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
          >
            <RefreshCw size={10} className="text-muted-foreground" />
          </motion.div>
        </Button>
      </div>
    </div>
  );
};