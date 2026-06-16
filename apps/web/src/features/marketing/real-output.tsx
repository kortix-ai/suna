'use client';

import { Reveal } from '@/components/home/reveal';
import { AppWindow, BarChart3, Code2, FileText } from 'lucide-react';
import { REAL_OUTPUT } from './narrative';

const ICONS = [FileText, BarChart3, AppWindow, Code2];

function Mock({ i }: { i: number }) {
  // 0 = PDF/report, 1 = dashboard, 2 = web app, 3 = code/PR
  if (i === 0) {
    return (
      <div className="space-y-1.5">
        <div className="bg-foreground/70 h-2 w-2/5 rounded-sm" />
        <div className="bg-foreground/12 h-1.5 w-full rounded-sm" />
        <div className="bg-foreground/12 h-1.5 w-11/12 rounded-sm" />
        <div className="bg-foreground/12 h-1.5 w-3/4 rounded-sm" />
        <div className="bg-foreground/12 h-1.5 w-5/6 rounded-sm" />
      </div>
    );
  }
  if (i === 1) {
    return (
      <div className="flex h-full items-end gap-1.5">
        {[50, 80, 40, 95, 60, 78].map((h, k) => (
          <span key={k} className="bg-kortix-green/70 w-full rounded-sm" style={{ height: `${h}%` }} />
        ))}
      </div>
    );
  }
  if (i === 2) {
    return (
      <div className="border-border/60 flex h-full flex-col overflow-hidden rounded-md border">
        <div className="border-border/60 flex items-center gap-1 border-b px-2 py-1.5">
          <span className="bg-kortix-red/60 size-1.5 rounded-full" />
          <span className="bg-kortix-yellow/60 size-1.5 rounded-full" />
          <span className="bg-kortix-green/60 size-1.5 rounded-full" />
        </div>
        <div className="grid flex-1 grid-cols-3 gap-1 p-2">
          <div className="bg-foreground/10 rounded-sm" />
          <div className="bg-foreground/10 rounded-sm" />
          <div className="bg-foreground/10 rounded-sm" />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5 font-mono">
      <div className="flex items-center gap-1.5">
        <span className="text-kortix-green text-[10px]">+</span>
        <span className="bg-kortix-green/40 h-1.5 w-2/3 rounded-sm" />
      </div>
      <div className="bg-foreground/12 ml-3.5 h-1.5 w-1/2 rounded-sm" />
      <div className="bg-foreground/12 ml-3.5 h-1.5 w-4/5 rounded-sm" />
      <div className="flex items-center gap-1.5">
        <span className="text-kortix-green text-[10px]">+</span>
        <span className="bg-kortix-green/40 h-1.5 w-1/3 rounded-sm" />
      </div>
    </div>
  );
}

export function RealOutput() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
      <div className="mb-12 max-w-2xl space-y-3">
        <p className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
          {REAL_OUTPUT.eyebrow}
        </p>
        <h2 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl">
          {REAL_OUTPUT.title}
        </h2>
        <p className="text-muted-foreground text-base leading-relaxed">{REAL_OUTPUT.description}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {REAL_OUTPUT.tiles.map((tile, i) => {
          const Icon = ICONS[i % ICONS.length];
          return (
            <Reveal key={tile.label} delay={i * 0.08}>
              <div className="border-border bg-card flex h-full flex-col rounded-sm border p-5">
                <div className="flex items-center gap-3">
                  <span className="border-border bg-background text-foreground flex size-9 items-center justify-center rounded-lg border">
                    <Icon className="size-4" />
                  </span>
                  <div>
                    <div className="text-foreground text-sm font-semibold">{tile.label}</div>
                  </div>
                </div>
                <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">{tile.sub}</p>
                <div className="border-border/60 bg-background/50 mt-4 h-20 rounded-md border p-2.5">
                  <Mock i={i} />
                </div>
              </div>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}
