'use client';

import { SectionHeader } from '@/components/home/section-header';
import { motion, useInView } from 'motion/react';
import { useRef } from 'react';
import { 
  FileText,
  Image,
  Presentation,
  Globe,
  BarChart3,
  ShoppingCart,
  Users,
  Clock 
} from 'lucide-react';

const capabilities = [
  {
    title: 'Automate Campaign Workflows',
    description: 'Set up multi-channel marketing campaigns that run automatically across email, social media, and advertising platforms with intelligent optimization.',
    icon: <FileText className="size-6" />,
  },
  {
    title: 'Generate Marketing Content',
    description: 'Create compelling copy, social media posts, email campaigns, and landing pages that convert. AI-powered content that matches your brand voice.',
    icon: <Image className="size-6" />,
  },
  {
    title: 'Build Performance Dashboards',
    description: 'Transform your marketing data into actionable insights with real-time dashboards, automated reports, and predictive analytics.',
    icon: <Presentation className="size-6" />,
  },
  {
    title: 'Research Competitors & Markets',
    description: 'Get comprehensive competitive intelligence, market analysis, and trend reports to stay ahead of the competition.',
    icon: <Globe className="size-6" />,
  },
  {
    title: 'Analyze Marketing Data',
    description: 'Turn campaign performance data into actionable insights with automated analysis, attribution modeling, and ROI optimization.',
    icon: <BarChart3 className="size-6" />,
  },
  {
    title: 'Manage Multi-Channel Campaigns',
    description: 'Coordinate campaigns across email, social media, paid advertising, and content marketing with unified automation and tracking.',
    icon: <ShoppingCart className="size-6" />,
  },
  {
    title: 'Optimize Marketing Operations',
    description: 'Streamline your marketing processes with automated lead scoring, nurturing sequences, and performance optimization.',
    icon: <Users className="size-6" />,
  },
  {
    title: 'Scale Team Productivity',
    description: 'Multiply your marketing team\'s output with AI-powered automation that works 24/7, handling routine tasks while your team focuses on strategy.',
    icon: <Clock className="size-6" />,
  },
];

export function CapabilitiesSection() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-10%" });

  return (
    <section
      id="capabilities"
      className="flex flex-col items-center justify-center w-full relative"
      ref={ref}
    >
      <div className="relative w-full px-6">
        <div className="max-w-6xl mx-auto border-l border-r border-border">
          <SectionHeader>
            <h2 className="text-3xl md:text-4xl font-medium tracking-tighter text-center text-balance pb-1">
              What Can Adentic Do For You?
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              From content creation to data analysis, Adentic handles the work that takes you hours in just minutes.
            </p>
          </SectionHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 border-t border-border">
            {capabilities.map((capability, index) => (
              <motion.div
                key={capability.title}
                initial={{ opacity: 0, y: 20 }}
                animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
                transition={{
                  duration: 0.5,
                  delay: index * 0.1,
                  ease: 'easeOut',
                }}
                className="relative p-6 border-border group hover:bg-accent/5 transition-colors duration-300 [&:not(:nth-child(4n))]:border-r [&:not(:nth-last-child(-n+4))]:border-b"
              >
                {/* Icon */}
                <div className="flex items-center justify-center size-12 bg-secondary/10 rounded-xl mb-4 group-hover:bg-secondary/20 transition-colors duration-300">
                  <div className="text-secondary">
                    {capability.icon}
                  </div>
                </div>

                {/* Content */}
                <div className="space-y-2">
                  <h3 className="text-lg font-semibold tracking-tight">
                    {capability.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {capability.description}
                  </p>
                </div>

              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
