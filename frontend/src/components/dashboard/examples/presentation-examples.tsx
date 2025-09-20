'use client';

import React from 'react';

type PresentationExample = {
  title: string;
  subtitle: string;
  query: string;
  imageUrl: string;
};

const presentationExamples: PresentationExample[] = [
  {
    title: 'Investor Pitch',
    subtitle: 'Funding & growth story',
    query: 'Create an investor pitch deck for {{company}} including problem/solution, market opportunity, business model, traction metrics, financial projections, team, competitive advantage, and funding ask with use of funds',
    imageUrl: 'https://images.unsplash.com/photo-1559136555-9303baea8ebd?w=400&h=300&fit=crop',
  },
  {
    title: 'Sales Presentation',
    subtitle: 'Product demo & benefits',
    query: 'Design a sales presentation for {{product/service}} with customer pain points, solution overview, key features, ROI analysis, case studies, pricing tiers, and clear call-to-action',
    imageUrl: 'https://images.unsplash.com/photo-1552664730-d307ca884978?w=400&h=300&fit=crop',
  },
  {
    title: 'Project Proposal',
    subtitle: 'Strategy & timeline',
    query: 'Build a project proposal presentation for {{project}} including objectives, scope, methodology, timeline with milestones, resource requirements, budget breakdown, risk mitigation, and expected outcomes',
    imageUrl: 'https://images.unsplash.com/photo-1531403009284-440f080d1e12?w=400&h=300&fit=crop',
  },
  {
    title: 'Company All-Hands',
    subtitle: 'Updates & achievements',
    query: 'Create an all-hands presentation covering {{quarter}} performance highlights, key wins, team updates, upcoming initiatives, challenges and solutions, cultural moments, and Q&A topics',
    imageUrl: 'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=400&h=300&fit=crop',
  },
  {
    title: 'Training Workshop',
    subtitle: 'Educational content',
    query: 'Develop a training presentation on {{topic}} with learning objectives, key concepts explained simply, interactive exercises, real-world examples, best practices, and knowledge check questions',
    imageUrl: 'https://images.unsplash.com/photo-1524178232363-1fb2b075b655?w=400&h=300&fit=crop',
  },
  {
    title: 'Product Launch',
    subtitle: 'Feature announcement',
    query: 'Design a product launch presentation for {{product}} showcasing the vision, key features, target audience, competitive advantages, go-to-market strategy, pricing, and launch timeline',
    imageUrl: 'https://images.unsplash.com/photo-1553877522-43269d4ea984?w=400&h=300&fit=crop',
  },
  {
    title: 'Quarterly Review',
    subtitle: 'Performance metrics',
    query: 'Create a quarterly business review presentation with KPI dashboard, revenue analysis, customer metrics, team performance, wins and challenges, lessons learned, and next quarter goals',
    imageUrl: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=400&h=300&fit=crop',
  },
  {
    title: 'Conference Keynote',
    subtitle: 'Thought leadership',
    query: 'Craft a keynote presentation on {{topic}} with compelling opening, industry insights, innovative ideas, supporting data, memorable stories, actionable takeaways, and inspiring conclusion',
    imageUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=400&h=300&fit=crop',
  },
  {
    title: 'Strategy Deck',
    subtitle: 'Vision & roadmap',
    query: 'Build a strategy presentation outlining {{year}} vision, market analysis, strategic priorities, initiative roadmap, resource allocation, success metrics, and implementation timeline',
    imageUrl: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400&h=300&fit=crop',
  },
  {
    title: 'Client Proposal',
    subtitle: 'Solution & pricing',
    query: 'Create a client proposal presentation for {{client}} with needs assessment, proposed solution, implementation plan, team expertise, similar client successes, pricing options, and next steps',
    imageUrl: 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=400&h=300&fit=crop',
  },
  {
    title: 'Research Findings',
    subtitle: 'Data & insights',
    query: 'Present research findings on {{study}} including methodology, key discoveries, data visualizations, statistical analysis, implications, recommendations, and areas for future research',
    imageUrl: 'https://images.unsplash.com/photo-1551135049-8a33b5883817?w=400&h=300&fit=crop',
  },
  {
    title: 'Award Submission',
    subtitle: 'Achievement showcase',
    query: 'Develop an award submission presentation for {{award}} highlighting achievements, innovation, impact metrics, testimonials, supporting evidence, and why we deserve to win',
    imageUrl: 'https://images.unsplash.com/photo-1567427017947-545c5f8d16ad?w=400&h=300&fit=crop',
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 w-full max-w-4xl px-4 lg:px-0">
          {displayedExamples.map((example) => (
            <PresentationExampleCard
              key={example.title}
              title={example.title}
              subtitle={example.subtitle}
              imageUrl={example.imageUrl}
              onClick={() => onSelectPrompt?.(example.query)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface PresentationExampleCardProps {
  title: string;
  subtitle: string;
  onClick: () => void;
  imageUrl: string;
}

function PresentationExampleCard({
  title,
  subtitle,
  onClick,
  imageUrl
}: PresentationExampleCardProps) {
  return (
    <div
      onClick={onClick}
      className="group relative cursor-pointer rounded-xl overflow-hidden border border-border/50 hover:border-primary/30 transition-all duration-300"
    >
      <div className="aspect-[4/3] overflow-hidden">
        <img 
          src={imageUrl} 
          alt={title}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          loading="lazy"
        />
      </div>
      
      <div className="p-3 bg-muted/30 group-hover:bg-muted/60 transition-all">
        <h3 className="text-sm font-medium text-foreground line-clamp-1">
          {title}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
          {subtitle}
        </p>
      </div>
    </div>
  );
}
