'use client';

import { Children, cloneElement, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';

import ReactMarkdown from 'react-markdown';

import { YamlLine } from '@/features/marketing/code-panel';
import { useTranslations } from '@/i18n/use-translations';
import { cn, faviconUrlForHostname } from '@kortix/ui';
import { Bubble, BubbleContent } from '@kortix/ui/bubble';
import { Button } from '@kortix/ui/button';
import { CopyButton } from '@kortix/ui/markdown/copy-button';
import { PixelKortixMark } from '@kortix/ui/pixel-kortix-mark';
import { Stepper, StepperIndicator, StepperItem, StepperSeparator } from '@kortix/ui/stepper';

/**
 * Case-study MDX kit. Presentational blocks authors compose inside a use-case
 * `.mdx` to tell the story: problem → build → proof. Built to the Buio
 * marketing language: no boxes, no radius, no fills. Structure comes from
 * hairlines in `border-border`, and every block uses the two text colours
 * only. Each root resets the inherited <BlogProse> spacing it owns.
 */

// Neutralize BlogProse's `[&_p]:my-5` inside our own blocks and control spacing.
const proseReset = '[&_p]:!my-0 [&_p+p]:!mt-3 [&_ul]:!my-3 [&_ol]:!my-3 [&_li]:!pl-1';

/** "At a glance" fact sheet: a row of label / value pairs between two
 * hairlines. Compose with <Fact label="…">value</Fact>. */
export function KeyFacts({ children }: { children: ReactNode }) {
  return (
    <dl className="border-border my-10 grid grid-cols-2 border-y sm:grid-cols-4">{children}</dl>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-6 pr-6">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className={cn('text-foreground mt-1 text-base font-medium text-pretty', proseReset)}>
        {children}
      </dd>
    </div>
  );
}

/** Emphasis for a key point or aside: a 1px ink rule on the left. `tone` is
 * kept for existing content and no longer changes the look. */
export function Callout({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
  tone?: 'neutral' | 'accent';
}) {
  return (
    <aside className={cn('border-foreground my-10 border-l pl-6', proseReset)}>
      {title ? <p className="text-foreground !mb-2 text-base font-medium">{title}</p> : null}
      <div className="text-muted-foreground">{children}</div>
    </aside>
  );
}

/** Numbered step-by-step on the vertical `Stepper`: a numbered indicator, a
 * rail down to the next step, then the step's title and body. Wrap
 * <Step title="…"> items; numbering is automatic. A step body can hold a
 * <CopyBlock>, <ToolList> or <ExampleRun>. */
export function Steps({ children }: { children: ReactNode }) {
  const steps = Children.toArray(children).filter(isValidElement);
  return (
    <Stepper orientation="vertical" value={0} count={steps.length} className="my-10 w-full">
      {steps.map((child, i) =>
        cloneElement(child as any, { number: i + 1, key: (child as any).key ?? i }),
      )}
    </Stepper>
  );
}

export function Step({
  title,
  children,
  number = 1,
}: {
  title: string;
  children: ReactNode;
  number?: number;
}) {
  return (
    <StepperItem step={number} className="!flex-row !items-stretch gap-4">
      <div className="flex flex-col items-center">
        <StepperIndicator className="tabular-nums">{number}</StepperIndicator>
        <StepperSeparator className="bg-border my-2" />
      </div>
      <div className="min-w-0 flex-1 pb-10 group-last/step:pb-0">
        <h3 className="text-foreground !m-0 !text-base leading-6 font-medium">{title}</h3>
        <div className={cn('text-muted-foreground mt-2', proseReset)}>{children}</div>
      </div>
    </StepperItem>
  );
}

/** The frame every guide block shares: a hairline box, a bar with the title
 * on the left and an optional action on the right, then the body. */
function GuideFrame({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="bg-background border-border border !my-6 overflow-hidden rounded-lg">
      <div className="border-border flex min-h-9 items-center justify-between gap-3 border-b py-1 pr-1.5 pl-4">
        <figcaption className="text-muted-foreground truncate font-mono text-xs">{title}</figcaption>
        {action}
      </div>
      {children}
    </figure>
  );
}

/** A block the reader copies. A prompt (`lang="text"`, the default) renders
 * as a card with `title` ("Setup prompt") and Copy prompt in its header. A
 * config file (`lang="yaml"`) keeps its lines in a titled frame. Pass the
 * text as `code`. */
export function CopyBlock({
  title,
  code,
  lang = 'text',
}: {
  title: string;
  code: string;
  lang?: 'text' | 'yaml';
}) {
  const text = code.trim();
  // MDX collapses the leading spaces of lines inside a `code={`…`}` attribute,
  // so a rule bullet written as "   - " arrives as " - " and drops out of its
  // numbered step. Put any indented bullet back under the step.
  if (lang === 'text')
    return <PromptComposer hint={title} text={text.replace(/^ {1,3}- /gm, '   - ')} />;
  return (
    <GuideFrame
      title={title}
      action={<CopyButton code={text} label={`Copy ${title}`} size="sm" hintSide="top" />}
    >
      <pre className="!m-0 !rounded-none !border-0 !bg-transparent !px-4 !py-3 font-mono !text-xs leading-6">
        <code>
          {text.split('\n').map((line, i) => (
            // Fixed snippet: the index is the identity of the line.
            <span key={i} className="block min-w-max whitespace-pre">
              {line === '' ? ' ' : <YamlLine line={line} />}
            </span>
          ))}
        </code>
      </pre>
    </GuideFrame>
  );
}

const COPIED_MS = 1500;

/** A prompt on a bordered card: a header bar with
 * the block's name (`hint`, e.g. "Setup prompt") and Copy prompt, then the
 * text. */
function PromptComposer({ hint, text }: { hint: string; text: string }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // No clipboard permission: nothing was copied, so claim nothing.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <figure className="bg-background border-border border !my-6 flex flex-col overflow-hidden rounded-lg">
      <figcaption className="border-border flex items-center justify-between gap-3 border-b py-2 pr-2 pl-4">
        <span className="text-foreground min-w-0 truncate text-sm font-medium">{hint}</span>
        <Button type="button" size="sm" onClick={onCopy}>
          {copied ? t.raw('text8d525e5f158b') : t.raw('text18e8185e96b0')}
        </Button>
      </figcaption>
      {/* Plain Markdown (numbered steps, nested rule lists), styled by the
          page's prose; Copy prompt still copies the raw text. Not
          UnifiedMarkdown: it turns paths into chat file-preview buttons. */}
      <div
        className={cn(
          'text-foreground p-4 text-sm',
          '[&_p]:!my-0 [&_p+p]:!mt-3 [&_ol]:!my-3 [&_ol]:!pl-5 [&_ul]:!my-1.5 [&_ul]:!pl-5',
          '[&_li]:!font-normal [&_li]:!leading-relaxed [&_ol>li+li]:!mt-2',
        )}
      >
        <ReactMarkdown>{text}</ReactMarkdown>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? t.raw('text8d525e5f158b') : ''}
      </span>
    </figure>
  );
}

// Google serves one generic "G" favicon for all its products, so Gmail,
// Drive, Docs and the rest use Google's own product icons instead.
const GOOGLE_PRODUCT: Record<string, string> = {
  'gmail.com': 'gmail',
  'mail.google.com': 'gmail',
  'drive.google.com': 'drive',
  'docs.google.com': 'docs',
  'sheets.google.com': 'sheets',
  'calendar.google.com': 'calendar',
  'slides.google.com': 'slides',
  'meet.google.com': 'meet',
};

function logoUrl(domain: string): string {
  const product = GOOGLE_PRODUCT[domain];
  return product
    ? `https://ssl.gstatic.com/images/branding/product/2x/${product}_2020q4_48dp.png`
    : faviconUrlForHostname(domain);
}

/** The tools a use case needs, one row each: the app the template uses, what
 * it does there, whether it is required, and the apps that can stand in for
 * it. Compose with
 * <ToolList><ToolNeed name="HubSpot" domain="hubspot.com" tag="Required"
 * alternatives={[['Salesforce', 'salesforce.com']]}>what it does</ToolNeed></ToolList>.
 * `domain` is the app's public site; the row shows its favicon. */
export function ToolList({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background border-border border divide-border !my-6 divide-y overflow-hidden rounded-lg">
      {children}
    </div>
  );
}

export function ToolNeed({
  name,
  domain,
  tag,
  alternatives = [],
  children,
}: {
  name: string;
  domain: string;
  tag?: string;
  /** [name, domain] pairs. */
  alternatives?: Array<[string, string]>;
  children: ReactNode;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="flex items-start gap-3.5 p-4">
      <span className="bg-muted flex size-11 shrink-0 items-center justify-center rounded-md">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl(domain)} alt="" className="!m-0 size-6 !rounded-none" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-foreground text-sm font-medium">{name}</span>
        <div className={cn('text-muted-foreground text-xs', proseReset)}>{children}</div>
        {alternatives.length > 0 ? (
          <div className="flex items-center gap-2.5 pt-2">
            <span className="text-muted-foreground text-xs">{t.raw('text0c62d1af38c5')}</span>
            {alternatives.map(([altName, altDomain]) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={altDomain}
                src={logoUrl(altDomain)}
                alt={altName}
                title={altName}
                className="!m-0 size-5 !rounded-none"
              />
            ))}
          </div>
        ) : null}
      </div>
      {tag ? <span className="text-muted-foreground shrink-0 pt-0.5 text-xs">{tag}</span> : null}
    </div>
  );
}

/** A mock session: the message that starts the run, the tool calls the agent
 * makes, and its reply (`children`). It is an illustration, so `note` says
 * so under the frame. */
export function ExampleRun({
  title,
  message,
  worked,
  tools,
  note,
  children,
}: {
  title: string;
  message: string;
  worked: string;
  tools: string[];
  note: string;
  children: ReactNode;
}) {
  return (
    <div className="!my-6">
      <GuideFrame title={title}>
        <div className="flex flex-col gap-5 px-4 py-5">
          <Bubble align="end">
            <BubbleContent className="font-normal">{message}</BubbleContent>
          </Bubble>
          <div>
            <div className="text-muted-foreground text-xs">{worked}</div>
            <div className="border-border mt-2 flex flex-col gap-1.5 border-l pl-3">
              {tools.map((tool) => (
                <span key={tool} className="text-muted-foreground font-mono text-xs">
                  {tool}
                </span>
              ))}
            </div>
          </div>
          <div className="flex gap-3">
            <PixelKortixMark aria-hidden className="text-foreground mt-1 size-4 shrink-0" />
            <div className={cn('text-foreground min-w-0 text-sm leading-6', proseReset)}>
              {children}
            </div>
          </div>
        </div>
      </GuideFrame>
      <div className="text-muted-foreground mt-2 text-xs">{note}</div>
    </div>
  );
}

/** A framed screenshot / photo with a caption. Falls back to a labelled
 * placeholder frame when `src` is absent, so the layout reads as intentional
 * before real assets are captured. Drop images under /public and pass the path. */
export function Figure({
  src,
  alt,
  caption,
  aspect = '16/9',
}: {
  src?: string;
  alt?: string;
  caption?: string;
  aspect?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <figure className="my-10">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt ?? caption ?? ''}
          loading="lazy"
          className="border-border !my-0 w-full !rounded-none border"
        />
      ) : (
        <div
          className="bg-muted text-muted-foreground flex items-center justify-center text-sm"
          style={{ aspectRatio: aspect }}
        >
          {caption
            ? tI18nComplete('text9b1a9ce91460', { value0: caption })
            : tI18nComplete.raw('text907c7115cf85')}
        </div>
      )}
      {caption ? (
        <figcaption className="text-muted-foreground mt-3 text-sm">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

/** Outcome figures in a hairline row. Compose with <Stat value="…" label="…" />. */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="border-border my-10 grid grid-cols-1 border-t sm:grid-cols-3">{children}</dl>
  );
}

export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col py-6 pr-6">
      <dt className="text-muted-foreground mt-2 text-sm text-pretty">{label}</dt>
      <dd className="text-foreground order-first text-2xl font-medium tracking-tight">
        {value}
      </dd>
    </div>
  );
}

/** Large pull quote to break up the read and land the key line. */
export function PullQuote({ children }: { children: ReactNode }) {
  return (
    <blockquote className="my-12 !border-l-0 !pl-0">
      <p className="text-foreground text-xl font-medium tracking-tight text-balance !not-italic md:text-2xl">
        {children}
      </p>
    </blockquote>
  );
}
