import { BlogCta } from '@/components/blog/blog-cta';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Check, Minus } from 'lucide-react';
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';

/**
 * The blog is React-rendered, not MDX. A post body is an array of typed
 * `Block`s (plain data in `blog-posts.ts`) that this module renders to clean,
 * server-rendered, semantic HTML — beautiful, interactive where it helps, and
 * fully scrapeable for SEO. Rich comparison blocks reuse the look of the
 * marketing comparison pages.
 */

type RowLean = 'them' | 'kortix' | 'both';

export type CompareRow = {
  dimension: string;
  them: string;
  kortix: string;
  lean?: RowLean;
};

export type Logo = { domain: string; name: string };

export type Block =
  | { type: 'lead'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'code'; code: string }
  | { type: 'callout'; text: string }
  | { type: 'logos'; label?: string; items: Logo[] }
  | { type: 'verdict'; themLabel: string; them: string; kortix: string }
  | { type: 'compare'; them: string; rows: CompareRow[] }
  | { type: 'cta'; title: string; body?: string };

/* ── inline rich text: **bold**, `code`, [text](url) ─────────────────────── */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${i}:${part}`;
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={key} className="text-foreground font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={key}
          className="border-border bg-muted text-foreground rounded-md border px-1.5 py-0.5 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (linkMatch) {
      const [, label, href] = linkMatch;
      return href.startsWith('/') ? (
        <Link key={key} href={href} className="text-foreground underline underline-offset-4">
          {label}
        </Link>
      ) : (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-4"
        >
          {label}
        </a>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

/* ── logos ───────────────────────────────────────────────────────────────── */

function Favicon({ domain, name }: Logo) {
  return (
    <span className="border-border bg-background flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`https://www.google.com/s2/favicons?domain=${domain}&sz=128`}
        alt={name}
        width={20}
        height={20}
        loading="lazy"
        className="size-5"
      />
    </span>
  );
}

function LogosBlock({ label, items }: { label?: string; items: Logo[] }) {
  return (
    <div className="border-border bg-card my-8 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border p-5">
      {label && <span className="text-muted-foreground text-sm font-medium">{label}</span>}
      <div className="flex flex-wrap items-center gap-4">
        {items.map((logo) => (
          <span key={logo.name} className="flex items-center gap-2">
            <Favicon {...logo} />
            <span className="text-foreground text-sm font-medium">{logo.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── verdict (Choose X if / Choose Kortix if) ────────────────────────────── */

function VerdictBlock({
  themLabel,
  them,
  kortix,
}: {
  themLabel: string;
  them: string;
  kortix: string;
}) {
  return (
    <div className="my-10 grid grid-cols-1 gap-4 md:grid-cols-2">
      <div className="border-border bg-card flex flex-col rounded-2xl border p-6">
        <span className="text-muted-foreground text-sm font-medium">Choose {themLabel} if…</span>
        <p className="text-foreground mt-3 text-base leading-relaxed">{renderInline(them)}</p>
      </div>
      <div className="border-kortix-green/30 bg-kortix-green/[0.06] flex flex-col rounded-2xl border p-6">
        <span className="text-foreground flex items-center gap-2 text-sm font-semibold">
          <span className="bg-kortix-green size-2 rounded-full" /> Choose Kortix if…
        </span>
        <p className="text-foreground mt-3 text-base leading-relaxed">{renderInline(kortix)}</p>
      </div>
    </div>
  );
}

/* ── compare matrix (reuses the comparison-page look) ────────────────────── */

function LeanMark({ side, lean }: { side: 'them' | 'kortix'; lean: RowLean }) {
  const on = lean === side || lean === 'both';
  if (side === 'kortix') {
    return on ? (
      <Check className="text-kortix-green mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
    ) : (
      <Minus className="text-background/40 mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
    );
  }
  return on ? (
    <Check className="text-muted-foreground mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
  ) : (
    <Minus className="text-muted-foreground/30 mt-0.5 size-4 shrink-0" strokeWidth={2.5} />
  );
}

function CompareBlock({ them, rows }: { them: string; rows: CompareRow[] }) {
  return (
    <div className="my-10 grid grid-cols-[1.2fr_1fr_1fr]">
      <div className="px-2.5 pb-4 sm:px-4" />
      <div className="flex items-end px-2.5 pb-4 sm:px-4">
        <span className="text-muted-foreground text-sm font-medium">{them}</span>
      </div>
      <div className="bg-foreground flex items-center gap-2 rounded-t-2xl px-2.5 pt-5 pb-4 sm:px-4">
        <KortixLogo size={15} variant="logomark" className="text-background" />
      </div>
      {rows.map((row, i) => {
        const lean = row.lean ?? 'kortix';
        const last = i === rows.length - 1;
        return (
          <Fragment key={row.dimension}>
            <div
              className={cn(
                'text-foreground flex items-start px-2.5 py-4 text-xs font-medium sm:px-4 sm:text-sm',
                !last && 'border-border border-b',
              )}
            >
              {row.dimension}
            </div>
            <div
              className={cn(
                'text-muted-foreground flex items-start gap-2 px-2.5 py-4 text-xs sm:px-4 sm:text-sm',
                !last && 'border-border border-b',
              )}
            >
              <LeanMark side="them" lean={lean} />
              <span>{row.them}</span>
            </div>
            <div
              className={cn(
                'bg-foreground text-background flex items-start gap-2 px-2.5 py-4 text-xs font-medium sm:px-4 sm:text-sm',
                last ? 'rounded-b-2xl' : 'border-background/15 border-b',
              )}
            >
              <LeanMark side="kortix" lean={lean} />
              <span>{row.kortix}</span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/* ── block renderer ──────────────────────────────────────────────────────── */

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'lead':
      return (
        <p className="text-foreground mb-8 text-xl leading-relaxed">{renderInline(block.text)}</p>
      );
    case 'h2':
      return (
        <h2 className="text-foreground mt-14 mb-4 text-2xl font-medium tracking-tight sm:text-3xl">
          {block.text}
        </h2>
      );
    case 'p':
      return (
        <p className="text-muted-foreground mb-5 text-base leading-relaxed sm:text-[1.0625rem]">
          {renderInline(block.text)}
        </p>
      );
    case 'ul':
      return (
        <ul className="mb-6 space-y-2.5">
          {block.items.map((item) => (
            <li
              key={item}
              className="text-muted-foreground flex gap-3 text-base leading-relaxed sm:text-[1.0625rem]"
            >
              <span className="bg-muted-foreground/40 mt-2.5 size-1.5 shrink-0 rounded-full" />
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <pre className="border-border bg-card my-8 overflow-x-auto rounded-2xl border p-5 font-mono text-xs leading-relaxed sm:text-sm">
          <code className="text-foreground/85">{block.code}</code>
        </pre>
      );
    case 'callout':
      return (
        <div className="border-l-primary bg-primary/[0.05] my-8 rounded-r-2xl border-l-2 py-4 pr-5 pl-5">
          <p className="text-foreground text-base leading-relaxed">{renderInline(block.text)}</p>
        </div>
      );
    case 'logos':
      return <LogosBlock label={block.label} items={block.items} />;
    case 'verdict':
      return <VerdictBlock themLabel={block.themLabel} them={block.them} kortix={block.kortix} />;
    case 'compare':
      return <CompareBlock them={block.them} rows={block.rows} />;
    case 'cta':
      return (
        <div className="border-border bg-card my-10 rounded-2xl border p-7 text-center">
          <h2 className="text-foreground text-xl font-medium tracking-tight sm:text-2xl">
            {block.title}
          </h2>
          {block.body && (
            <p className="text-muted-foreground mx-auto mt-3 max-w-md text-base leading-relaxed">
              {block.body}
            </p>
          )}
          <BlogCta />
        </div>
      );
  }
}

export function BlogContent({ blocks }: { blocks: Block[] }) {
  return (
    <div className="mt-10">
      {blocks.map((block, i) => (
        <BlockView key={`${block.type}:${i}`} block={block} />
      ))}
    </div>
  );
}

/* Tags helper reused by the post header. */
export function PostTags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <Badge key={tag} size="sm" variant="secondary">
          {tag}
        </Badge>
      ))}
    </div>
  );
}
