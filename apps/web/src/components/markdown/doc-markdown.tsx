'use client';

import { useTranslations } from 'next-intl';

import { wrapChildrenWithPaths } from '@/components/common/clickable-path';
import { CopyButton } from '@/components/markdown/copy-button';
import {
  buildKatexRehypePlugins,
  isKatexClassName,
  KATEX_FENCE_LANGUAGES,
  KATEX_RENDER_OPTIONS,
  katexRemarkPlugins,
  normalizeClassName,
  prepareMarkdownForKatex,
} from '@/components/markdown/katex-markdown';
import { SetupLinkButton } from '@/components/setup-links/setup-link-button';
import { parseSetupLinkHref } from '@/components/setup-links/util';
import { useSandboxProxy } from '@/hooks/use-sandbox-proxy';
import { isMermaidCode } from '@/lib/mermaid-utils';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import {
  isInternalUrl,
  isLinkSafeHref,
  languageLabel,
  looksLikeFilePath,
  looksLikeUrl,
  normalizeLanguage,
  shikiWasmAvailable,
} from '@/components/markdown/unified-markdown-utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { getActivePanelSessionId, openFileInSessionPanel } from '@/stores/session-browser-store';
import { autoLinkUrls } from '@kortix/shared';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  codeToHtml,
  getSingletonHighlighter,
  type Highlighter,
  type ShikiTransformer,
} from 'shiki';
import { Streamdown } from 'streamdown';

// Mermaid pulls in a multi-hundred-KB renderer; load it only once a diagram exists.
const MermaidRenderer = lazy(() =>
  import('@/components/ui/mermaid-renderer').then((mod) => ({
    default: mod.MermaidRenderer,
  })),
);

function handleHashClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  if (!href.startsWith('#')) return;
  e.preventDefault();
  document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Shiki highlighting ──────────────────────────────────────────────────────
// Markdown code uses the bundled `slack-ochin` (light) / `plastic` (dark) themes,
// kept separate from the app-wide Pierre themes in `@/lib/shiki-theme` (diff
// renderer, file viewers, thumbnails) so restyling markdown never touches those.
export const SHIKI_THEME_DARK = 'plastic';
export const SHIKI_THEME_LIGHT = 'slack-ochin';

const SHIKI_MAX_LENGTH = 50_000;

// Pre-loaded at init; anything else lazy-loads on first use. `text` lets no-hint
// fences flow through Shiki so they pick up the same editor foreground as the rest.
const PRELOAD_LANGS = [
  'text',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'python',
  'bash',
  'json',
  'css',
  'html',
  'markdown',
  'yaml',
];

// Strip Shiki's wrapper background/tabindex and any per-token font-weight/style —
// forcing a uniform weight keeps highlighted DOM the same width as plain text, so
// the colour swap never shifts glyphs horizontally.
const shikiTransformers: ShikiTransformer[] = [
  {
    pre(node) {
      if (typeof node.properties.style === 'string') {
        node.properties.style = node.properties.style.replace(/background-color:[^;]+;?/g, '');
      }
      delete node.properties.tabindex;
    },
    span(node) {
      if (typeof node.properties.style === 'string') {
        node.properties.style = node.properties.style
          .replace(/font-weight:[^;]+;?/g, '')
          .replace(/font-style:[^;]+;?/g, '');
      }
    },
  },
];

// Singleton highlighter — kicked off at module init so the grammar is usually
// ready by first render, letting us highlight synchronously (no plain→colour flash).
//
// Shiki's oniguruma engine compiles to WebAssembly, so skip the eager init
// entirely (and never leave a rejecting promise) when WebAssembly is unavailable
// — otherwise the rejection fires `onunhandledrejection` → Sentry on every page
// load for visitors whose browser blocks/disables WebAssembly. highlightAsync
// treats a null highlighter as "no highlighting available" and renders plain
// code. See Better Stack 1604d50a (`WebAssembly is not defined`).
let highlighterReady: Highlighter | null = null;
const loadedLangs = new Set<string>(PRELOAD_LANGS.map((l) => l.toLowerCase()));
const langLoadPromises = new Map<string, Promise<void>>();

const highlighterPromise: Promise<Highlighter | null> = shikiWasmAvailable()
  ? getSingletonHighlighter({
      themes: [SHIKI_THEME_DARK, SHIKI_THEME_LIGHT],
      langs: PRELOAD_LANGS,
    })
      .then((h) => {
        highlighterReady = h;
        return h;
      })
      .catch((err) => {
        console.warn('[unified-markdown] Shiki highlighter init failed:', err);
        return null;
      })
  : Promise.resolve(null);

function ensureLangLoaded(h: Highlighter, lang: string): Promise<void> {
  if (loadedLangs.has(lang)) return Promise.resolve();
  const existing = langLoadPromises.get(lang);
  if (existing) return existing;
  const p = h
    .loadLanguage(lang as never)
    .then(() => {
      loadedLangs.add(lang);
    })
    .catch((err) =>
      console.warn(`[unified-markdown] failed to load Shiki lang "${lang}":`, err?.message || err),
    )
    .finally(() => {
      langLoadPromises.delete(lang);
    });
  langLoadPromises.set(lang, p);
  return p;
}

function clampCode(code: string): string {
  return code.length > SHIKI_MAX_LENGTH
    ? code.slice(0, SHIKI_MAX_LENGTH) + '\n// ... (truncated for highlighting)'
    : code;
}

// Bounded cache keyed by (lang, theme, content signature). Survives the component
// remounts Streamdown triggers per token, so repeat highlights are free.
const shikiCache = new Map<string, string>();
const shikiPending = new Map<string, Promise<string | null>>();
const SHIKI_CACHE_MAX = 64;

function shikiKey(code: string, lang: string, theme: string): string {
  const sig = code.length <= 200 ? code : code.slice(0, 100) + code.slice(-100) + code.length;
  return `${lang}:${theme}:${sig}`;
}

function cacheHtml(key: string, html: string) {
  shikiCache.set(key, html);
  if (shikiCache.size > SHIKI_CACHE_MAX) {
    const oldest = shikiCache.keys().next().value;
    if (oldest !== undefined) shikiCache.delete(oldest);
  }
}

// Synchronous highlight when the grammar is ready (the common case). Returns null
// while the highlighter is still initialising, so callers fall back to async.
function highlightSync(code: string, language: string, theme: string): string | null {
  const lang = normalizeLanguage(language);
  const key = shikiKey(code, lang, theme);
  const cached = shikiCache.get(key);
  if (cached) return cached;
  if (!highlighterReady || !loadedLangs.has(lang)) return null;
  try {
    const html = highlighterReady.codeToHtml(clampCode(code), {
      lang,
      theme,
      transformers: shikiTransformers,
    });
    cacheHtml(key, html);
    return html;
  } catch {
    return null;
  }
}

function highlightAsync(code: string, language: string, theme: string): Promise<string | null> {
  const lang = normalizeLanguage(language);
  const key = shikiKey(code, lang, theme);
  const cached = shikiCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = shikiPending.get(key);
  if (inflight) return inflight;

  const p = highlighterPromise
    .then(async (h) => {
      if (!h) return null;
      await ensureLangLoaded(h, lang);
      return h.codeToHtml(clampCode(code), { lang, theme, transformers: shikiTransformers });
    })
    .catch(() => codeToHtml(clampCode(code), { lang, theme, transformers: shikiTransformers }))
    .then((html) => {
      cacheHtml(key, html);
      shikiPending.delete(key);
      return html;
    })
    .catch((err) => {
      console.warn(`[unified-markdown] Shiki failed for lang="${lang}":`, err?.message || err);
      shikiPending.delete(key);
      return null;
    });
  shikiPending.set(key, p);
  return p;
}

const SHIKI_RESET = cn(
  'text-sm font-mono leading-[1.65] whitespace-pre',
  '[&_pre]:contents [&_code]:contents',
  '[&_.line]:m-0 [&_.line]:p-0 [&_.line]:border-none [&_.line]:outline-none [&_.line]:shadow-none',
);

export function HighlightedCode({
  code,
  language,
  children,
}: {
  code: string;
  language: string;
  children: React.ReactNode;
}) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === 'dark' ? SHIKI_THEME_DARK : SHIKI_THEME_LIGHT;
  const [html, setHtml] = useState<string | null>(() => highlightSync(code, language, theme));

  useEffect(() => {
    const sync = highlightSync(code, language, theme);
    if (sync) {
      setHtml(sync);
      return;
    }
    let alive = true;
    highlightAsync(code, language, theme).then((result) => {
      if (alive && result) setHtml(result);
    });
    return () => {
      alive = false;
    };
  }, [code, language, theme]);

  if (html) {
    return <code className={SHIKI_RESET} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <code className="font-mono text-sm leading-[1.65] whitespace-pre">{children}</code>;
}

// Flat code card: rounded-lg surface, dashed header (language + copy), highlighted body.
function CodeBlock({
  code,
  language,
  children,
  isStreaming,
  className,
}: {
  code: string;
  language: string;
  children: React.ReactNode;
  isStreaming?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'group not-prose bg-muted dark:bg-card relative my-5 overflow-hidden rounded-lg border',
        className,
      )}
    >
      <div className="border-border/70 flex items-center justify-between gap-2 border-b border-dashed py-1 pr-1.5 pl-4">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase select-none">
          {languageLabel(language)}
        </span>
        {code && !isStreaming && <CopyButton code={code} />}
      </div>
      <pre
        className={cn(
          'max-h-[520px] overflow-auto py-4',
          'text-foreground font-mono text-sm leading-[1.65]',
          '[&_code]:border-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit',
          '[&_.shiki]:!bg-transparent [&_span]:border-none [&_span]:!bg-transparent [&_span]:outline-none',
        )}
      >
        {children}
      </pre>
    </div>
  );
}

// KaTeX for ```latex / ```tex / ```katex fences (rehype-katex only handles ```math).
function KaTeXBlock({ math }: { math: string }) {
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
      <pre className="katex-math-block border-border bg-muted text-muted-foreground my-5 overflow-x-auto rounded-md border px-4 py-3 font-mono text-sm">
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

// ─── Inline code ─────────────────────────────────────────────────────────────
const INLINE_CODE =
  'rounded-sm border bg-muted px-1.5 py-[0.1rem] font-mono text-[0.9rem] text-foreground/95 dark:bg-card';

// Inline code that becomes a link (URLs) or opens a file preview (absolute paths).
function ClickableInlineCode({ children }: { children: React.ReactNode }) {
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  const { proxyUrl } = useSandboxProxy();
  const text = String(children).trim();
  const isUrl = looksLikeUrl(text);
  const isFile = !isUrl && looksLikeFilePath(text);
  const isAbsolute = text.startsWith('/');

  if (isUrl) {
    const href = proxyUrl(text) ?? text;
    const linkClass = cn(INLINE_CODE, 'hover:text-kortix-blue cursor-pointer transition-colors');

    // A malformed absolute URL (e.g. `http://:`) must not reach next/link —
    // its prefetch path throws `Cannot prefetch '...'` (see isLinkSafeHref).
    if (!isLinkSafeHref(href)) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${text} in a new tab`}
          className={linkClass}
        >
          {children}
        </a>
      );
    }

    return (
      <Link
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${text} in a new tab`}
        className={linkClass}
      >
        {children}
      </Link>
    );
  }

  if (isFile) {
    const openFile = () => {
      if (!isAbsolute) {
        toast.error(`Cannot open relative path: ${text}`);
        return;
      }
      const sessionId = getActivePanelSessionId();
      if (sessionId) openFileInSessionPanel(sessionId, text);
      else openPreview(text);
    };
    return (
      <code
        role="button"
        onClick={isAbsolute ? openFile : undefined}
        title={isAbsolute ? `Click to preview ${text}` : `${text} — relative path (cannot open)`}
        className={cn(
          INLINE_CODE,
          'transition-colors',
          isAbsolute ? 'hover:text-kortix-blue cursor-pointer' : 'cursor-not-allowed opacity-70',
        )}
      >
        {children}
      </code>
    );
  }

  return <code className={cn(INLINE_CODE, 'text-[0.8rem]')}>{children}</code>;
}

// Standalone highlighted code block — bypasses the markdown parser. Used by tool
// views that render raw file content where markdown parsing would interfere.
export function CodeHighlight({
  code,
  language,
  className,
}: {
  code: string;
  language: string;
  className?: string;
}) {
  return (
    <CodeBlock code={code} language={language} className={cn('my-0', className)}>
      <HighlightedCode code={code} language={language}>
        {code}
      </HighlightedCode>
    </CodeBlock>
  );
}

export interface DocMarkdownProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  /**
   * Parse embedded raw HTML/SVG into live DOM. Defaults to `true`; set `false`
   * for file/source viewers so markup shows as escaped text instead of broken DOM.
   */
  allowHtml?: boolean;
}

// Docs-owned markdown renderer — a copy of unified-markdown.tsx so the docs
// evolve independently of the app renderer (which changes only in the
// `markdown` worktree). Same code, docs name.
export const DocMarkdown = React.memo<DocMarkdownProps>(
  ({ content, className, isStreaming = false, allowHtml = true }) => {
    const tHardcodedUi = useTranslations('hardcodedUi');
    const { proxyUrl } = useSandboxProxy();
    const proxy = useCallback((url: string | undefined) => proxyUrl(url), [proxyUrl]);

    // Memoize the components object so Block's React.memo sees stable references and
    // only the changed block re-renders during streaming (preserves text selection).
    const components = useMemo(
      () => ({
        // Headings — graduated hierarchy bounded by text-base (h6) → text-xl (h1).
        // Only 3 named sizes live in that range, so deeper levels step down via
        // weight, colour, and top-margin instead.
        h1: ({ children }: { children?: React.ReactNode }) => (
          <h1 className="text-foreground mt-10 mb-4 text-xl font-semibold first:mt-0">
            {children}
          </h1>
        ),
        h2: ({ children }: { children?: React.ReactNode }) => (
          <h2 className="text-foreground mt-8 mb-3 text-xl font-semibold first:mt-0">{children}</h2>
        ),
        h3: ({ children }: { children?: React.ReactNode }) => (
          <h3 className="text-foreground mt-6 mb-2 text-lg font-semibold first:mt-0">{children}</h3>
        ),
        h4: ({ children }: { children?: React.ReactNode }) => (
          <h4 className="text-foreground mt-6 mb-2 text-lg font-semibold first:mt-0">{children}</h4>
        ),
        h5: ({ children }: { children?: React.ReactNode }) => (
          <h5 className="text-foreground mt-4 mb-1 text-base font-semibold first:mt-0">
            {children}
          </h5>
        ),
        h6: ({ children }: { children?: React.ReactNode }) => (
          <h6 className="text-foreground mt-4 mb-1 text-base font-semibold tracking-wide first:mt-0">
            {children}
          </h6>
        ),

        p: ({ children }: { children?: React.ReactNode }) => (
          <div className="text-foreground/95 my-4 leading-relaxed font-medium first:mt-0 last:mb-0 [&:has(img)]:my-0">
            {wrapChildrenWithPaths(children)}
          </div>
        ),

        ul: ({ children }: { children?: React.ReactNode }) => (
          <ul className="marker:text-muted-foreground/60 my-4 list-outside list-disc space-y-1 pl-6 first:mt-0 last:mb-0 [&_p]:mb-2 [&_p]:last:mb-0">
            {children}
          </ul>
        ),
        ol: ({ children }: { children?: React.ReactNode }) => (
          <ol className="marker:text-muted-foreground/80 my-4 list-outside list-decimal space-y-1 pl-6 marker:font-medium first:mt-0 last:mb-0 [&_p]:mb-2 [&_p]:last:mb-0">
            {children}
          </ol>
        ),
        li: ({ children }: { children?: React.ReactNode }) => (
          <li className="text-foreground/95 leading-relaxed font-medium">
            {wrapChildrenWithPaths(children)}
          </li>
        ),

        // Links — brand-blue, routed through next/link. Setup links open an in-app modal.
        a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
          const setupLink = parseSetupLinkHref(href);
          if (setupLink) {
            return (
              <SetupLinkButton kind={setupLink.kind} token={setupLink.token}>
                {children}
              </SetupLinkButton>
            );
          }

          const resolvedHref = proxy(href) ?? href ?? '#';
          const isHash = resolvedHref.startsWith('#');
          const isExternal = !isInternalUrl(resolvedHref);
          const linkClass = cn(
            'font-medium text-kortix-blue',
            'underline decoration-kortix-blue/40 decoration-[1px] underline-offset-[3px]',
            'transition-colors hover:decoration-kortix-blue',
            '[overflow-wrap:anywhere]',
          );

          // A malformed absolute href (e.g. `http://:` from an unsubstituted
          // `${HOST}:${PORT}` template in content) must not reach next/link —
          // its prefetch path throws `Cannot prefetch '...'` (see isLinkSafeHref).
          if (!isLinkSafeHref(resolvedHref)) {
            return (
              <a
                href={resolvedHref}
                className={linkClass}
                {...(isExternal && !isHash ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {children}
              </a>
            );
          }

          return (
            <Link
              href={resolvedHref}
              onClick={isHash ? (e) => handleHashClick(e, resolvedHref) : undefined}
              className={linkClass}
              {...(isExternal && !isHash ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              {children}
            </Link>
          );
        },

        // Code — Mermaid and KaTeX fences render their own chrome; everything else goes
        // through the shared card. `language || 'text'` routes no-hint fences via Shiki.
        code: ({
          children,
          className: codeClassName,
        }: {
          children?: React.ReactNode;
          className?: string;
        }) => {
          const match = /language-(\w+)/.exec(codeClassName || '');
          const language = match ? match[1] : '';
          const code = String(children).replace(/\n$/, '');
          const isBlock = codeClassName?.includes('language-') || code.includes('\n');

          if (isBlock) {
            if (isMermaidCode(language, code)) {
              return (
                <Suspense fallback={null}>
                  <MermaidRenderer chart={code} className="my-5" />
                </Suspense>
              );
            }
            if (KATEX_FENCE_LANGUAGES.has(language.toLowerCase())) {
              return <KaTeXBlock math={code} />;
            }
            return (
              <CodeBlock code={code} language={language} isStreaming={isStreaming}>
                <HighlightedCode code={code} language={language || 'text'}>
                  {children}
                </HighlightedCode>
              </CodeBlock>
            );
          }

          // Agents sometimes wrap a setup link in backticks instead of a markdown
          // link — same interception as `a` above, so the human still gets the
          // in-chat form chip instead of a wall of token characters.
          const inlineSetupLink = parseSetupLinkHref(code.trim());
          if (inlineSetupLink) {
            return <SetupLinkButton kind={inlineSetupLink.kind} token={inlineSetupLink.token} />;
          }

          return <ClickableInlineCode>{children}</ClickableInlineCode>;
        },
        // `code` returns the fully-styled block; collapse the default `<pre>` wrapper.
        pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,

        blockquote: ({ children }: { children?: React.ReactNode }) => (
          <blockquote className="border-border text-muted-foreground my-5 border-l-2 pl-6 italic [&>p]:my-2">
            {wrapChildrenWithPaths(children)}
          </blockquote>
        ),

        hr: () => <hr className="border-border/60 my-6 h-px border-0 border-t" />,

        table: ({ children }: { children?: React.ReactNode }) => (
          <div className="border-border my-5 overflow-x-auto rounded-md border">
            <table className="!m-0 w-full text-sm">{children}</table>
          </div>
        ),
        thead: ({ children }: { children?: React.ReactNode }) => (
          <thead className="border-border bg-muted border-b">{children}</thead>
        ),
        tbody: ({ children }: { children?: React.ReactNode }) => (
          <tbody className="divide-border divide-y">{children}</tbody>
        ),
        tr: ({ children }: { children?: React.ReactNode }) => <tr>{children}</tr>,
        th: ({ children }: { children?: React.ReactNode }) => (
          <th className="text-foreground px-4 py-2 text-left font-semibold">{children}</th>
        ),
        td: ({ children }: { children?: React.ReactNode }) => (
          <td className="text-foreground px-4 py-2 text-left font-normal">
            {wrapChildrenWithPaths(children)}
          </td>
        ),

        img: ({ src, alt }: { src?: string; alt?: string }) => {
          if (!src) return null;
          const resolvedSrc = proxy(src) ?? src;
          return (
            <span className="my-5 block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={resolvedSrc}
                alt={alt || ''}
                loading="lazy"
                className="h-auto max-w-full rounded-lg outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
              />
            </span>
          );
        },

        strong: ({ children }: { children?: React.ReactNode }) => (
          <strong className="text-foreground font-semibold">{children}</strong>
        ),
        em: ({ children }: { children?: React.ReactNode }) => (
          <em className="text-foreground/90 italic">{children}</em>
        ),
        del: ({ children }: { children?: React.ReactNode }) => (
          <del className="text-muted-foreground decoration-muted-foreground/50 line-through">
            {children}
          </del>
        ),

        // GFM task-list checkbox.
        input: ({ checked, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className="border-border accent-secondary relative -top-[1px] mr-2 size-4 cursor-default rounded align-middle"
            {...props}
          />
        ),

        // Raw HTML passthrough (GFM) — leave KaTeX-owned nodes untouched.
        div: ({
          children,
          style,
          className: divClassName,
          ...props
        }: React.HTMLAttributes<HTMLDivElement>) => {
          if (isKatexClassName(divClassName)) {
            return (
              <div
                className={normalizeClassName(divClassName)}
                style={style as React.CSSProperties}
                {...props}
              >
                {children}
              </div>
            );
          }
          return (
            <div
              className={cn('text-foreground text-sm', divClassName)}
              style={style as React.CSSProperties}
              {...props}
            >
              {children}
            </div>
          );
        },
        span: ({
          children,
          style,
          className: spanClassName,
          ...props
        }: React.HTMLAttributes<HTMLSpanElement>) => {
          if (isKatexClassName(spanClassName)) {
            return (
              <span
                className={normalizeClassName(spanClassName)}
                style={style as React.CSSProperties}
                {...props}
              >
                {children}
              </span>
            );
          }
          return (
            <span
              className={cn('text-foreground', spanClassName)}
              style={style as React.CSSProperties}
              {...props}
            >
              {children}
            </span>
          );
        },
      }),
      [isStreaming, proxy],
    );

    const safeContent = typeof content === 'string' ? content : content ? String(content) : '';

    if (!safeContent) {
      return (
        <div className={cn('text-muted-foreground text-sm', className)}>
          {tHardcodedUi.raw('componentsMarkdownUnifiedMarkdown.line1115JsxTextNoContent')}
        </div>
      );
    }

    const finalContent = autoLinkUrls(stripKortixSystemTags(prepareMarkdownForKatex(safeContent)));

    return (
      <div
        className={cn('kortix-markdown text-[15px]', isStreaming && 'streaming-active', className)}
        data-streaming={isStreaming ? 'true' : 'false'}
      >
        <Streamdown
          isAnimating={isStreaming}
          mode="static"
          components={components as any}
          remarkPlugins={katexRemarkPlugins}
          rehypePlugins={allowHtml ? buildKatexRehypePlugins(true) : buildKatexRehypePlugins(false)}
        >
          {finalContent}
        </Streamdown>
      </div>
    );
  },
);

DocMarkdown.displayName = 'DocMarkdown';
