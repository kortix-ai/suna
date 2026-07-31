'use client';

import { cn } from '@/lib/utils';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useCallback, useState } from 'react';

/* ── tiny highlighter ──────────────────────────────────────────────────────
   A real grammar is overkill for two fixed snippets, and shipping a syntax
   library to the marketing page is not worth the bytes. These tokenizers cover
   exactly what the two examples contain. */

type Tok = { t: string; c?: string };

const TS_KEYWORDS = /^(import|from|const|await|new|return|type|export|async|function)$/;

function tokenizeTs(line: string): Tok[] {
  if (/^\s*\/\//.test(line)) return [{ t: line, c: 'comment' }];
  const out: Tok[] = [];
  // strings first so their contents are never re-tokenized
  const re = /('[^']*'|"[^"]*"|`[^`]*`)|(\b[A-Za-z_$][\w$]*\b)|(\s+)|([^\sA-Za-z_$]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const [raw, str, word, space, punct] = m;
    if (str) out.push({ t: raw, c: 'string' });
    else if (space) out.push({ t: raw });
    else if (punct) out.push({ t: raw, c: 'punct' });
    else if (word) {
      const after = line.slice(m.index + raw.length);
      if (TS_KEYWORDS.test(word)) out.push({ t: raw, c: 'keyword' });
      else if (/^\s*\(/.test(after)) out.push({ t: raw, c: 'fn' });
      else if (/^[A-Z]/.test(word)) out.push({ t: raw, c: 'type' });
      else out.push({ t: raw });
    }
  }
  return out;
}

function tokenizeShell(line: string): Tok[] {
  if (/^\s*#/.test(line)) return [{ t: line, c: 'comment' }];
  if (/^\s*[✓→]/.test(line)) return [{ t: line, c: 'ok' }];
  if (!line.startsWith('$')) return [{ t: line, c: 'comment' }];

  const out: Tok[] = [{ t: '$', c: 'prompt' }];
  const rest = line.slice(1);
  const re = /("[^"]*"|'[^']*')|(\s+)|(--?[\w-]+)|([^\s]+)/g;
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = re.exec(rest))) {
    const [raw, str, space, flag, word] = m;
    if (str) out.push({ t: raw, c: 'string' });
    else if (space) out.push({ t: raw });
    else if (flag) out.push({ t: raw, c: 'flag' });
    else if (word) {
      out.push({ t: raw, c: first ? 'cmd' : undefined });
      first = false;
    }
  }
  return out;
}

/* Light surface, not a black terminal: the page is light and a slab of near-black
   read as a hole in it. Hierarchy comes from weight and opacity, with one earned
   colour on success output — the brand is otherwise achromatic. */
const TOKEN_CLASS: Record<string, string> = {
  comment: 'text-muted-foreground/55',
  string: 'text-foreground/70',
  keyword: 'text-muted-foreground',
  fn: 'text-foreground font-medium',
  type: 'text-foreground/80',
  punct: 'text-muted-foreground/50',
  prompt: 'text-muted-foreground/35 select-none',
  cmd: 'text-foreground font-medium',
  flag: 'text-muted-foreground',
  ok: 'text-emerald-600 dark:text-emerald-400',
};

function CodeSurface({
  title,
  lines,
  lang,
  copyText,
  footer,
}: {
  title: string;
  lines: string[];
  lang: 'ts' | 'sh';
  copyText: string;
  footer?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(copyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [copyText]);

  const tokenize = lang === 'ts' ? tokenizeTs : tokenizeShell;

  return (
    <div className="bg-card flex h-full flex-col">
      {/* The three fake traffic lights are gone. They simulated a window this
          panel is not, and they cost a row of height in the one place the hero
          is trying to win height back for the recording. The bar itself stays,
          thinned from py-3 to py-2: it still carries the filename, which says
          what you are looking at, and the copy control, which is the only real
          affordance here. */}
      <div className="border-border flex items-center gap-3 border-b px-4 py-2">
        <span className="text-muted-foreground font-mono text-xs">{title}</span>

        <button
          type="button"
          onClick={copy}
          className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] border-border duration-fast ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors"
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* The snippet is longer and wider than a phone frame, and it always will
          be — it is real code, not a caption. So the panel is honest about it
          instead of pretending to fit: the type steps down at phone width to buy
          back about a quarter of both axes, and a mask fades the last pixels at
          the bottom and right edges. Without the mask the frame slices a line
          through its x-height and reads as a rendering bug; with it the same
          clip reads as "this continues", which is true, and is the cue to
          scroll. mask-composite intersects the two gradients so a corner fades
          once rather than twice. */}
      <div
        className={cn(
          'bg-background min-h-0 flex-1 overflow-auto px-4 py-3.5 sm:px-5 sm:py-4',
          '[mask-image:linear-gradient(to_bottom,#000_calc(100%-2rem),transparent),linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] [mask-composite:intersect]',
          'sm:[mask-image:none]',
        )}
      >
        <pre className="font-mono text-[10.5px] leading-[1.65] sm:text-[12.5px] sm:leading-[1.75]">
          <code>
            {lines.map((line, i) => (
              <div key={`${i}-${line}`} className="whitespace-pre">
                {line === ''
                  ? ' '
                  : tokenize(line).map((tok, j) => (
                      <span key={j} className={tok.c ? TOKEN_CLASS[tok.c] : 'text-foreground/85'}>
                        {tok.t}
                      </span>
                    ))}
              </div>
            ))}
          </code>
        </pre>
      </div>

      {footer ? (
        <div className="border-border bg-card border-t px-4 py-3">{footer}</div>
      ) : null}
    </div>
  );
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const CLI_LINES = [
  '$ curl -fsSL https://kortix.com/install | bash',
  '  ✓ Kortix CLI installed',
  '',
  '$ kortix init',
  '  ✓ wrote kortix.yaml, agents, skills',
  '',
  '$ kortix ship',
  '  ✓ pushed · live in the cloud',
  '',
  '$ kortix sessions new --prompt "Close the month"',
  '  → session/close-month · agent computer ready',
  '',
  '$ kortix cr ls',
  '  → 1 change request awaiting your review',
];

const CLI_COPY = `curl -fsSL https://kortix.com/install | bash
kortix init
kortix ship`;

export function CliSurface({ cta }: { cta?: React.ReactNode }) {
  return <CodeSurface title="kortix — terminal" lines={CLI_LINES} lang="sh" copyText={CLI_COPY} footer={cta} />;
}

/* ── SDK ─────────────────────────────────────────────────────────────────── */

const SDK_LINES = [
  "import { createKortix } from '@kortix/sdk';",
  '',
  'const kortix = createKortix({',
  "  backendUrl: 'https://api.kortix.com/v1',",
  '  getToken,',
  '});',
  '',
  '// one hook owns the whole session lifecycle',
  'const session = kortix.session(projectId, sessionId);',
  '',
  "await session.send('Draft the renewal for Northwind');",
  '',
  '// what it produced, and what it cost',
  'const previews = await session.previews();',
  'const cost = await session.cost();',
];

const SDK_COPY = SDK_LINES.filter((l) => !l.startsWith('//')).join('\n');

export function SdkSurface({ cta }: { cta?: React.ReactNode }) {
  return <CodeSurface title="renewal.ts" lines={SDK_LINES} lang="ts" copyText={SDK_COPY} footer={cta} />;
}

export function SurfaceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className={cn(
        'text-muted-foreground hover:text-foreground duration-fast inline-flex items-center gap-1.5',
        'font-mono text-[11px] transition-colors',
      )}
    >
      {children}
      <span aria-hidden>↗</span>
    </a>
  );
}
