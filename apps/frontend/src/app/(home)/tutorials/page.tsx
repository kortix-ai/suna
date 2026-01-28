'use client';

import { motion } from 'framer-motion';
import { SimpleFooter } from '@/components/home/simple-footer';
import { BookOpen, Play, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

// Tutorial data structure - easy to add more tutorials
interface Tutorial {
  id: string;
  title: string;
  description: string;
  duration?: string;
  embedCode: string;
}

const tutorials: Tutorial[] = [
  {
    id: 'explore-templates-ai-modes',
    title: 'Explore Templates and AI-Powered Content Generation Modes',
    description: 'Learn how to explore and use templates, and discover the different AI-powered content generation modes available to supercharge your workflow.',
    duration: '3 min',
    embedCode: `<div style="position: relative; padding-bottom: calc(57.3684% + 41px); height: 0px; width: 100%;"><iframe src="https://demo.arcade.software/iG83WENBBNvLFbzIf8kE?embed&embed_mobile=tab&embed_desktop=inline&show_copy_link=true" title="Explore Templates and AI-Powered Content Generation Modes" frameborder="0" loading="lazy" webkitallowfullscreen mozallowfullscreen allowfullscreen allow="clipboard-write" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; color-scheme: light;" ></iframe></div>`,
  },
  // Add more tutorials here as needed
];

function TableOfContents({ 
  tutorials, 
  activeId 
}: { 
  tutorials: Tutorial[]; 
  activeId: string;
}) {
  return (
    <nav className="space-y-1">
      <h3 className="text-sm font-semibold text-foreground mb-4 uppercase tracking-wider">
        On this page
      </h3>
      {tutorials.map((tutorial) => (
        <a
          key={tutorial.id}
          href={`#${tutorial.id}`}
          className={cn(
            "block py-2 px-3 text-sm rounded-lg transition-colors",
            activeId === tutorial.id
              ? "bg-primary/10 text-primary font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
          )}
        >
          {tutorial.title}
        </a>
      ))}
    </nav>
  );
}

function TutorialCard({ tutorial, index }: { tutorial: Tutorial; index: number }) {
  const [isActive, setIsActive] = useState(false);

  return (
    <motion.section
      id={tutorial.id}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      className="scroll-mt-32"
    >
      <div className="space-y-6">
        {/* Tutorial header */}
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Play className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              {tutorial.duration && (
                <span className="text-xs font-medium text-muted-foreground bg-accent/50 px-2 py-1 rounded-full">
                  {tutorial.duration}
                </span>
              )}
            </div>
            <h2 className="text-xl md:text-2xl font-semibold tracking-tight text-foreground">
              {tutorial.title}
            </h2>
            <p className="mt-2 text-muted-foreground leading-relaxed">
              {tutorial.description}
            </p>
          </div>
        </div>

        {/* Embed container with click-to-activate overlay */}
        <div 
          className="relative rounded-xl overflow-hidden border border-border bg-accent/20"
          onMouseLeave={() => setIsActive(false)}
        >
          <div 
            dangerouslySetInnerHTML={{ __html: tutorial.embedCode }}
            className={cn(
              "transition-opacity",
              !isActive && "pointer-events-none"
            )}
          />
          {/* Overlay to capture scroll events until clicked */}
          {!isActive && (
            <div 
              className="absolute inset-0 cursor-pointer flex items-center justify-center bg-transparent hover:bg-black/5 transition-colors"
              onClick={() => setIsActive(true)}
            >
              <div className="bg-background/90 backdrop-blur-sm px-4 py-2 rounded-full border border-border shadow-sm flex items-center gap-2">
                <Play className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-foreground">Click to interact</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.section>
  );
}

export default function TutorialsPage() {
  const [activeId, setActiveId] = useState(tutorials[0]?.id || '');

  // Track active section based on scroll position
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      {
        rootMargin: '-20% 0px -60% 0px',
        threshold: 0,
      }
    );

    tutorials.forEach((tutorial) => {
      const element = document.getElementById(tutorial.id);
      if (element) {
        observer.observe(element);
      }
    });

    return () => observer.disconnect();
  }, []);

  return (
    <main className="min-h-screen bg-background">
      {/* Hero Section */}
      <div className="border-b border-border">
        <div className="max-w-7xl mx-auto px-6 md:px-10 pt-28 md:pt-32 pb-12">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="max-w-3xl"
          >
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <BookOpen className="w-6 h-6 text-primary" />
              </div>
              <span className="text-sm font-medium text-muted-foreground">
                Learn Kortix
              </span>
            </div>
            <h1 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-foreground mb-4">
              Tutorials
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed">
              Step-by-step interactive tutorials to help you get the most out of Kortix. 
              From getting started to advanced workflows, master every feature.
            </p>
          </motion.div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 md:px-10 py-12 md:py-16">
        <div className="flex gap-12 lg:gap-16">
          {/* Tutorials List */}
          <div className="flex-1 min-w-0 space-y-16">
            {tutorials.map((tutorial, index) => (
              <TutorialCard key={tutorial.id} tutorial={tutorial} index={index} />
            ))}

            {/* Coming Soon Section */}
            {tutorials.length === 1 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="border border-dashed border-border rounded-xl p-8 text-center"
              >
                <div className="w-12 h-12 rounded-xl bg-accent/50 flex items-center justify-center mx-auto mb-4">
                  <Play className="w-6 h-6 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-medium text-foreground mb-2">
                  More tutorials coming soon
                </h3>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  We're working on more tutorials to help you master Kortix. 
                  Check back soon for new content.
                </p>
              </motion.div>
            )}
          </div>

          {/* Table of Contents - Desktop only */}
          <aside className="hidden lg:block w-64 flex-shrink-0">
            <div className="sticky top-32">
              <TableOfContents tutorials={tutorials} activeId={activeId} />
              
              {/* Quick Links */}
              <div className="mt-8 pt-8 border-t border-border">
                <h3 className="text-sm font-semibold text-foreground mb-4 uppercase tracking-wider">
                  Resources
                </h3>
                <div className="space-y-2">
                  <a
                    href="/support"
                    className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
                  >
                    <ChevronRight className="w-4 h-4" />
                    Support
                  </a>
                  <a
                    href="mailto:support@kortix.com"
                    className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
                  >
                    <ChevronRight className="w-4 h-4" />
                    Contact us
                  </a>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>

      <SimpleFooter />
    </main>
  );
}
