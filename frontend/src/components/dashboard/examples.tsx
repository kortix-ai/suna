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
    title: 'Automate multi-channel campaigns',
    query: '1. Connect to {{email_platform}}, {{social_platforms}}, and {{crm_system}}\n2. Create personalized campaigns for {{customer_segments}}\n3. Schedule content across {{number}} channels with optimal timing\n4. Track engagement metrics and auto-optimize performance\n5. Generate comprehensive ROI reports with actionable insights',
    icon: <Globe className="text-blue-700 dark:text-blue-400" size={16} />,
  },
  {
    title: 'Analyze customer journey data',
    query: '1. Integrate data from {{analytics_tools}}, {{crm}}, and {{marketing_platforms}}\n2. Map customer touchpoints across {{channels}} and {{timeframe}}\n3. Identify conversion bottlenecks and optimization opportunities\n4. Segment customers by behavior and lifetime value\n5. Create actionable recommendations for journey improvement',
    icon: <BarChart3 className="text-purple-700 dark:text-purple-400" size={16} />,
  },
  {
    title: 'Launch product marketing campaign',
    query: '1. Research {{target_audience}} preferences and {{competitor}} strategies\n2. Create launch timeline with {{channels}} and {{content_types}}\n3. Generate personalized messaging for {{segments}}\n4. Set up automated nurture sequences and follow-ups\n5. Monitor performance and adjust strategy in real-time',
    icon: <Calendar className="text-rose-700 dark:text-rose-400" size={16} />,
  },
  {
    title: 'Monitor brand sentiment & mentions',
    query: '1. Track brand mentions across {{social_platforms}}, {{review_sites}}, and {{news_sources}}\n2. Analyze sentiment trends and identify {{timeframe}} patterns\n3. Alert on negative sentiment spikes and crisis situations\n4. Generate competitor comparison and market positioning insights\n5. Create automated response workflows for common scenarios',
    icon: <PenTool className="text-indigo-700 dark:text-indigo-400" size={16} />,
  },
  {
    title: 'Build marketing attribution model',
    query: '1. Connect {{analytics_tools}}, {{crm}}, and {{advertising_platforms}} data\n2. Analyze {{timeframe}} customer acquisition paths and touchpoints\n3. Calculate channel contribution and ROI by {{segments}}\n4. Identify high-value conversion patterns and optimization opportunities\n5. Create dashboard with real-time attribution insights',
    icon: <DollarSign className="text-orange-700 dark:text-orange-400" size={16} />,
  },
  {
    title: 'Develop go-to-market strategy',
    query: '1. Research {{target_market}} size, trends, and {{competitor}} landscape\n2. Analyze customer personas and buying journey for {{product_category}}\n3. Create channel strategy with {{budget}} allocation and {{timeline}}\n4. Develop messaging framework and content calendar\n5. Set up tracking and optimization workflows',
    icon: <Target className="text-cyan-700 dark:text-cyan-400" size={16} />,
  },
  {
    title: 'Research competitor intelligence',
    query: '1. Monitor {{competitor}} marketing activities across {{channels}}\n2. Analyze their content strategy, messaging, and {{campaign_types}}\n3. Track their pricing, promotions, and customer engagement\n4. Identify market gaps and differentiation opportunities\n5. Generate competitive analysis report with strategic recommendations',
    icon: <Briefcase className="text-teal-700 dark:text-teal-400" size={16} />,
  },
  {
    title: 'Optimize marketing team productivity',
    query: '1. Analyze team workflows across {{marketing_tools}} and {{processes}}\n2. Identify bottlenecks in {{campaign_creation}}, {{content_production}}, and {{reporting}}\n3. Automate repetitive tasks and approval workflows\n4. Create performance dashboards and {{kpi}} tracking\n5. Generate efficiency recommendations and implementation plan',
    icon: <Calendar className="text-violet-700 dark:text-violet-400" size={16} />,
  },
  {
    title: 'Research industry marketing trends',
    query: '1. Gather {{industry}} marketing data from {{research_sources}} and {{conferences}}\n2. Analyze emerging {{technologies}}, {{strategies}}, and {{consumer_behavior}}\n3. Track investment in {{marketing_tools}} and {{automation_platforms}}\n4. Identify growth opportunities and market shifts\n5. Create trend report with strategic implications',
    icon: <TrendingUp className="text-pink-700 dark:text-pink-400" size={16} />,
  },
  {
    title: 'Automate lead scoring & nurturing',
    query: '1. Connect {{crm}} and {{marketing_automation}} platforms\n2. Set up behavioral triggers and {{scoring_criteria}} for {{lead_segments}}\n3. Create personalized nurture sequences based on {{interactions}}\n4. Automate lead handoff to {{sales_team}} with context\n5. Track conversion rates and optimize scoring models',
    icon: <Shield className="text-yellow-600 dark:text-yellow-300" size={16} />,
  },
  {
    title: 'Ensure marketing compliance',
    query: '1. Research {{gdpr}}, {{ccpa}}, and {{industry}} marketing regulations\n2. Audit current {{data_collection}}, {{email_practices}}, and {{privacy_policies}}\n3. Identify compliance gaps and {{risk_areas}}\n4. Create automated compliance monitoring and {{reporting}}\n5. Generate compliance checklist and implementation roadmap',
    icon: <Settings className="text-red-700 dark:text-red-400" size={16} />,
  },
  {
    title: 'Analyze marketing performance',
    query: '1. Aggregate data from {{analytics}}, {{crm}}, {{email_platform}}, and {{social_media}}\n2. Calculate {{kpis}} across {{channels}} and {{timeframes}}\n3. Identify top-performing {{campaigns}}, {{content}}, and {{segments}}\n4. Create performance dashboards with {{real_time}} updates\n5. Generate insights and optimization recommendations',
    icon: <BarChart3 className="text-slate-700 dark:text-slate-400" size={16} />,
  },
  {
    title: 'Create content marketing strategy',
    query: '1. Research {{target_audience}} content preferences and {{competitor}} strategies\n2. Develop {{content_calendar}} with {{topics}} and {{formats}}\n3. Create content templates and {{brand_guidelines}}\n4. Set up {{distribution}} across {{channels}} and {{scheduling}}\n5. Track performance and optimize content mix',
    icon: <Camera className="text-stone-700 dark:text-stone-400" size={16} />,
  },
  {
    title: 'Personalize customer experiences',
    query: '1. Analyze {{customer_data}} from {{crm}}, {{website}}, and {{email_interactions}}\n2. Create {{dynamic_segments}} based on {{behavior}} and {{preferences}}\n3. Develop personalized {{messaging}} and {{content}} for {{segments}}\n4. Implement {{automation}} workflows for {{touchpoints}}\n5. Measure personalization impact on {{conversion}} and {{engagement}}',
    icon: <Brain className="text-fuchsia-700 dark:text-fuchsia-400" size={16} />,
  },
  {
    title: 'Scale marketing operations',
    query: '1. Audit current {{marketing_stack}} and {{processes}} for {{scalability}}\n2. Identify automation opportunities in {{campaign_management}} and {{reporting}}\n3. Create {{workflow_templates}} and {{approval_processes}}\n4. Implement {{integration}} between {{tools}} and {{platforms}}\n5. Set up {{monitoring}} and {{optimization}} systems',
    icon: <Rocket className="text-green-600 dark:text-green-300" size={16} />,
  },
  {
    title: 'Process marketing data & reports',
    query: '1. Aggregate data from {{marketing_sources}} and {{analytics_platforms}}\n2. Clean and standardize {{datasets}} with {{quality_checks}}\n3. Create {{automated_reports}} with {{kpis}} and {{insights}}\n4. Set up {{dashboard}} with {{real_time}} {{visualizations}}\n5. Generate {{executive_summaries}} and {{action_items}}',
    icon: <Heart className="text-amber-700 dark:text-amber-400" size={16} />,
  },
  {
    title: 'Source marketing talent & partners',
    query: '1. Search for {{marketing_roles}} and {{agency_partners}} in {{location}}\n2. Evaluate {{skills}}, {{experience}}, and {{industry_expertise}}\n3. Analyze {{portfolio}} and {{case_studies}} for {{relevant_experience}}\n4. Create {{candidate_pipeline}} with {{scoring_criteria}}\n5. Develop {{outreach_strategy}} and {{evaluation_process}}',
    icon: <Users className="text-blue-600 dark:text-blue-300" size={16} />,
  },
  {
    title: 'Build marketing website & landing pages',
    query: '1. Research {{target_audience}} and {{competitor}} websites for {{best_practices}}\n2. Create {{conversion_optimized}} pages with {{seo}} and {{performance}}\n3. Implement {{tracking}} and {{analytics}} for {{user_behavior}}\n4. Set up {{a_b_testing}} and {{optimization}} workflows\n5. Generate {{technical_specifications}} and {{launch_plan}}',
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