'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SURFACES, SurfacePanel, type SurfaceId } from '@/features/marketing/hero-surfaces';
import { useEffect, useState } from 'react';
import { HeroActions } from './actions';
import './prototype.css';

/** One composition: Rightfit's split introduction and top-tabbed product frame. */
export default function HeroA() {
  const [surface, setSurface] = useState<SurfaceId>('web');

  useEffect(() => {
    const selectHash = () => {
      const match = SURFACES.find(({ id }) => `#${id}` === window.location.hash);
      if (match) setSurface(match.id);
    };
    selectHash();
    window.addEventListener('hashchange', selectHash);
    return () => window.removeEventListener('hashchange', selectHash);
  }, []);

  return (
    <section id="hero" className="rightfit-hero bg-background text-foreground border-b">
      <div className="rightfit-container">
        <div className="rightfit-intro">
          <h1 className="rightfit-title font-medium tracking-tight">
            The open-source AI
            <br className="hidden lg:block" /> workspace for your team.
          </h1>
          <div className="rightfit-description">
            <p className="text-muted-foreground text-lg leading-relaxed">
              Give your agents the tools and context to get work done. From wherever you work.
            </p>
            <HeroActions />
          </div>
        </div>

        <Tabs
          value={surface}
          onValueChange={(value) => setSurface(value as SurfaceId)}
          className="rightfit-showcase gap-0 overflow-hidden rounded-md border"
        >
          <div className="rightfit-tab-bar bg-background overflow-x-auto px-4 py-3">
            <TabsList
              animate="none"
              aria-label="Explore Kortix surfaces"
              className="h-auto justify-start bg-transparent"
            >
              {SURFACES.map(({ id, label, icon: Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="h-12 flex-none rounded-sm px-4 transition-none lg:h-8"
                >
                  <Icon className="size-3.5" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {SURFACES.map(({ id }) => (
            <TabsContent key={id} value={id} className="rightfit-media mt-0">
              <div
                className="rightfit-screen bg-background border-foreground/30 overflow-hidden rounded-sm border-4"
                data-surface={id}
              >
                <SurfacePanel surface={id} />
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </section>
  );
}
