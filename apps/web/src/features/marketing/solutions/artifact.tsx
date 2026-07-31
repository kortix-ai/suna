import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { Eyebrow } from './shared';
import type { RoleArtifact } from './types';

/**
 * The specimen output on a role page.
 *
 * Achromatic by default. A diff is the one place colour is earned — an addition
 * and a deletion are opposite facts, and the sign alone is not enough at this
 * size. Everything else is border, mono and muted text.
 */

function Frame({
  file,
  label,
  children,
}: {
  file: string;
  label: string;
  children: ReactNode;
}): ReactNode {
  // `min-w-0` is load-bearing: this frame is a grid item, and a grid item
  // defaults to `min-width: auto`, so it would size to the widest unbreakable
  // child — the `min-w-max` <pre> or the `min-w-[34rem]` table — and push the
  // page into horizontal scroll at 390px instead of scrolling inside its own
  // `overflow-x-auto` container.
  return (
    <div className="border-border bg-card min-w-0 overflow-hidden rounded-sm border">
      <div className="border-border/70 flex min-w-0 items-center justify-between gap-4 border-b px-4 py-3 sm:px-5">
        <span className="text-foreground truncate font-mono text-[11.5px]">{file}</span>
        <Eyebrow className="shrink-0">{label}</Eyebrow>
      </div>
      {children}
    </div>
  );
}

function DiffBody({ lines, stat }: { lines: readonly string[]; stat: string }): ReactNode {
  return (
    <>
      <div className="overflow-x-auto">
        <pre className="min-w-max px-4 py-4 font-mono text-[11.5px] leading-relaxed sm:px-5">
          {lines.map((line, i) => {
            const added = line.startsWith('+');
            const removed = line.startsWith('-');
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and may repeat verbatim
                key={`${i}-${line}`}
                className={cn(
                  'px-1',
                  added && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
                  removed && 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
                  !added && !removed && 'text-muted-foreground',
                )}
              >
                {line || ' '}
              </div>
            );
          })}
        </pre>
      </div>
      <div className="border-border/70 border-t px-4 py-3 sm:px-5">
        <Eyebrow>{stat}</Eyebrow>
      </div>
    </>
  );
}

function CodeBody({ lines }: { lines: readonly string[] }): ReactNode {
  return (
    <div className="overflow-x-auto">
      <pre className="text-muted-foreground min-w-max px-4 py-4 font-mono text-[11.5px] leading-relaxed sm:px-5">
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: source lines are positional and may repeat verbatim
          <div key={`${i}-${line}`}>{line || ' '}</div>
        ))}
      </pre>
    </div>
  );
}

function TableBody({
  columns,
  widths,
  rows,
}: {
  columns: readonly string[];
  widths: readonly string[];
  rows: readonly { readonly cells: readonly string[] }[];
}): ReactNode {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse font-mono text-[11.5px]">
        <thead>
          <tr className="border-border/70 border-b">
            {columns.map((column, i) => (
              <th
                key={column}
                style={{ width: widths[i] }}
                className="text-muted-foreground px-4 py-3 text-left text-[10px] font-normal tracking-widest uppercase sm:px-5"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.cells.join('|')} className="border-border/50 border-b last:border-b-0">
              {row.cells.map((cell, i) => (
                <td
                  key={`${row.cells[0]}-${columns[i]}`}
                  className={cn(
                    'px-4 py-2.5 sm:px-5',
                    i === 0 ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocBody({
  title,
  meta,
  lines,
}: {
  title: string;
  meta: readonly { readonly k: string; readonly v: string }[];
  lines: readonly string[];
}): ReactNode {
  return (
    <div className="min-w-0 px-4 py-5 sm:px-5 sm:py-6">
      <h4 className="text-foreground text-base leading-tight font-medium">{title}</h4>
      <dl className="border-border/70 mt-4 grid gap-x-8 gap-y-2 border-t pt-4 sm:grid-cols-2">
        {meta.map((item) => (
          <div key={item.k} className="flex min-w-0 items-baseline gap-2">
            <dt className="text-muted-foreground shrink-0 font-mono text-[10px] tracking-widest uppercase">
              {item.k}
            </dt>
            <dd className="text-foreground min-w-0 truncate font-mono text-[11.5px]">{item.v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 space-y-2">
        {lines.map((line) => (
          <p key={line} className="text-muted-foreground text-sm leading-relaxed">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

const LABEL: Record<RoleArtifact['kind'], string> = {
  diff: 'Change request',
  table: 'Report',
  doc: 'Document',
  code: 'Source',
};

export function ArtifactPanel({ artifact }: { artifact: RoleArtifact }): ReactNode {
  return (
    <Frame file={artifact.file} label={LABEL[artifact.kind]}>
      {artifact.kind === 'diff' ? (
        <DiffBody lines={artifact.lines} stat={artifact.stat} />
      ) : artifact.kind === 'code' ? (
        <CodeBody lines={artifact.lines} />
      ) : artifact.kind === 'table' ? (
        <TableBody columns={artifact.columns} widths={artifact.widths} rows={artifact.rows} />
      ) : (
        <DocBody title={artifact.title} meta={artifact.meta} lines={artifact.lines} />
      )}
    </Frame>
  );
}
