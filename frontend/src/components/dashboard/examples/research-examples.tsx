'use client';

import React from 'react';
import { BaseExamples, type ExamplePrompt } from './base-examples';
import {
  Microscope,
  TrendingUp,
  BarChart3,
  Search,
  Database,
  FileText,
  Globe,
  Brain,
  BookOpen,
  Target,
  ChartBar,
  PieChart,
  FileSearch,
  Users,
  Building,
} from 'lucide-react';

const researchExamples: ExamplePrompt[] = [
  {
    title: 'Market analysis report',
    query: 'Research the current market landscape for {{industry}}, analyze top competitors, market size, growth trends, and emerging opportunities. Create a comprehensive report with data visualizations',
    icon: <TrendingUp className="text-purple-700 dark:text-purple-400" />,
  },
  {
    title: 'Academic literature review',
    query: 'Conduct a systematic literature review on {{topic}}, analyze peer-reviewed papers from the last 5 years, identify key findings, methodologies, and research gaps',
    icon: <BookOpen className="text-blue-700 dark:text-blue-400" />,
  },
  {
    title: 'Competitive intelligence',
    query: 'Analyze {{competitor}} business strategy, product offerings, pricing models, marketing tactics, and recent developments. Compare with our positioning and identify opportunities',
    icon: <Target className="text-red-700 dark:text-red-400" />,
  },
  {
    title: 'Industry trend analysis',
    query: 'Research emerging trends in {{industry}}, analyze technological disruptions, regulatory changes, consumer behavior shifts, and predict future developments with supporting data',
    icon: <ChartBar className="text-green-700 dark:text-green-400" />,
  },
  {
    title: 'Customer sentiment research',
    query: 'Analyze customer reviews, social media mentions, and feedback for {{product/brand}}. Identify common pain points, satisfaction drivers, and improvement opportunities',
    icon: <Users className="text-orange-700 dark:text-orange-400" />,
  },
  {
    title: 'Patent landscape analysis',
    query: 'Research patent filings in {{technology area}}, identify key innovators, technology trends, white spaces for innovation, and potential IP opportunities or risks',
    icon: <FileSearch className="text-indigo-700 dark:text-indigo-400" />,
  },
  {
    title: 'Economic impact study',
    query: 'Research the economic impact of {{topic/event}}, analyze data from multiple sources, assess direct and indirect effects, and project future implications',
    icon: <BarChart3 className="text-teal-700 dark:text-teal-400" />,
  },
  {
    title: 'Technology assessment',
    query: 'Evaluate {{technology}}, compare different solutions, analyze pros/cons, implementation costs, ROI, risks, and provide recommendations based on our requirements',
    icon: <Microscope className="text-purple-600 dark:text-purple-300" />,
  },
  {
    title: 'Supply chain research',
    query: 'Map the supply chain for {{product/industry}}, identify key suppliers, vulnerabilities, alternative sources, and optimization opportunities with risk assessment',
    icon: <Building className="text-gray-700 dark:text-gray-400" />,
  },
  {
    title: 'Demographic analysis',
    query: 'Research demographic trends in {{location/market}}, analyze population data, income levels, education, consumer behavior patterns, and market potential',
    icon: <PieChart className="text-pink-700 dark:text-pink-400" />,
  },
  {
    title: 'Policy research brief',
    query: 'Research {{policy topic}}, analyze current regulations, proposed changes, stakeholder positions, potential impacts, and create executive briefing with recommendations',
    icon: <FileText className="text-yellow-700 dark:text-yellow-400" />,
  },
  {
    title: 'Investment opportunity scan',
    query: 'Research investment opportunities in {{sector}}, analyze market dynamics, growth potential, risk factors, valuation metrics, and identify top prospects',
    icon: <Database className="text-cyan-700 dark:text-cyan-400" />,
  },
  {
    title: 'Scientific research synthesis',
    query: 'Synthesize recent scientific research on {{topic}}, explain complex findings in accessible terms, identify consensus views and controversies, practical applications',
    icon: <Brain className="text-rose-700 dark:text-rose-400" />,
  },
  {
    title: 'Global market entry research',
    query: 'Research {{country}} market for entry strategy, analyze regulatory environment, competition, cultural factors, distribution channels, and entry barriers',
    icon: <Globe className="text-blue-600 dark:text-blue-300" />,
  },
  {
    title: 'User behavior research',
    query: 'Analyze user behavior data for {{product/service}}, identify usage patterns, engagement metrics, conversion funnels, and opportunities for optimization',
    icon: <Search className="text-green-600 dark:text-green-300" />,
  },
];

interface ResearchExamplesProps {
  onSelectPrompt?: (query: string) => void;
  count?: number;
}

export function ResearchExamples({ onSelectPrompt, count = 4 }: ResearchExamplesProps) {
  return (
    <BaseExamples
      examples={researchExamples}
      onSelectPrompt={onSelectPrompt}
      count={count}
      title="Research Assistant Examples"
      description="Deep analysis and comprehensive research on any topic"
    />
  );
}
