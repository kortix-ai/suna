'use client';

import React from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { 
  ArrowRight, 
  ExternalLink,
  Clock,
  User,
  Calendar
} from 'lucide-react';

const contentSections = [
  {
    id: 'introduction',
    title: 'Introduction',
    description: 'Learn about Suna AI Worker and how it can transform your automation workflows',
    readTime: '5 min read',
    updated: '2 days ago'
  },
  {
    id: 'quick-start',
    title: 'Quick Start',
    description: 'Get up and running with your first AI agent in under 10 minutes',
    readTime: '8 min read',
    updated: '1 week ago'
  },
  {
    id: 'installation',
    title: 'Installation',
    description: 'Step-by-step guide to install and configure Suna in your environment',
    readTime: '12 min read',
    updated: '3 days ago'
  }
];

export const DocsContent = () => {
  return (
    <div className="flex-1 relative">
      <div className="h-full bg-background/40 backdrop-blur-sm">
        <ScrollArea className="h-screen">
          <div className="max-w-4xl mx-auto px-4 lg:px-8 py-6 lg:py-12">
            <div className="mb-12">
              <div className="flex items-center gap-3 mb-4">
                <Badge variant="secondary" className="bg-primary/10 text-primary backdrop-blur-sm">
                  Documentation
                </Badge>
                <Badge variant="outline" className="bg-muted/60 backdrop-blur-sm border-border/40">
                  Latest
                </Badge>
              </div>
              
              <h1 className="text-3xl lg:text-5xl font-bold mb-4 bg-gradient-to-r from-foreground to-foreground/60 bg-clip-text text-transparent">
                Welcome to Suna
              </h1>
              
              <p className="text-lg lg:text-xl text-muted-foreground leading-relaxed max-w-3xl">
                Build, deploy, and manage powerful AI agents that automate complex workflows. 
                Suna provides everything you need to create intelligent automation solutions.
              </p>
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4 mt-6">
                 <Button size="lg" className="w-full sm:w-auto backdrop-blur-sm">
                   Get Started
                   <ArrowRight className="ml-2 h-4 w-4" />
                 </Button>
                 <Button variant="outline" size="lg" className="w-full sm:w-auto bg-muted/60 backdrop-blur-sm border-border/40">
                   View on GitHub
                   <ExternalLink className="ml-2 h-4 w-4" />
                 </Button>
               </div>
            </div>

            <Separator className="mb-12 bg-border/40" />

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
              {contentSections.map((section) => (
                <Card key={section.id} className="group cursor-pointer transition-all duration-300 hover:scale-105 bg-card/70 backdrop-blur-xl border-border/40 hover:bg-card/80">
                  <CardHeader className="pb-4">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-lg group-hover:text-primary transition-colors">
                        {section.title}
                      </CardTitle>
                      <ArrowRight className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-primary" />
                    </div>
                    <CardDescription className="text-sm leading-relaxed">
                      {section.description}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {section.readTime}
                      </div>
                      <div className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {section.updated}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="space-y-16">
              <section id="introduction" className="scroll-mt-8">
                <div className="bg-card/60 backdrop-blur-xl rounded-2xl p-8 border border-border/40">
                  <h2 className="text-3xl font-bold mb-6">Introduction</h2>
                    <div className="space-y-4 text-muted-foreground">
                      <div className="h-4 bg-muted/60 rounded animate-pulse"></div>
                      <div className="h-4 bg-muted/60 rounded animate-pulse w-4/5"></div>
                      <div className="h-4 bg-muted/60 rounded animate-pulse w-3/5"></div>
                    </div>
                </div>
              </section>

              <section id="quick-start" className="scroll-mt-8">
                <div className="bg-card/60 backdrop-blur-xl rounded-2xl p-8 border border-border/40">
                  <h2 className="text-3xl font-bold mb-6">Quick Start</h2>
                    <div className="space-y-4 text-muted-foreground">
                      <div className="h-4 bg-muted/60 rounded animate-pulse"></div>
                      <div className="h-4 bg-muted/60 rounded animate-pulse w-5/6"></div>
                      <div className="h-4 bg-muted/60 rounded animate-pulse w-4/5"></div>
                      <div className="h-4 bg-muted/60 rounded animate-pulse w-2/3"></div>
                    </div>
                </div>
              </section>

              <section id="installation" className="scroll-mt-8">
                <div className="bg-card/60 backdrop-blur-xl rounded-2xl p-8 border border-border/40">
                  <h2 className="text-3xl font-bold mb-6">Installation</h2>
                    <div className="space-y-4 text-muted-foreground">
                      <div className="h-4 bg-muted/60 rounded animate-pulse"></div>
                      <div className="h-4 bg-muted/60 rounded animate-pulse w-3/4"></div>
                      <div className="h-4 bg-muted/60 rounded animate-pulse w-5/6"></div>
                    </div>
                </div>
              </section>
            </div>

            <div className="mt-16 pt-8 border-t border-border/40">
              <div className="text-center text-sm text-muted-foreground">
                <p>Need help? Join our community or reach out to support.</p>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}; 