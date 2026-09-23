'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { DocMarkdown } from '@/components/markdown/doc-markdown';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { CaretRightIcon } from '@phosphor-icons/react';

/**
 * /debug/markdown-links
 *
 * Visual harness for the markdown action-link renderer (see
 * `src/components/markdown/markdown-link.tsx` and `markdown-action-link.ts`)
 * across `UnifiedMarkdown` and `DocMarkdown`, in light and dark — connect
 * cards, setup-link cards, internal/external chips, and the inline-link
 * fallback. The layout's `DebugThemeToggle` switches theme.
 *
 * Not linked from anywhere — just hit /debug/markdown-links.
 */

type Renderer = 'unified' | 'doc' | 'both';

const STREAM_CHARS_PER_TICK = 24;
const STREAM_TICK_MS = 30;

const TRANSCRIPT = `Shopify is now a connector on this project.

## → [Connect Shopify](https://connect.composio.dev/link/lk_debug_000)

That's your personal account. If you want it shared, I'll mint a \`--owner project\` link instead.`;

interface Fixture {
  id: string;
  label: string;
  hint: string;
  markdown: string;
  /** Render at these fixed pixel widths instead of the row's natural width — proves truncation. */
  widths?: number[];
}

const FIXTURES: Fixture[] = [
  {
    id: 'reported-case',
    label: 'Reported case',
    hint: 'A synthetic transcript: prose, then a heading that is only a connect link renders the setup-link card, then prose resumes.',
    markdown: TRANSCRIPT,
  },
  {
    id: 'minted-setup-link',
    label: 'Minted setup link',
    hint: 'Two mint tokens, each its own paragraph — clicking opens the setup modal, which reports the token invalid (expected: the token is synthetic).',
    markdown:
      '[Connect Gmail](/connect/ksl_debug_token)\n\n[Add the Stripe key](/secret-intake/ksl_debug_secret)',
  },
  {
    id: 'verb-only-connect',
    label: 'Verb-only connect',
    hint: 'A host outside the known connect list still classifies as a connect action, from the label\'s leading verb ("Authorize").',
    markdown: '→ [Authorize Linear](https://auth.example.com/oauth/authorize?client_id=debug)',
  },
  {
    id: 'internal-resources',
    label: 'Internal resources',
    hint: 'Five internal routes, one paragraph — each renders as its own outline chip (files, settings, connectors, search, arrow icon), wrapping in one row.',
    markdown: [
      '→ [Open files](/projects/debug/files)',
      '→ [Project settings](/projects/debug/settings)',
      '→ [Connectors](/projects/debug/connectors)',
      '→ [Search sessions](/search?q=debug)',
      '→ [Back to project](/projects/debug)',
      // Consecutive lines with no blank line between them form ONE paragraph,
      // with a soft break or a hard break. This backslash hard break adds a
      // `br` between the links; the scanner skips it, so the five links still
      // resolve as one action block.
    ].join('\\\n'),
  },
  {
    id: 'external-resources',
    label: 'External resources',
    hint: 'Two external hosts, each its own paragraph — each chip carries a trailing arrow and a Hint that reveals the destination host.',
    markdown:
      '[Read the Composio docs](https://docs.composio.dev)\n\n[Search the docs](https://docs.example.com/search?q=connect)',
  },
  {
    id: 'inline-links-stay-inline',
    label: 'Inline links stay inline',
    hint: 'Prose mixed with links never qualifies as an action block — only a block that is links alone does. Both links, including the internal one, stay inline blue text.',
    markdown:
      'Read [the guide](https://docs.example.com/guide) or open [files](/projects/debug/files) before continuing.',
  },
  {
    id: 'bare-url',
    label: 'Bare URL stays a link',
    hint: 'Autolinked, then rejected as an action because its label is its own href (isBareUrlLabel) — renders as a plain inline link.',
    markdown: 'https://docs.example.com/guide',
  },
  {
    id: 'hash-link',
    label: 'Hash link',
    hint: 'A hash-only href is never a valid action href — falls back to the inline link, and its default click still scrolls to the target.',
    markdown: '[Jump to top](#top)',
  },
  {
    id: 'bold-and-heading',
    label: 'Bold and heading variants',
    hint: 'A link wrapped in bold, and a link as an entire heading, both still resolve to one nested link and render as an action — same as a bare paragraph.',
    markdown:
      '**[Connect Notion](https://connect.composio.dev/link/lk_debug_001)**\n\n### [Open files](/projects/debug/files)',
  },
  {
    id: 'long-label',
    label: 'Long label',
    hint: 'The label truncates inside the card/chip at both widths below — the control itself never grows past its container.',
    markdown:
      '[Connect the company-wide shared Google Workspace account used by the whole finance team](https://connect.composio.dev/link/lk_debug_002)',
    widths: [640, 320],
  },
];

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-muted-foreground font-mono text-xs">{label}</p>
        {hint ? <p className="text-muted-foreground/60 text-xs">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

function RenderedFixture({
  renderer,
  content,
  isStreaming = false,
}: {
  renderer: Renderer;
  content: string;
  isStreaming?: boolean;
}) {
  if (renderer === 'both') {
    return (
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <p className="text-muted-foreground/60 text-xs">UnifiedMarkdown</p>
          <UnifiedMarkdown content={content} isStreaming={isStreaming} actionLinks />
        </div>
        <div className="space-y-2">
          <p className="text-muted-foreground/60 text-xs">DocMarkdown</p>
          <DocMarkdown content={content} isStreaming={isStreaming} actionLinks />
        </div>
      </div>
    );
  }
  if (renderer === 'doc') {
    return <DocMarkdown content={content} isStreaming={isStreaming} actionLinks />;
  }
  return <UnifiedMarkdown content={content} isStreaming={isStreaming} actionLinks />;
}

/**
 * Pins the render to an exact pixel width to prove truncation. The width is a
 * test parameter (640px / 320px; 640 fits inside the page's 672px `max-w-2xl`
 * column), not a design token — an inline style, so it never reads as a value
 * pulled from the spacing/radius allowlists.
 */
function WidthBox({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-muted-foreground/60 text-xs">{width}px</p>
      <div
        className="border-border max-w-full overflow-hidden rounded-none border border-dashed p-3"
        style={{ width }}
      >
        {children}
      </div>
    </div>
  );
}

function SourceDisclosure({ markdown }: { markdown: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Disclosure open={open} onOpenChange={setOpen} className="space-y-1">
      <DisclosureTrigger>
        <div className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 text-xs transition-colors">
          <CaretRightIcon
            aria-hidden
            className={cn(
              'size-3 shrink-0 transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
          {open ? 'Hide markdown source' : 'Show markdown source'}
        </div>
      </DisclosureTrigger>
      <DisclosureContent>
        <pre className="bg-muted/20 text-muted-foreground/80 mt-1 max-h-64 overflow-auto rounded-sm px-3 py-2 font-mono text-xs wrap-break-word whitespace-pre-wrap">
          {markdown}
        </pre>
      </DisclosureContent>
    </Disclosure>
  );
}

export default function DebugMarkdownLinksPage() {
  const [renderer, setRenderer] = useState<Renderer>('unified');
  const [streamContent, setStreamContent] = useState(TRANSCRIPT);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearStreamInterval = useCallback(() => {
    if (streamIntervalRef.current !== null) {
      clearInterval(streamIntervalRef.current);
      streamIntervalRef.current = null;
    }
  }, []);

  // Clear on unmount — a re-click clears through the same function, see handleStream.
  useEffect(() => clearStreamInterval, [clearStreamInterval]);

  const handleStream = useCallback(() => {
    clearStreamInterval();
    setIsStreaming(true);
    setStreamContent('');
    let index = 0;
    streamIntervalRef.current = setInterval(() => {
      index = Math.min(index + STREAM_CHARS_PER_TICK, TRANSCRIPT.length);
      setStreamContent(TRANSCRIPT.slice(0, index));
      if (index >= TRANSCRIPT.length) {
        clearStreamInterval();
        setIsStreaming(false);
      }
    }, STREAM_TICK_MS);
  }, [clearStreamInterval]);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-10 px-4 py-10">
      <header className="space-y-1">
        <h1 className="text-foreground text-xl font-medium">Markdown action links</h1>
        <p className="text-muted-foreground text-sm">
          Connect cards, setup-link cards, internal/external chips, and inline fallbacks — across
          UnifiedMarkdown and DocMarkdown.
        </p>
      </header>

      <section className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={renderer} onValueChange={(value) => setRenderer(value as Renderer)}>
            <TabsListCompact>
              <TabsTriggerCompact value="unified">UnifiedMarkdown</TabsTriggerCompact>
              <TabsTriggerCompact value="doc">DocMarkdown</TabsTriggerCompact>
              <TabsTriggerCompact value="both">Both side by side</TabsTriggerCompact>
            </TabsListCompact>
          </Tabs>
          <Button variant="outline" size="sm" onClick={handleStream}>
            {isStreaming ? 'Streaming…' : 'Stream'}
          </Button>
        </div>

        <Row
          label="Streaming replay"
          hint="Replays the reported-case transcript through UnifiedMarkdown with isStreaming true, ~24 chars every 30ms. While the connect link is still arriving it shows as a disabled chip, then becomes the connect card."
        >
          <UnifiedMarkdown content={streamContent} isStreaming={isStreaming} actionLinks />
          <SourceDisclosure markdown={TRANSCRIPT} />
        </Row>
      </section>

      <section className="space-y-5">
        {FIXTURES.map((fixture) => (
          <Row key={fixture.id} label={fixture.label} hint={fixture.hint}>
            {fixture.widths ? (
              <div className="space-y-4">
                {fixture.widths.map((width) => (
                  <WidthBox key={width} width={width}>
                    <RenderedFixture renderer={renderer} content={fixture.markdown} />
                  </WidthBox>
                ))}
              </div>
            ) : (
              <RenderedFixture renderer={renderer} content={fixture.markdown} />
            )}
            <SourceDisclosure markdown={fixture.markdown} />
          </Row>
        ))}
      </section>
    </div>
  );
}
