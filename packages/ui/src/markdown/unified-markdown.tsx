'use client';

import { toSandboxAbsolutePath } from '@kortix/sdk';

import { useTranslations } from '../i18n';

import { ClickablePath, wrapChildrenWithPaths } from '../internal/components/clickable-path';
import { MarkdownCode } from './code';
import { closeOpenGenuiFence, openGenuiFence, separateGenuiClosers } from './code/genui-fence';
import { parseFileLinkHref, remarkWorkspaceFileLinks } from './file-links';
import { InsideLinkContext } from './code/inside-link-context';
import {
  isKatexClassName,
  katexRehypePlugins,
  katexRehypePluginsNoRaw,
  katexRemarkPlugins,
  normalizeClassName,
} from './katex-markdown';
import {
  markdownPolicy,
  type MarkdownPolicy,
  type MarkdownTrust,
  type MarkdownVariant,
} from './markdown-policy';
import { MarkdownOrderedList } from './ordered-list';
import type { PluggableList } from 'unified';
import {
  hasLinkReferenceDefinition,
  isInternalUrl,
  isStreamingLinkPlaceholder,
  prepareMarkdownSource,
  remoteImageHost,
  shouldUseNextLink,
} from './unified-markdown-utils';
import { remarkSetupLinkBlocks } from './setup-link-blocks';
import {
  rehypeStreamWords,
  STREAM_WORD_CLASS,
  StreamFadeGateContext,
  StreamWord,
  createStreamFadeGate,
} from './stream-words';
import { SetupLinkButton, SetupLinkInlineContext } from './setup-links/setup-link-button';
import { parsePendingSetupLinkHref, parseSetupLinkHref } from './setup-links/util';
import { Button } from '../primitives/button';
import { Checkbox } from '../primitives/checkbox';
import { useSandboxProxy } from '../internal/hooks/use-sandbox-proxy';
import { useOpenPreviewLink } from '../internal/hooks/use-open-preview-link';
import { cn } from '../lib/utils';
import { ImageIcon } from '@phosphor-icons/react';
import { useUiLink } from '../providers/ui-provider';
import React, { useCallback, useContext, useMemo, useState } from 'react';
import { parseMarkdownIntoBlocks, Streamdown } from 'streamdown';

const LINK_CLASS = cn(
  'font-medium text-kortix-blue',
  'underline decoration-kortix-blue/40 decoration-[1px] underline-offset-[3px]',
  'transition-colors hover:decoration-kortix-blue',
  '[overflow-wrap:anywhere]',
);

function handleHashClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
  if (!href.startsWith('#')) return;
  e.preventDefault();
  document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * What a renderer needs from the message it sits in. It arrives by context,
 * not by closure, so `MARKDOWN_COMPONENTS` can be module-level.
 */
interface MarkdownRenderContextValue {
  isStreaming: boolean;
  proxy: (url: string | undefined) => string | undefined;
  policy: Readonly<MarkdownPolicy>;
  trust: MarkdownTrust;
  variant: MarkdownVariant;
  /** ```openui fences render as generative UI (see `UnifiedMarkdownProps.genui`). */
  genui: boolean;
}

const MarkdownRenderContext = React.createContext<MarkdownRenderContextValue>({
  isStreaming: false,
  proxy: (url) => url,
  policy: markdownPolicy('untrusted'),
  trust: 'untrusted',
  variant: 'message',
  genui: false,
});

export function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const Link = useUiLink();
  const { proxy, policy, variant } = useContext(MarkdownRenderContext);
  const openPreview = useOpenPreviewLink();
  // Only agent content may turn a setup link into the in-app card. From any
  // other writer it stays a plain link to the same page.
  const setupLink = policy.setupLinks ? parseSetupLinkHref(href) : null;
  if (setupLink) {
    return (
      <SetupLinkButton kind={setupLink.kind} token={setupLink.token}>
        {children}
      </SetupLinkButton>
    );
  }

  // A setup link whose URL is still streaming: the card it will
  // become, with nothing to click yet (see `holdPendingSetupLink`).
  const pendingSetupLink = policy.setupLinks ? parsePendingSetupLinkHref(href) : null;
  if (pendingSetupLink) {
    return (
      <SetupLinkButton kind={pendingSetupLink} token={null}>
        {children}
      </SetupLinkButton>
    );
  }

  // A file in the session's workspace opens the file preview, the same
  // as a path in prose (see `remarkWorkspaceFileLinks`).
  const decodedFilePath = policy.fileLinks ? parseFileLinkHref(href) : null;
  const filePath = policy.fileLinks ? parseFileLinkHref(href, variant === 'document') : null;
  if (decodedFilePath && !filePath) {
    return <span className={LINK_CLASS}>{children}</span>;
  }
  if (filePath) {
    return (
      <ClickablePath filePath={filePath} className={LINK_CLASS}>
        {children}
      </ClickablePath>
    );
  }

  // The URL is still streaming: show the label in link style, with
  // nothing to click until the real href arrives.
  if (isStreamingLinkPlaceholder(href)) {
    return <span className={LINK_CLASS}>{children}</span>;
  }

  const resolvedHref = proxy(href) ?? href ?? '#';
  const isHash = resolvedHref.startsWith('#');
  const isExternal = !isInternalUrl(resolvedHref);
  // A sandbox address under a host preview resolver: the proxied href would
  // land on the host's own origin, so the click opens the host's URL.
  if (openPreview && href && resolvedHref !== href) {
    return (
      <a
        href={href}
        className={LINK_CLASS}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => openPreview(e, href, resolvedHref)}
      >
        <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
      </a>
    );
  }

  // Markdown can contain arbitrary same-origin absolute URLs. Next.js
  // treats those as app routes and prefetches them, including typos such
  // as `/legal/terms.`. Only trusted root-relative/hash paths belong in
  // the app router; every other href stays a plain anchor.
  if (!shouldUseNextLink(resolvedHref)) {
    return (
      <a
        href={resolvedHref}
        className={LINK_CLASS}
        {...(isExternal && !isHash ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
      </a>
    );
  }

  return (
    <Link
      href={resolvedHref}
      onClick={isHash ? (e) => handleHashClick(e, resolvedHref) : undefined}
      className={LINK_CLASS}
      {...(isExternal && !isHash ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      <InsideLinkContext.Provider value={true}>{children}</InsideLinkContext.Provider>
    </Link>
  );
}

/**
 * `flush`: no vertical margin, for an image inside a generative UI block that spaces its own children.
 * `compact`: the click-to-load placeholder is an icon-only button that fills its box, for a small thumbnail
 * whose box would clip the labelled button.
 */
export function MarkdownImage({
  src,
  alt,
  flush = false,
  compact = false,
  onError,
}: {
  src?: string;
  alt?: string;
  flush?: boolean;
  compact?: boolean;
  /** The image failed to load: a host can drop its frame or show a fallback. */
  onError?: () => void;
}) {
  const { proxy, policy } = useContext(MarkdownRenderContext);
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [loadRequested, setLoadRequested] = useState(false);
  if (!src) return null;
  const resolvedSrc = proxy(src) ?? src;
  const remoteHost = remoteImageHost(src, resolvedSrc);
  if (policy.remoteImages === 'click-to-load' && remoteHost && !loadRequested) {
    const label = tHardcodedUi('componentsMarkdownUnifiedMarkdown.loadRemoteImage', { host: remoteHost });
    if (compact) {
      return (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={label}
          aria-label={label}
          onClick={() => setLoadRequested(true)}
          className="text-muted-foreground size-full"
        >
          <ImageIcon className="size-4" />
        </Button>
      );
    }
    return (
      <Button
        type="button"
        variant="outline"
        size="xs"
        title={alt || undefined}
        onClick={() => setLoadRequested(true)}
        className="text-muted-foreground max-w-full"
      >
        <ImageIcon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </Button>
    );
  }
  return (
    <span className={cn('block', !flush && 'my-5')}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={resolvedSrc}
        alt={alt || ''}
        loading="lazy"
        onError={onError}
        className="h-auto max-w-full rounded-lg outline outline-1 -outline-offset-1 outline-border"
      />
    </span>
  );
}

/**
 * Every renderer the markdown uses, defined once for the module.
 *
 * The identities never change, and that is load-bearing. Each function here is
 * an element TYPE to React. This map used to be rebuilt whenever `isStreaming`
 * or the sandbox proxy changed, which changed every type in the message at
 * once, so React remounted all of it: at the end of every turn an open
 * setup-link modal closed and its connect poll stopped, and code blocks and
 * diagrams rendered again. Values that change arrive through
 * `MarkdownRenderContext` instead. The stable map also lets Streamdown's
 * per-block memo skip every block the new text did not touch.
 */
const MARKDOWN_COMPONENTS = {
  // Headings — graduated hierarchy bounded by text-base (h6) → text-xl (h1).
  // Only 3 named sizes live in that range, so deeper levels step down via
  // weight, colour, and top-margin instead.
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-foreground mt-10 mb-4 text-xl font-semibold first:mt-0">{children}</h1>
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
    <h5 className="text-foreground mt-4 mb-1 text-base font-semibold first:mt-0">{children}</h5>
  ),
  h6: ({ children }: { children?: React.ReactNode }) => (
    <h6 className="text-foreground mt-4 mb-1 text-base font-semibold tracking-wide first:mt-0">
      {children}
    </h6>
  ),

  p: ({ children }: { children?: React.ReactNode }) => (
    <div className="text-foreground my-4 leading-relaxed font-medium [overflow-wrap:anywhere] first:mt-0 last:mb-0 [&:has(img)]:my-0">
      {wrapChildrenWithPaths(children)}
    </div>
  ),

  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="marker:text-muted-foreground my-4 list-outside list-disc space-y-1 pl-6 first:mt-0 last:mb-0 [&_p]:mb-2 [&_p]:last:mb-0">
      {children}
    </ul>
  ),
  ol: MarkdownOrderedList,
  // A setup link still inside a list or table is part of a sentence or a row of
  // data (`liftSetupLinkBlocks` lifted the ones that were not), so it renders
  // as an inline chip rather than a full-width card.
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="text-foreground leading-relaxed font-medium [overflow-wrap:anywhere]">
      <SetupLinkInlineContext.Provider value={true}>
        {wrapChildrenWithPaths(children)}
      </SetupLinkInlineContext.Provider>
    </li>
  ),

  // Links — brand-blue, routed through next/link. Setup links open an in-app modal.
  a: MarkdownLink,

  // Every fence kind and inline code resolve in one shared place; see
  // packages/ui/src/markdown/code.
  code: function MarkdownCodeRenderer(props: { children?: React.ReactNode; className?: string }) {
    const { isStreaming, policy, trust, variant, genui } = useContext(MarkdownRenderContext);
    return (
      <MarkdownCode
        {...props}
        isStreaming={isStreaming}
        setupLinks={policy.setupLinks}
        trust={trust}
        variant={variant}
        genui={genui}
      />
    );
  },
  // `code` returns the fully-styled block; collapse the default `<pre>` wrapper.
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,

  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-border text-muted-foreground my-5 border-l-2 pl-6 italic [&>p]:my-2">
      {wrapChildrenWithPaths(children)}
    </blockquote>
  ),

  hr: () => <hr className="border-border my-6 h-px border-0 border-t" />,

  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="kx-md-table border-border my-5 overflow-x-auto rounded-md border">
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
  // cn() is twMerge: the last same-group class wins. Static classes go
  // last here so an incoming className can't strip whitespace-nowrap/break-normal.
  th: ({
    children,
    className: thClassName,
    node: _node,
    ...props
  }: React.ThHTMLAttributes<HTMLTableCellElement> & { node?: unknown }) => (
    <th
      className={cn(
        thClassName,
        'text-foreground px-4 py-2 text-left font-semibold break-normal whitespace-nowrap',
      )}
      {...props}
    >
      {children}
    </th>
  ),
  td: ({
    children,
    className: tdClassName,
    node: _node,
    ...props
  }: React.TdHTMLAttributes<HTMLTableCellElement> & { node?: unknown }) => (
    <td
      className={cn(tdClassName, 'text-foreground px-4 py-2 text-left font-normal break-normal')}
      {...props}
    >
      <SetupLinkInlineContext.Provider value={true}>
        {wrapChildrenWithPaths(children)}
      </SetupLinkInlineContext.Provider>
    </td>
  ),

  img: MarkdownImage,

  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="text-foreground font-semibold">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="text-foreground italic">{children}</em>
  ),
  del: ({ children }: { children?: React.ReactNode }) => (
    <del className="text-muted-foreground decoration-muted-foreground/50 line-through">
      {children}
    </del>
  ),

  // GFM task-list checkbox.
  // Read-only: the control is shown, never toggled.
  input: ({ checked }: React.InputHTMLAttributes<HTMLInputElement> & { node?: unknown }) => (
    <Checkbox
      checked={!!checked}
      tabIndex={-1}
      aria-readonly
      className="pointer-events-none relative -top-px mr-2 inline-flex align-middle"
    />
  ),

  // Raw HTML passthrough (GFM) — leave KaTeX-owned nodes untouched.
  div: ({
    children,
    style,
    className: divClassName,
    node: _node,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { node?: unknown }) => {
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
    node: _node,
    ...props
  }: React.HTMLAttributes<HTMLSpanElement> & { node?: unknown }) => {
    // A streamed word (see `rehypeStreamWords`): it inherits its parent's
    // colour, so it must not take the `text-foreground` below.
    if (spanClassName === STREAM_WORD_CLASS) {
      return <StreamWord>{children}</StreamWord>;
    }
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
};

/**
 * Streamdown's block split, except that a message defining reference-style
 * link targets stays one block, so `[text][1]` can reach `[1]: https://…`.
 * See `hasLinkReferenceDefinition`.
 */
function parseMarkdownBlocks(markdown: string): string[] {
  return hasLinkReferenceDefinition(markdown) ? [markdown] : parseMarkdownIntoBlocks(markdown);
}

export interface UnifiedMarkdownProps {
  content: string;
  /**
   * Who wrote `content`. Decides whether embedded HTML is parsed, whether
   * remote images load, and whether setup links become in-app cards. See
   * `MarkdownTrust`.
   */
  trust: MarkdownTrust;
  /** `document` for a markdown file: embedded HTML is not parsed. Defaults to `message`. */
  variant?: MarkdownVariant;
  /**
   * `variant="document"` only: the path of the file being rendered. A
   * document's relative links are relative to its directory, so with a known
   * location agent documents resolve and open them (see
   * `remarkWorkspaceFileLinks`); without one they stay blocked. Untrusted
   * content never gets file links.
   */
  documentPath?: string;
  className?: string;
  isStreaming?: boolean;
  /**
   * Render ```openui fences as generative UI. Only session transcript assistant text sets it
   * (the transcript and the share view); everywhere else such a fence is an ordinary code block.
   */
  genui?: boolean;
}

/**
 * Agent content only: the setup-link lift depends on `policy.setupLinks`, the
 * same gate that turns a setup link into a card. Module-level so the array is
 * stable across renders (see the `rehypePlugins` note below).
 */
const REMARK_PLUGINS_WITH_SETUP_LINKS = [...katexRemarkPlugins, remarkSetupLinkBlocks];
const REMARK_PLUGINS_WITH_FILE_LINKS = [...REMARK_PLUGINS_WITH_SETUP_LINKS, remarkWorkspaceFileLinks];
// Last, so the words it wraps are the final, sanitized text.
const STREAMING_REHYPE_PLUGINS = [...katexRehypePlugins, rehypeStreamWords];
const STREAMING_REHYPE_PLUGINS_NO_RAW = [...katexRehypePluginsNoRaw, rehypeStreamWords];

// Single source of truth for markdown rendering across the app — clean, minimal,
// readable in both themes.
export const UnifiedMarkdown = React.memo<UnifiedMarkdownProps>(
  ({ content, trust, variant = 'message', className, isStreaming = false, documentPath, genui = false }) => {
    const tHardcodedUi = useTranslations('hardcodedUi');
    const { proxyUrl } = useSandboxProxy();
    const proxy = useCallback((url: string | undefined) => proxyUrl(url), [proxyUrl]);
    const policy = markdownPolicy(trust, variant);
    // A document's file links turn on once its location is known, under the
    // same trust gate as messages (`markdownPolicy(trust, 'message')`), so
    // untrusted documents never link files. `workspaceFileLinkPath` resolves
    // relative links against the document's directory and keeps traversal
    // inside the sandbox roots.
    const effectivePolicy = useMemo(() => {
      if (variant !== 'document' || !documentPath) return policy;
      if (!markdownPolicy(trust, 'message').fileLinks) return policy;
      return { ...policy, fileLinks: true };
    }, [policy, trust, variant, documentPath]);
    const documentBaseDir = useMemo(() => {
      if (variant !== 'document' || !documentPath || !effectivePolicy.fileLinks) return undefined;
      const file = toSandboxAbsolutePath(documentPath);
      const cut = file.lastIndexOf('/');
      return cut > 0 ? file.slice(0, cut) : undefined;
    }, [variant, documentPath, effectivePolicy.fileLinks]);
    const remarkPlugins = useMemo<PluggableList>(() => {
      if (documentBaseDir) {
        return [...REMARK_PLUGINS_WITH_SETUP_LINKS, [remarkWorkspaceFileLinks, { baseDir: documentBaseDir }]];
      }
      return effectivePolicy.fileLinks
        ? REMARK_PLUGINS_WITH_FILE_LINKS
        : policy.setupLinks
          ? REMARK_PLUGINS_WITH_SETUP_LINKS
          : katexRemarkPlugins;
    }, [documentBaseDir, effectivePolicy, policy.setupLinks]);

    // Streamdown renders streaming text block by block and settled text as one
    // document: two different React trees. Switching trees when the turn ends
    // remounts the whole message, the same loss as unstable renderer types
    // above. A message that mounts streaming keeps the block renderer for good;
    // one that mounts settled (history) is parsed as one document.
    const [streamedAtMount] = useState(isStreaming);
    // Text present at mount shows without the per-word fade (see `StreamFadeGate`).
    const [fadeGate] = useState(() => createStreamFadeGate(!isStreaming));

    const safeContent = typeof content === 'string' ? content : content ? String(content) : '';

    // A generative UI fence still open at the end streams (the model is writing it) or was cut
    // off. It is closed here, so nothing after it, such as Streamdown's completion of unfinished
    // markdown, lands inside the block, and its last line tells the block which of the two it is.
    // A nested fence (`code === null`) in history may be one its container already closed: closing
    // it again would render an extra empty code block, so it is closed only while streaming.
    // A closer the model glued to the last statement (`…")````) moves to its own line first, or
    // CommonMark would not close the fence and the prose after it would land inside the block.
    const source = useMemo(() => (genui ? separateGenuiClosers(safeContent) : safeContent), [genui, safeContent]);
    const genuiOpen = useMemo(() => (genui ? openGenuiFence(source) : null), [genui, source]);
    const renderContext = useMemo(
      () => ({ isStreaming, proxy, policy: effectivePolicy, trust, variant, genui }),
      [isStreaming, proxy, effectivePolicy, trust, variant, genui],
    );

    // Whole-string rewrites (KaTeX prep, system-tag strip, the pending setup
    // link, autolink). Run bare, they re-ran on EVERY render of this component
    // — including every render caused by something other than a new token —
    // for the full length of the answer. Memoising on the string collapses
    // that to once per distinct value. It sits ABOVE the empty-content early
    // return so the hook order stays fixed.
    const finalContent = useMemo(() => {
      if (!source) return '';
      const closed =
        genuiOpen && (genuiOpen.code !== null || isStreaming)
          ? closeOpenGenuiFence(source, genuiOpen, isStreaming ? 'streaming' : 'cut-off')
          : source;
      return prepareMarkdownSource(closed, isStreaming);
    }, [source, genuiOpen, isStreaming]);

    if (!safeContent) {
      return (
        <div className={cn('text-muted-foreground text-sm', className)}>
          {tHardcodedUi.raw('componentsMarkdownUnifiedMarkdown.line1115JsxTextNoContent')}
        </div>
      );
    }

    return (
      <div
        className={cn(
          'kortix-markdown max-w-full min-w-0 text-base [overflow-wrap:anywhere]',
          isStreaming && 'streaming-active',
          className,
        )}
        data-streaming={isStreaming ? 'true' : 'false'}
      >
        <MarkdownRenderContext.Provider value={renderContext}>
          <StreamFadeGateContext.Provider value={fadeGate}>
            <Streamdown
              isAnimating={isStreaming}
              mode={streamedAtMount || isStreaming ? 'streaming' : 'static'}
              // Completing half-written markdown is for text that is still
              // arriving. A settled message renders exactly as written.
              parseIncompleteMarkdown={isStreaming}
              parseMarkdownIntoBlocksFn={parseMarkdownBlocks}
              components={MARKDOWN_COMPONENTS as any}
              remarkPlugins={remarkPlugins}
              // Module-level arrays for the same reason as MARKDOWN_COMPONENTS: a
              // new array each render made every block re-parse on every token.
              // While streaming, each word also fades in as it mounts. Dropping
              // the plugin at the end re-renders every block once as plain text.
              rehypePlugins={
                isStreaming
                  ? policy.rawHtml
                    ? STREAMING_REHYPE_PLUGINS
                    : STREAMING_REHYPE_PLUGINS_NO_RAW
                  : policy.rawHtml
                    ? katexRehypePlugins
                    : katexRehypePluginsNoRaw
              }
            >
              {finalContent}
            </Streamdown>
          </StreamFadeGateContext.Provider>
        </MarkdownRenderContext.Provider>
      </div>
    );
  },
);

UnifiedMarkdown.displayName = 'UnifiedMarkdown';
