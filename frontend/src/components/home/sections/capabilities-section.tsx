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
    title: 'Create Professional Documents',
    description: 'Generate reports, proposals, contracts, and presentations that look like they came from a top agency. PDF, Word, PowerPoint - any format you need.',
    icon: <FileText className="size-6" />,
  },
  {
    title: 'Design Graphics & Visuals',
    description: 'Create logos, social media graphics, infographics, and custom images from just a text description. No design skills required.',
    icon: <Image className="size-6" />,
  },
  {
    title: 'Build Stunning Presentations',
    description: 'Turn your ideas into polished slide decks with professional layouts, charts, and images sourced automatically.',
    icon: <Presentation className="size-6" />,
  },
  {
    title: 'Research Anything Online',
    description: 'Get comprehensive research reports on competitors, markets, trends, or any topic with verified sources and current data.',
    icon: <Globe className="size-6" />,
  },
  {
    title: 'Analyze Your Data',
    description: 'Upload spreadsheets, sales data, or any files and get insights, trends, forecasts, and beautiful charts in minutes.',
    icon: <BarChart3 className="size-6" />,
  },
  {
    title: 'Automate Online Tasks',
    description: 'Fill out forms, collect data from websites, monitor prices, schedule posts, and handle repetitive web tasks while you sleep.',
    icon: <ShoppingCart className="size-6" />,
  },
  {
    title: 'Manage Your Workflows',
    description: 'Set up automated processes for lead generation, customer follow-ups, content creation, and daily business operations.',
    icon: <Users className="size-6" />,
  },
  {
    title: 'Work Around the Clock',
    description: 'Kortix never sleeps. Schedule tasks to run overnight, on weekends, or whenever you need work done without being there.',
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
              What Can Kortix Do For You?
            </h2>
            <p className="text-muted-foreground text-center text-balance font-medium">
              From content creation to data analysis, Kortix handles the work that takes you hours in just minutes.
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
