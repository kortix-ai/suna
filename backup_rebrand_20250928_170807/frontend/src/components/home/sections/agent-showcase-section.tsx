'use client';

import { SectionHeader } from '@/components/home/section-header';
import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';

// Simple Agent Card Component
const AgentCard = ({ agent }: { agent: any }) => {
  return (
    <motion.div
      className="flex flex-col items-start justify-end min-h-[400px] relative group cursor-pointer hover:bg-accent/30 transition-colors duration-300"
    >
      <div className="relative flex size-full items-center justify-center h-full overflow-hidden">
        <div className="pointer-events-none absolute bottom-0 left-0 h-20 w-full bg-gradient-to-t from-background to-transparent z-20"></div>
        
        <div className="w-full h-full flex flex-col items-center justify-center gap-6 p-8 text-center">
          <motion.div 
            className="text-6xl mb-4 group-hover:scale-110 transition-transform duration-300"
            whileHover={{ rotate: [0, -10, 10, 0] }}
            transition={{ duration: 0.5 }}
          >
            {agent.icon}
          </motion.div>
          
          <div className="space-y-3">
            <h3 className="text-xl font-semibold tracking-tighter group-hover:text-primary transition-colors">
              {agent.name}
            </h3>
            <p className="text-sm text-primary/70 font-medium uppercase tracking-wider">
              {agent.role}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-xs">
              {agent.desc}
            </p>
          </div>

          <motion.button
            className="opacity-0 group-hover:opacity-100 inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 transition-all duration-300"
            initial={{ y: 10 }}
            whileHover={{ y: 0 }}
          >
            Try {agent.name} 
            <ArrowRight className="w-4 h-4" />
          </motion.button>
        </div>
      </div>
      
      <div className="flex-1 flex-col gap-2 p-6">
        <h4 className="text-lg tracking-tighter font-semibold">
          {agent.name} • {agent.role}
        </h4>
        <p className="text-muted-foreground text-sm">
          {agent.shortDesc || agent.desc.split('.')[0] + '.'}
        </p>
      </div>
    </motion.div>
  );
};

// Custom Agent Card Component
const CustomAgentCard = () => {
  return (
    <motion.div
      className="flex flex-col items-start justify-end min-h-[400px] relative group cursor-pointer hover:bg-primary/5 transition-colors duration-300"
    >
      <div className="relative flex size-full items-center justify-center h-full overflow-hidden">
        <div className="pointer-events-none absolute bottom-0 left-0 h-20 w-full bg-gradient-to-t from-background to-transparent z-20"></div>
        
        <div className="w-full h-full flex flex-col items-center justify-center gap-6 p-8 text-center">
          <motion.div 
            className="text-6xl mb-4 group-hover:scale-110 transition-transform duration-300"
            whileHover={{ rotate: [0, -10, 10, 0] }}
            transition={{ duration: 0.5 }}
          >
            ⚡
          </motion.div>
          
          <div className="space-y-3">
            <h3 className="text-xl font-semibold tracking-tighter group-hover:text-primary transition-colors">
              Build Your Own
            </h3>
            <p className="text-sm text-primary/70 font-medium uppercase tracking-wider">
              Custom Agent
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-xs">
              Create a specialized AI Worker tailored to your unique business needs and workflow.
            </p>
          </div>

          <motion.button
            className="opacity-0 group-hover:opacity-100 inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 transition-all duration-300"
            initial={{ y: 10 }}
            whileHover={{ y: 0 }}
          >
            Start Building 
            <ArrowRight className="w-4 h-4" />
          </motion.button>
        </div>
      </div>
      
      <div className="flex-1 flex-col gap-2 p-6">
        <h4 className="text-lg tracking-tighter font-semibold">
          Custom Agent • Your Choice
        </h4>
        <p className="text-muted-foreground text-sm">
          Design your own AI specialist for any task or industry
        </p>
      </div>
    </motion.div>
  );
};

// Agent Grid Component
const AgentGrid = () => {
  const agents = [
    { 
      name: 'Maya', 
      role: 'Copywriter', 
      icon: '✍️', 
      desc: 'Creates compelling copy for ads, blogs, and marketing campaigns that convert readers into customers.',
      shortDesc: 'AI copywriter for marketing content and campaigns'
    },
    { 
      name: 'Hunter', 
      role: 'Recruiter', 
      icon: '🎯', 
      desc: 'Turns hiring challenges into opportunities with magnetic job posts and smooth onboarding.',
      shortDesc: 'AI recruiter for job posting and candidate screening'
    },
    { 
      name: 'Nova', 
      role: 'SEO Specialist', 
      icon: '📈', 
      desc: 'Boosts website rankings with proven SEO strategies and optimized content.',
      shortDesc: 'AI SEO expert for website optimization and rankings'
    },
    { 
      name: 'Pixel', 
      role: 'Social Media Manager', 
      icon: '📱', 
      desc: 'Generates content, plans strategies, and manages social media presence effectively.',
      shortDesc: 'AI social media manager for content and engagement'
    },
    { 
      name: 'Sage', 
      role: 'Data Analyst', 
      icon: '📊', 
      desc: 'Transforms raw data into actionable insights with comprehensive analysis and reporting.',
      shortDesc: 'AI data analyst for insights and reporting'
    },
    { 
      name: 'Echo', 
      role: 'Project Manager', 
      icon: '📋', 
      desc: 'Streamlines workflows, coordinates tasks, and ensures timely project delivery.',
      shortDesc: 'AI project manager for workflow coordination'
    },
    { 
      name: 'Byte', 
      role: 'Code Assistant', 
      icon: '💻', 
      desc: 'Provides expert programming support with code review, debugging, and architecture design.',
      shortDesc: 'AI coding assistant for development and debugging'
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 border-t border-border">
      {agents.map((agent) => (
        <AgentCard key={agent.name} agent={agent} />
      ))}
      <CustomAgentCard />
    </div>
  );
};

export function AgentShowcaseSection() {
  return (
    <section
      id="agent-showcase"
      className="flex flex-col items-center justify-center w-full relative"
    >
      <div className="relative w-full px-6">
        <div className="max-w-6xl mx-auto border-l border-r">
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance pb-1">
              Build Your AI Team
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              Specialized AI Workers ready to transform your workflow. Choose from our curated team of experts.
            </p>
          </SectionHeader>

          <AgentGrid />
        </div>
      </div>
    </section>
  );
}