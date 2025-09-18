'use client';

import React from 'react';
import { PresentationExampleCard } from './presentation-example-card';
import {
  PresentationIcon,
  TrendingUp,
  GraduationCap,
  Rocket,
  Users,
  Target,
  DollarSign,
  Award,
  Lightbulb,
  BarChart3,
  Building,
  Globe,
} from 'lucide-react';

type PresentationExample = {
  title: string;
  subtitle: string;
  query: string;
  icon: React.ReactNode;
  slideType: 'pitch' | 'sales' | 'data' | 'team' | 'product' | 'strategy';
};

const presentationExamples: PresentationExample[] = [
  {
    title: 'Investor Pitch',
    subtitle: 'Funding & growth story',
    query: 'Create an investor pitch deck for {{company}} including problem/solution, market opportunity, business model, traction metrics, financial projections, team, competitive advantage, and funding ask with use of funds',
    icon: <Rocket />,
    slideType: 'pitch',
  },
  {
    title: 'Sales Presentation',
    subtitle: 'Product demo & benefits',
    query: 'Design a sales presentation for {{product/service}} with customer pain points, solution overview, key features, ROI analysis, case studies, pricing tiers, and clear call-to-action',
    icon: <DollarSign />,
    slideType: 'sales',
  },
  {
    title: 'Project Proposal',
    subtitle: 'Strategy & timeline',
    query: 'Build a project proposal presentation for {{project}} including objectives, scope, methodology, timeline with milestones, resource requirements, budget breakdown, risk mitigation, and expected outcomes',
    icon: <Target />,
    slideType: 'strategy',
  },
  {
    title: 'Company All-Hands',
    subtitle: 'Updates & achievements',
    query: 'Create an all-hands presentation covering {{quarter}} performance highlights, key wins, team updates, upcoming initiatives, challenges and solutions, cultural moments, and Q&A topics',
    icon: <Users />,
    slideType: 'team',
  },
  {
    title: 'Training Workshop',
    subtitle: 'Educational content',
    query: 'Develop a training presentation on {{topic}} with learning objectives, key concepts explained simply, interactive exercises, real-world examples, best practices, and knowledge check questions',
    icon: <GraduationCap />,
    slideType: 'team',
  },
  {
    title: 'Product Launch',
    subtitle: 'Feature announcement',
    query: 'Design a product launch presentation for {{product}} showcasing the vision, key features, target audience, competitive advantages, go-to-market strategy, pricing, and launch timeline',
    icon: <Rocket />,
    slideType: 'product',
  },
  {
    title: 'Quarterly Review',
    subtitle: 'Performance metrics',
    query: 'Create a quarterly business review presentation with KPI dashboard, revenue analysis, customer metrics, team performance, wins and challenges, lessons learned, and next quarter goals',
    icon: <BarChart3 />,
    slideType: 'data',
  },
  {
    title: 'Conference Keynote',
    subtitle: 'Thought leadership',
    query: 'Craft a keynote presentation on {{topic}} with compelling opening, industry insights, innovative ideas, supporting data, memorable stories, actionable takeaways, and inspiring conclusion',
    icon: <Lightbulb />,
    slideType: 'pitch',
  },
  {
    title: 'Strategy Deck',
    subtitle: 'Vision & roadmap',
    query: 'Build a strategy presentation outlining {{year}} vision, market analysis, strategic priorities, initiative roadmap, resource allocation, success metrics, and implementation timeline',
    icon: <TrendingUp />,
    slideType: 'strategy',
  },
  {
    title: 'Client Proposal',
    subtitle: 'Solution & pricing',
    query: 'Create a client proposal presentation for {{client}} with needs assessment, proposed solution, implementation plan, team expertise, similar client successes, pricing options, and next steps',
    icon: <Building />,
    slideType: 'sales',
  },
  {
    title: 'Research Findings',
    subtitle: 'Data & insights',
    query: 'Present research findings on {{study}} including methodology, key discoveries, data visualizations, statistical analysis, implications, recommendations, and areas for future research',
    icon: <Globe />,
    slideType: 'data',
  },
  {
    title: 'Award Submission',
    subtitle: 'Achievement showcase',
    query: 'Develop an award submission presentation for {{award}} highlighting achievements, innovation, impact metrics, testimonials, supporting evidence, and why we deserve to win',
    icon: <Award />,
    slideType: 'product',
  },
];

interface PresentationExamplesProps {
  onSelectPrompt?: (query: string) => void;
  count?: number;
}

export function PresentationExamples({ onSelectPrompt, count = 4 }: PresentationExamplesProps) {
  const [displayedExamples, setDisplayedExamples] = React.useState<PresentationExample[]>([]);

  React.useEffect(() => {
    const shuffled = [...presentationExamples].sort(() => 0.5 - Math.random());
    setDisplayedExamples(shuffled.slice(0, count));
  }, [count]);

  return (
    <div className="w-full">
      <div className="flex justify-center">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {displayedExamples.map((example, index) => (
            <PresentationExampleCard
              key={example.title}
              title={example.title}
              subtitle={example.subtitle}
              icon={example.icon}
              slideType={example.slideType}
              onClick={() => onSelectPrompt?.(example.query)}
              index={index}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
