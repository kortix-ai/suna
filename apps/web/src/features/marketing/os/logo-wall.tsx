'use client';

import { Github } from '@/features/icon/icons/github';
import { Gmail } from '@/features/icon/icons/gmail';
import { Linear } from '@/features/icon/icons/linear';
import { MicrosoftTeams } from '@/features/icon/icons/microsoft-teams';
import { Notion } from '@/features/icon/icons/notion';
import { Slack } from '@/features/icon/icons/slack';
import { cn } from '@/lib/utils';
import { useReducedMotion } from 'motion/react';
import { type ComponentType, useEffect, useState } from 'react';
import { useOsContent } from './use-os-content';
import { Section } from './primitives';

/**
 * Models Kortix runs and apps it connects. Capabilities, never customers: the
 * claims file forbids customer logos. Model marks are the monochrome
 * `public/provider-icons` set, drawn through a CSS mask so they take
 * `currentColor` in both themes. App marks are connector-catalog apps only.
 */
type Logo = { name: string; src?: string; Glyph?: ComponentType<{ className?: string }> };

const MODELS = [
  'anthropic', 'openai', 'google', 'mistral', 'deepseek', 'xai', 'moonshotai', 'groq', 'cohere',
  'llama', 'perplexity', 'nvidia', 'huggingface', 'openrouter', 'amazon-bedrock', 'azure',
  'togetherai', 'fireworks-ai', 'cerebras', 'opencode',
].map((id): Logo => ({ name: id, src: `/provider-icons/${id}.svg` }));

const APPS: Logo[] = [
  { name: 'Slack', Glyph: Slack },
  { name: 'Microsoft Teams', Glyph: MicrosoftTeams },
  { name: 'GitHub', Glyph: Github },
  { name: 'Notion', Glyph: Notion },
  { name: 'Linear', Glyph: Linear },
  { name: 'Gmail', Glyph: Gmail },
];

/** Interleave apps into the models so every swap can land on either kind. */
const POOL: Logo[] = MODELS.flatMap((m, i) => (i % 4 === 0 && APPS[i / 4] ? [m, APPS[i / 4]] : [m]));
const CELLS = 18;
const SWAP_MS = 900;

function Mark({ logo }: { logo: Logo }) {
  if (logo.Glyph) return <logo.Glyph className="size-7 grayscale" />;
  return (
    <span
      role="img"
      aria-label={logo.name}
      className="block size-8 bg-current"
      style={{ mask: `url(${logo.src}) center / contain no-repeat` }}
    />
  );
}

export function LogoWall() {
  const { logoWall } = useOsContent();
  const reduceMotion = useReducedMotion();
  // `shown[i]` is the pool index in cell i. A tick moves one cell to the next
  // pool logo that no cell shows, so the wall never repeats a mark.
  const [shown, setShown] = useState<number[]>(() => Array.from({ length: CELLS }, (_, i) => i));

  useEffect(() => {
    if (reduceMotion) return;
    let tick = 0;
    let cursor = CELLS;
    const id = window.setInterval(() => {
      const cell = (tick * 7) % CELLS; // 7 is coprime with 18: every cell, scattered
      tick += 1;
      setShown((prev) => {
        while (prev.includes(cursor % POOL.length)) cursor += 1;
        const next = [...prev];
        next[cell] = cursor % POOL.length;
        cursor += 1;
        return next;
      });
    }, SWAP_MS);
    return () => window.clearInterval(id);
  }, [reduceMotion]);

  return (
    <Section className="py-20 md:py-24">
      <h2 className="text-foreground text-center text-xl font-normal tracking-tight sm:text-2xl">
        {logoWall.title}
      </h2>
      <ul className="mt-10 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {shown.map((poolIndex, i) => {
          const logo = POOL[poolIndex];
          return (
            <li
              key={i}
              className={cn(
                'bg-muted/40 text-muted-foreground flex h-20 items-center justify-center rounded-md',
                i >= 12 && 'max-sm:hidden',
              )}
            >
              <span key={logo.name} className="block animate-[kx-fade_500ms_ease-out_both]">
                <Mark logo={logo} />
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
