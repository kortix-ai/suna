'use client';

import { KATEX_RENDER_OPTIONS } from '@/components/markdown/katex-markdown';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useMemo } from 'react';

// KaTeX for ```latex / ```tex / ```katex fences (rehype-katex only handles ```math).
export function KaTeXBlock({ math }: { math: string }) {
  const rendered = useMemo(() => {
    try {
      const html = katex.renderToString(math.trim(), {
        ...KATEX_RENDER_OPTIONS,
        displayMode: true,
      });
      return { html, error: null as string | null };
    } catch {
      return { html: null as string | null, error: math.trim() };
    }
  }, [math]);

  if (!rendered.html) {
    return (
      <pre className="katex-math-block border-border bg-muted text-muted-foreground my-5 overflow-x-auto rounded-md border px-4 py-3 font-mono text-sm tracking-tight">
        {rendered.error}
      </pre>
    );
  }

  return (
    <div
      className="katex-math-block my-5 overflow-x-auto py-3 [&_.katex-display]:!mx-0 [&_.katex-display]:!my-0"
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
