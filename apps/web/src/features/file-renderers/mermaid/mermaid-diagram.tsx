'use client';

/**
 * `MermaidDiagram` — a `.mmd` / `.mermaid` file, rendered.
 *
 * One component for every surface that previews a diagram file: the Files
 * viewer (`FileContentRenderer`), the session panel (`FileViewer`) and the
 * `show` tool card. The markdown code-block renderer (`MermaidRenderer`) stays
 * separate: it is an inline card in prose, not a pane.
 *
 * The rendered SVG is shown through `ImageRenderer` as a `blob:` image:
 *
 *   - fit-to-pane, zoom and pan come from the viewer every other image uses;
 *   - an `<img>` is inert — no script, no event handler, no external fetch runs
 *     from file content, on top of Mermaid's own `securityLevel: 'strict'`.
 */

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { ImageRenderer } from '@/features/file-renderers/image-renderer';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import {
  CheckIcon as Check,
  CodeSimpleIcon as Code,
  CopyIcon as Copy,
  TreeStructureIcon as Diagram,
  DownloadSimpleIcon as Download,
  WarningIcon as Warning,
} from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type MermaidParseError,
  mermaidSvgFileName,
  toMermaidParseError,
  withIntrinsicSize,
  withViewerTheme,
} from './mermaid-utils';

type MermaidModule = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidModule> | null = null;

/**
 * Lazy-load Mermaid once per page. It is ~1 MB and only diagram files need it.
 * The markdown renderer imports the same module, so both share one instance.
 */
function loadMermaid(): Promise<MermaidModule> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    // `strict` is Mermaid's default. Assert it rather than trust it: a
    // directive in the file cannot change it (it is a secure key), but another
    // caller's `initialize()` could.
    if (mermaid.mermaidAPI.getSiteConfig().securityLevel !== 'strict') {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    }
    return mermaid;
  });
  return mermaidPromise;
}

let renderSeq = 0;

type RenderState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; error: MermaidParseError };

/** Edits in Source mode arrive per keystroke; render once typing settles. */
const RENDER_DEBOUNCE_MS = 200;

function useMermaidSvg(source: string, dark: boolean): RenderState {
  const empty = source.trim() === '';
  const [state, setState] = useState<RenderState>(
    empty ? { status: 'empty' } : { status: 'loading' },
  );
  // The first render of a diagram runs immediately; only a CHANGE waits.
  const renderedOnce = useRef(false);

  useEffect(() => {
    if (empty) {
      setState({ status: 'empty' });
      return;
    }
    let cancelled = false;
    const run = async () => {
      const mermaid = await loadMermaid();
      if (cancelled) return;
      // Parse the untouched source first, so an error's line number is the
      // line number in the file.
      try {
        await mermaid.parse(source);
      } catch (err) {
        if (!cancelled) setState({ status: 'error', error: toMermaidParseError(err) });
        return;
      }
      const id = `kortix-mermaid-${++renderSeq}`;
      try {
        const { svg } = await mermaid.render(id, withViewerTheme(source, dark));
        if (!cancelled) setState({ status: 'ready', svg: withIntrinsicSize(svg) });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', error: toMermaidParseError(err) });
      } finally {
        // Mermaid renders into a temporary node on <body>. It removes it on
        // success; a failed render can leave it behind.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      }
    };
    const delay = renderedOnce.current ? RENDER_DEBOUNCE_MS : 0;
    renderedOnce.current = true;
    const timer = setTimeout(run, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, dark, empty]);

  return state;
}

/** SVG text → a `blob:` URL an `<img>` can load. Revoked on change/unmount. */
function useSvgUrl(svg: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!svg) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [svg]);
  return url;
}

export interface MermaidDiagramProps {
  /** The diagram source — the file's text. */
  source: string;
  /** The file name, e.g. `flow.mmd`. Names the SVG download. */
  fileName: string;
  /** Switch the host to its Source view. Offered from the error state. */
  onShowSource?: () => void;
  className?: string;
}

export function MermaidDiagram({ source, fileName, onShowSource, className }: MermaidDiagramProps) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const { resolvedTheme } = useTheme();
  const state = useMermaidSvg(source, resolvedTheme === 'dark');
  const svg = state.status === 'ready' ? state.svg : null;
  const url = useSvgUrl(svg);
  const svgName = mermaidSvgFileName(fileName);

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (copiedTimer.current && clearTimeout(copiedTimer.current)), []);

  const copySource = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied — the button simply does not confirm.
    }
  }, [source]);

  const downloadSvg = useCallback(() => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = svgName;
    a.click();
  }, [url, svgName]);

  if (state.status === 'empty') {
    return (
      <Centered className={className}>
        <Diagram className="text-muted-foreground/60 size-5" />
        <span>{t.raw('textde340d411411')}</span>
      </Centered>
    );
  }

  if (state.status === 'error') {
    const { message, line } = state.error;
    return (
      <Centered className={className} role="alert">
        <Warning className="text-muted-foreground/60 size-5" />
        <span className="text-foreground font-medium">{t.raw('textc53147a0d05b')}</span>
        {line !== null && (
          <span className="text-muted-foreground text-xs tabular-nums">
            {t('text751dfdcf3878', { value0: line })}
          </span>
        )}
        <pre className="bg-muted/50 text-muted-foreground max-h-48 w-full max-w-lg overflow-auto rounded-md p-3 text-left font-mono text-xs whitespace-pre-wrap">
          {message}
        </pre>
        {onShowSource && (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onShowSource}>
            <Code className="size-3.5" />
            {t.raw('text6ee818aa2de3')}
          </Button>
        )}
      </Centered>
    );
  }

  if (!url) {
    return (
      <Centered className={className}>
        <Loading className="size-4" />
      </Centered>
    );
  }

  return (
    <div className={cn('relative h-full min-h-0', className)} data-component="mermaid-diagram">
      <ImageRenderer url={url} fileName={svgName} controls="always" className="h-full" />
      <div className="absolute top-2 right-2 z-10">
        <ButtonGroup>
          <Hint
            label={copied ? t.raw('text8d525e5f158b') : t.raw('text9ea1fed5d2c1')}
            side="bottom"
          >
            <Button
              variant="outline"
              size="icon-sm"
              onClick={copySource}
              aria-label={t.raw('text9ea1fed5d2c1')}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </Hint>
          <Hint label={t.raw('text91aec62280a3')} side="bottom">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={downloadSvg}
              aria-label={t.raw('text91aec62280a3')}
            >
              <Download className="size-3.5" />
            </Button>
          </Hint>
        </ButtonGroup>
      </div>
    </div>
  );
}

function Centered({
  children,
  className,
  role,
}: {
  children: React.ReactNode;
  className?: string;
  role?: string;
}) {
  return (
    <div
      role={role}
      className={cn(
        'text-muted-foreground flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center text-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}
