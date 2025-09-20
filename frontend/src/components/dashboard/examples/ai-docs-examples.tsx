'use client';

import React from 'react';
import { DocExampleCard } from './doc-example-card';
import {
  FileText,
  Mail,
  Briefcase,
  GraduationCap,
  Newspaper,
  Users,
  FileSignature,
  PresentationIcon,
  ClipboardList,
  BookOpen,
  Receipt,
  Calendar,
  ScrollText,
  Heart,
  Megaphone,
} from 'lucide-react';

type DocExample = {
  title: string;
  subtitle: string;
  query: string;
  icon: React.ReactNode;
  templateType: 'api' | 'readme' | 'guide' | 'schema' | 'changelog' | 'config';
};

const aiDocsExamples: DocExample[] = [
  {
    title: 'Business Letter',
    subtitle: 'Professional correspondence',
    query: 'Write a professional business letter for {{purpose}} with proper formatting, tone, and structure including letterhead, salutation, body, and closing',
    icon: <Mail />,
    templateType: 'readme',
  },
  {
    title: 'Project Report',
    subtitle: 'Executive summary & analysis',
    query: 'Create a comprehensive project report including executive summary, methodology, findings, data analysis, recommendations, and conclusions with charts and graphs',
    icon: <Briefcase />,
    templateType: 'guide',
  },
  {
    title: 'Resume / CV',
    subtitle: 'Professional profile',
    query: 'Generate a professional resume for {{job_title}} position highlighting relevant experience, skills, education, achievements, and tailored to the job description',
    icon: <GraduationCap />,
    templateType: 'readme',
  },
  {
    title: 'Blog Article',
    subtitle: 'Engaging content piece',
    query: 'Write an engaging blog post about {{topic}} with compelling introduction, structured sections, examples, key takeaways, and SEO-optimized content',
    icon: <Newspaper />,
    templateType: 'guide',
  },
  {
    title: 'Meeting Minutes',
    subtitle: 'Discussion & action items',
    query: 'Document meeting minutes including attendees, agenda items, key discussions, decisions made, action items with owners and deadlines',
    icon: <Users />,
    templateType: 'changelog',
  },
  {
    title: 'Legal Contract',
    subtitle: 'Terms and agreements',
    query: 'Draft a {{contract_type}} contract with standard clauses, terms and conditions, obligations, payment terms, termination clauses, and legal disclaimers',
    icon: <FileSignature />,
    templateType: 'config',
  },
  {
    title: 'Business Proposal',
    subtitle: 'Pitch and pricing',
    query: 'Create a business proposal for {{client/project}} including executive summary, solution overview, implementation plan, timeline, pricing, and terms',
    icon: <PresentationIcon />,
    templateType: 'schema',
  },
  {
    title: 'Academic Essay',
    subtitle: 'Research paper',
    query: 'Write an academic essay on {{topic}} with thesis statement, literature review, arguments, evidence, citations, and conclusion in {{citation_style}} format',
    icon: <BookOpen />,
    templateType: 'guide',
  },
  {
    title: 'Invoice',
    subtitle: 'Billing document',
    query: 'Generate a professional invoice with company details, client information, itemized services/products, taxes, payment terms, and bank details',
    icon: <Receipt />,
    templateType: 'api',
  },
  {
    title: 'Event Planning',
    subtitle: 'Schedule & logistics',
    query: 'Create an event planning document for {{event}} including timeline, venue details, vendor list, budget breakdown, guest list, and contingency plans',
    icon: <Calendar />,
    templateType: 'changelog',
  },
  {
    title: 'Press Release',
    subtitle: 'News announcement',
    query: 'Write a press release for {{announcement}} with attention-grabbing headline, lead paragraph, supporting details, quotes, boilerplate, and contact information',
    icon: <Megaphone />,
    templateType: 'readme',
  },
  {
    title: 'Personal Statement',
    subtitle: 'Application letter',
    query: 'Craft a compelling personal statement for {{application_type}} highlighting background, motivations, achievements, goals, and why you are the ideal candidate',
    icon: <Heart />,
    templateType: 'guide',
  },
];

interface AIDocsExamplesProps {
  onSelectPrompt?: (query: string) => void;
  count?: number;
}

export function AIDocsExamples({ onSelectPrompt, count = 4 }: AIDocsExamplesProps) {
  const [displayedExamples, setDisplayedExamples] = React.useState<DocExample[]>([]);

  React.useEffect(() => {
    const shuffled = [...aiDocsExamples].sort(() => 0.5 - Math.random());
    setDisplayedExamples(shuffled.slice(0, count));
  }, [count]);

  return (
    <div className="w-full">
      <div className="flex justify-center">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 w-full max-w-4xl px-4 lg:px-0">
          {displayedExamples.map((example, index) => (
            <DocExampleCard
              key={example.title}
              title={example.title}
              subtitle={example.subtitle}
              icon={example.icon}
              templateType={example.templateType}
              onClick={() => onSelectPrompt?.(example.query)}
              index={index}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
