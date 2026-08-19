'use client';

import dynamic from 'next/dynamic';

// Mermaid (~1MB with its deps) loads only when a docs page actually contains a
// ```mermaid fence — never in the shared docs bundle.
const MermaidRenderer = dynamic(
  () =>
    import('@/components/ui/mermaid-renderer').then(
      (mod) => mod.MermaidRenderer,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="border-border/40 bg-muted/30 text-muted-foreground my-5 rounded-md border p-6 text-center font-mono text-xs">
        Rendering diagram…
      </div>
    ),
  },
);

export function DocsMermaid({ chart }: { chart: string }) {
  return (
    <div className="my-5">
      <MermaidRenderer chart={chart} enableFullscreen />
    </div>
  );
}
