'use client';

import { Icon } from '@/features/icon/icon';
import Image from 'next/image';
import type { ReactNode } from 'react';

type IconKey = keyof typeof Icon;

/** Models Kortix can run, and a sample of the tools it connects to. These are
 *  capabilities we actually ship — not customer logos, which we neither name
 *  nor have permission to show. OpenCode is the agent harness, not a model, so
 *  it does not belong in this row. */
const MODELS: IconKey[] = ['Claude', 'OpenAI', 'Gemini'];
const TOOLS: IconKey[] = ['Slack', 'MicrosoftTeams', 'Notion', 'Linear', 'Github', 'Gmail'];

function Row({ label, keys, extra }: { label: string; keys: IconKey[]; extra?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
      <span className="text-muted-foreground/60 shrink-0 font-mono text-[10px] tracking-widest uppercase">
        {label}
      </span>
      <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-4">
        {keys.map((key) => {
          const Glyph = Icon[key] as ((p: { className?: string }) => ReactNode) | undefined;
          if (!Glyph) return null;
          return (
            <span key={key}>
              <Glyph className="size-6" />
            </span>
          );
        })}
        {extra}
      </div>
    </div>
  );
}

/** The transition between the hero and the first real section. */
export function LogoStrip() {
  return (
    <section aria-label="Models and tools Kortix works with" className="py-14 sm:py-16">
      <div className="mx-auto flex max-w-7xl flex-col px-6 items-center gap-8 lg:flex-row lg:justify-between">
        <Row
          label="Runs any model"
          keys={MODELS}
          extra={
            // No vector mark ships for OpenRouter in features/icon, so its own
            // brand icon is served locally rather than hotlinked.
            <Image
              src="/media/brands/openrouter.png"
              alt="OpenRouter"
              width={24}
              height={24}
              className="size-6 object-contain"
            />
          }
        />
        <Row label="3,000+ apps, any MCP or API" keys={TOOLS} />
      </div>
    </section>
  );
}
