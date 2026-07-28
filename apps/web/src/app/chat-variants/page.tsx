'use client';

/**
 * Session-chat variant demo — `/chat-variants`.
 *
 * Three explorations of the transcript rendered against ONE realistic
 * transcript, next to a faithful reproduction of what ships today. Same data,
 * same tool renderers, same design tokens — so the only difference on screen is
 * the design decision being compared.
 *
 * Internal tool. Not linked from anywhere in the product.
 */

import { Button } from '@/components/ui/button';
import { buildDemoMessages } from '@/features/session/activity/demo-transcript';
import { CHAT_VARIANTS } from '@/features/session/activity/variants';
import { VariantCurrent } from '@/features/session/activity/variants/variant-current';
import type { ChatVariantDefinition } from '@/features/session/activity/variants/types';
import { cn } from '@/lib/utils';
import { Columns2, Moon, Rows3, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useMemo, useState } from 'react';

const TODAY: ChatVariantDefinition = {
  id: 'current',
  name: 'Today',
  thesis: 'What ships right now — every tool call its own row, raw command visible at rest.',
  Component: VariantCurrent,
};

const ALL = [TODAY, ...CHAT_VARIANTS];

export default function ChatVariantsPage() {
  const messages = useMemo(() => buildDemoMessages(), []);
  const [layout, setLayout] = useState<'compare' | 'single'>('compare');
  const [activeId, setActiveId] = useState<string>(CHAT_VARIANTS[0].id);
  const { resolvedTheme, setTheme } = useTheme();
  // `resolvedTheme` is undefined during SSR, so painting an icon from it on the
  // first render is a guaranteed hydration mismatch. Render the icon only once
  // mounted; the button itself stays in the layout either way.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const shown = layout === 'compare' ? ALL : ALL.filter((v) => v.id === activeId);

  return (
    <div className="bg-background text-foreground min-h-dvh">
      <header className="bg-background/80 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-3 px-6 py-3">
          <div className="mr-auto">
            <h1 className="text-sm font-semibold">Session chat — variant explorations</h1>
            <p className="text-muted-foreground text-xs">
              One real transcript, four renderings. Everything is live: real tool renderers, real
              grouping model.
            </p>
          </div>

          <div className="bg-muted flex items-center gap-0.5 rounded-lg p-0.5">
            <Button
              variant={layout === 'compare' ? 'default' : 'ghost'}
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => setLayout('compare')}
            >
              <Columns2 className="size-3.5" /> Compare
            </Button>
            <Button
              variant={layout === 'single' ? 'default' : 'ghost'}
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => setLayout('single')}
            >
              <Rows3 className="size-3.5" /> Focus
            </Button>
          </div>

          {layout === 'single' && (
            <div className="bg-muted flex items-center gap-0.5 rounded-lg p-0.5">
              {ALL.map((v) => (
                <Button
                  key={v.id}
                  variant={activeId === v.id ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setActiveId(v.id)}
                >
                  {v.name}
                </Button>
              ))}
            </div>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Toggle theme"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          >
            {!mounted ? (
              <span className="size-4" />
            ) : resolvedTheme === 'dark' ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>
        </div>
      </header>

      <main
        className={cn(
          'mx-auto max-w-[1800px] gap-px p-6',
          layout === 'compare' ? 'grid grid-cols-1 xl:grid-cols-5' : 'flex justify-center',
        )}
      >
        {shown.map((variant) => (
          <section
            key={variant.id}
            className={cn(
              'flex min-w-0 flex-col',
              layout === 'single' && 'w-full max-w-[52rem]',
            )}
          >
            <div className="mb-4 px-4">
              <h2 className="text-sm font-semibold">{variant.name}</h2>
              <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                {variant.thesis}
              </p>
            </div>
            <div className="border-border/60 bg-card/30 min-h-[70dvh] rounded-xl border p-4">
              <variant.Component messages={messages} sessionId="demo-session" />
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
