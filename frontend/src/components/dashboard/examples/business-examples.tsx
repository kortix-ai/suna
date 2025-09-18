'use client';

import React from 'react';
import { BaseExamples, type ExamplePrompt } from './base-examples';
import {
  Briefcase,
  TrendingUp,
  DollarSign,
  PieChart,
  Target,
  Users,
  Building,
  BarChart3,
  Calculator,
  FileText,
  Presentation,
  Handshake,
  Globe,
  Package,
  CreditCard,
} from 'lucide-react';

const businessExamples: ExamplePrompt[] = [
  {
    title: 'Create business plan',
    query: 'Develop a comprehensive business plan for {{business_idea}} including executive summary, market analysis, financial projections, marketing strategy, and operational plan',
    icon: <Briefcase className="text-blue-700 dark:text-blue-400" />,
  },
  {
    title: 'Financial analysis',
    query: 'Analyze financial statements for {{company}}, calculate key ratios, assess profitability, liquidity, efficiency metrics, and provide investment recommendations',
    icon: <Calculator className="text-green-700 dark:text-green-400" />,
  },
  {
    title: 'Market sizing',
    query: 'Calculate the total addressable market (TAM), serviceable addressable market (SAM), and serviceable obtainable market (SOM) for {{product/service}} with data sources',
    icon: <PieChart className="text-purple-700 dark:text-purple-400" />,
  },
  {
    title: 'Competitive strategy',
    query: 'Develop competitive strategy for {{business}}, analyze competitive forces, identify unique value proposition, positioning, and differentiation strategies',
    icon: <Target className="text-red-700 dark:text-red-400" />,
  },
  {
    title: 'Sales forecast model',
    query: 'Build sales forecasting model for next {{time_period}}, analyze historical data, seasonal trends, market factors, and create multiple scenarios',
    icon: <TrendingUp className="text-orange-700 dark:text-orange-400" />,
  },
  {
    title: 'Pricing optimization',
    query: 'Optimize pricing strategy for {{product}}, analyze competitor pricing, price elasticity, value-based pricing models, and recommend optimal price points',
    icon: <DollarSign className="text-teal-700 dark:text-teal-400" />,
  },
  {
    title: 'Customer acquisition',
    query: 'Design customer acquisition strategy with channel analysis, CAC calculations, LTV projections, funnel optimization, and growth tactics for {{target_market}}',
    icon: <Users className="text-indigo-700 dark:text-indigo-400" />,
  },
  {
    title: 'Investment pitch deck',
    query: 'Create investor pitch deck for {{company}} with problem/solution, market opportunity, business model, traction, financials, team, and funding ask',
    icon: <Presentation className="text-pink-700 dark:text-pink-400" />,
  },
  {
    title: 'Partnership proposal',
    query: 'Draft strategic partnership proposal for {{partner_company}}, outline mutual benefits, collaboration framework, revenue sharing, and implementation plan',
    icon: <Handshake className="text-cyan-700 dark:text-cyan-400" />,
  },
  {
    title: 'Budget planning',
    query: 'Create detailed budget for {{department/project}}, allocate resources, identify cost centers, set KPIs, and establish monitoring framework',
    icon: <CreditCard className="text-yellow-700 dark:text-yellow-400" />,
  },
  {
    title: 'SWOT analysis',
    query: 'Conduct comprehensive SWOT analysis for {{company}}, evaluate internal strengths/weaknesses, external opportunities/threats, and strategic recommendations',
    icon: <BarChart3 className="text-gray-700 dark:text-gray-400" />,
  },
  {
    title: 'Supply chain strategy',
    query: 'Optimize supply chain for {{product}}, analyze suppliers, logistics, inventory management, risk mitigation, and cost reduction opportunities',
    icon: <Package className="text-rose-700 dark:text-rose-400" />,
  },
  {
    title: 'Market expansion plan',
    query: 'Develop market expansion strategy for {{new_market}}, analyze entry barriers, localization needs, regulatory requirements, and go-to-market approach',
    icon: <Globe className="text-blue-600 dark:text-blue-300" />,
  },
  {
    title: 'Risk assessment',
    query: 'Conduct business risk assessment, identify operational, financial, strategic, compliance risks, create risk matrix, and develop mitigation strategies',
    icon: <Building className="text-green-600 dark:text-green-300" />,
  },
  {
    title: 'Executive summary',
    query: 'Write executive summary for {{report/proposal}}, distill key findings, recommendations, financial impact, and action items for C-suite presentation',
    icon: <FileText className="text-purple-600 dark:text-purple-300" />,
  },
];

interface BusinessExamplesProps {
  onSelectPrompt?: (query: string) => void;
  count?: number;
}

export function BusinessExamples({ onSelectPrompt, count = 4 }: BusinessExamplesProps) {
  return (
    <BaseExamples
      examples={businessExamples}
      onSelectPrompt={onSelectPrompt}
      count={count}
      title="Business Assistant Examples"
      description="Strategic business analysis, planning, and optimization"
    />
  );
}
