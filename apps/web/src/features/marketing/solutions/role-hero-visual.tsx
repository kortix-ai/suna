'use client';

import { EASE_OUT, LEAD, panel } from '@/features/marketing/component/hero-motion';
import { cn } from '@/lib/utils';
import { m, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import type { RoleArtifact, RoleContent } from './types';

/**
 * `/solutions/<role>` hero scene — what that role actually gets back.
 *
 * `types.ts` already says why this cannot be one shape: "engineering returns a
 * patch, finance returns a reconciliation, data science returns a query, and
 * the writing roles return a document. A shared shape would be the tell that
 * these pages are one template." So the hero renders the role's own
 * `output.artifact` and gets its layout from the artifact's `kind`.
 *
 * Eight roles, four layouts, eight different file paths and eight different
 * bodies — none of it authored here.
 *
 * Composition:
 *  - the specimen is cropped at the bottom by a mask, because it *is* an
 *    excerpt — the document continues past the frame;
 *  - a second sheet sits behind it, offset, standing for the session branch it
 *    came back on;
 *  - the caption is the content file's own, which always states this is an
 *    illustration.
 *
 * MOTION — one pass on mount, then rest.
 */

const NUMERIC = /^[+−-]?[\d,.]+%?$/;

function DiffBody({ artifact }: { artifact: Extract<RoleArtifact, { kind: 'diff' }> }): ReactNode {
  return (
    <pre className="font-mono text-[11.5px] leading-[1.85]">
      <code className="block">
        {artifact.lines.map((line, i) => {
          const sign = line.charAt(0);
          const add = sign === '+';
          const del = sign === '-';
          return (
            <span
              key={i}
              className={cn(
                'flex border-l-2 pr-4 whitespace-pre',
                add
                  ? 'border-foreground/30 bg-foreground/[0.05] text-foreground'
                  : del
                    ? 'bg-muted/60 text-muted-foreground/45 border-transparent'
                    : 'text-muted-foreground/70 border-transparent',
              )}
            >
              <span aria-hidden className="w-6 shrink-0 pl-3 opacity-60 select-none">
                {add ? '+' : del ? '−' : ' '}
              </span>
              <span className="truncate">{line.slice(1) || ' '}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function TableBody({
  artifact,
}: {
  artifact: Extract<RoleArtifact, { kind: 'table' }>;
}): ReactNode {
  return (
    <table className="w-full table-fixed border-collapse text-left">
      <thead>
        <tr className="border-border/60 border-b">
          {artifact.columns.map((column, i) => (
            <th
              key={column}
              style={{ width: artifact.widths[i] }}
              className="text-muted-foreground/50 px-3 py-2 font-mono text-[10px] font-normal tracking-widest uppercase"
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {artifact.rows.map((row, r) => (
          <tr key={r} className="border-border/30 border-b last:border-b-0">
            {row.cells.map((cell, c) => (
              <td
                key={c}
                className={cn(
                  'truncate px-3 py-2 text-[11.5px]',
                  NUMERIC.test(cell)
                    ? 'text-foreground/85 text-right font-mono tabular-nums'
                    : c === 0
                      ? 'text-foreground'
                      : 'text-muted-foreground/65',
                )}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DocBody({ artifact }: { artifact: Extract<RoleArtifact, { kind: 'doc' }> }): ReactNode {
  return (
    <>
      <p className="text-foreground px-4 pt-3.5 text-[15px] leading-snug font-medium text-pretty">
        {artifact.title}
      </p>
      <dl className="border-border/40 mt-3.5 grid grid-cols-2 gap-x-5 gap-y-2 border-y px-4 py-3">
        {artifact.meta.map((field) => (
          <div key={field.k} className="flex min-w-0 items-baseline gap-2">
            <dt className="text-muted-foreground/45 shrink-0 font-mono text-[10px] tracking-wider uppercase">
              {field.k}
            </dt>
            <dd className="text-foreground/80 truncate font-mono text-[10.5px]">{field.v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-col gap-2.5 px-4 py-3.5">
        {artifact.lines.map((line, i) => (
          <p key={i} className="text-muted-foreground/70 text-[12px] leading-relaxed text-pretty">
            {line}
          </p>
        ))}
      </div>
    </>
  );
}

function CodeBody({ artifact }: { artifact: Extract<RoleArtifact, { kind: 'code' }> }): ReactNode {
  const comment = artifact.lang === 'sql' ? '--' : '#';
  return (
    <div className="py-2.5">
      {artifact.lines.map((line, i) => (
        <div
          key={i}
          className="flex items-start gap-3 px-4 font-mono text-[11.5px] leading-[1.75] whitespace-pre"
        >
          <span className="text-muted-foreground/20 w-4 shrink-0 text-right tabular-nums select-none">
            {i + 1}
          </span>
          <span
            className={cn(
              'truncate',
              line.trimStart().startsWith(comment)
                ? 'text-muted-foreground/40'
                : 'text-foreground/85',
            )}
          >
            {line || ' '}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The badge in the chrome names the object, so the shape is never a mystery. */
const KIND_LABEL: Record<RoleArtifact['kind'], string> = {
  diff: 'patch',
  table: 'table',
  doc: 'document',
  code: 'query',
};

export function RoleHeroVisual({ role }: { role: RoleContent }): ReactNode {
  const reduceMotion = useReducedMotion() ?? false;
  const artifact = role.output.artifact;

  return (
    <div
      className="flex w-full items-center justify-center"
      role="img"
      aria-label={`A specimen of what ${role.name} gets back: ${artifact.file}. ${role.output.caption}`}
    >
      <div className="relative h-[24rem] w-full max-w-[38rem] sm:h-[27rem]">
        {/* ── the branch it came back on ──────────────────────────────── */}
        <m.span
          className="border-border/50 bg-card/40 absolute top-[2%] right-[1%] bottom-[16%] left-[9%] rounded-xl border"
          initial={reduceMotion ? false : { opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.44, delay: 0.06, ease: EASE_OUT }}
          aria-hidden
        />

        {/* ── the specimen ────────────────────────────────────────────── */}
        <m.div
          className="border-border/70 bg-card absolute top-[7%] right-[8%] bottom-[9%] left-[1%] flex flex-col overflow-hidden rounded-xl border"
          {...panel(reduceMotion)}
        >
          <div className="border-border/60 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5">
            <m.span
              className="text-muted-foreground/70 truncate font-mono text-[11px]"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, delay: LEAD, ease: EASE_OUT }}
            >
              {artifact.file}
            </m.span>
            <m.span
              className="border-border text-muted-foreground/55 shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-widest uppercase"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, delay: LEAD + 0.06, ease: EASE_OUT }}
            >
              {artifact.kind === 'diff' ? artifact.stat : KIND_LABEL[artifact.kind]}
            </m.span>
          </div>

          {/* The specimen is an excerpt, so it is cropped rather than fitted. */}
          <m.div
            className="min-h-0 flex-1 overflow-hidden mask-b-from-78% mask-b-to-100%"
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: LEAD + 0.12, ease: EASE_OUT }}
          >
            {artifact.kind === 'diff' ? <DiffBody artifact={artifact} /> : null}
            {artifact.kind === 'table' ? <TableBody artifact={artifact} /> : null}
            {artifact.kind === 'doc' ? <DocBody artifact={artifact} /> : null}
            {artifact.kind === 'code' ? <CodeBody artifact={artifact} /> : null}
          </m.div>
        </m.div>

        {/* ── the content file's own caption ──────────────────────────── */}
        <m.span
          className="text-muted-foreground/40 absolute right-[8%] bottom-[1%] left-[1%] truncate text-[10.5px]"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: LEAD + 0.5, ease: EASE_OUT }}
        >
          {role.output.caption}
        </m.span>
      </div>
    </div>
  );
}
