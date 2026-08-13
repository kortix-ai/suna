'use client';

import {
  DOT_MATRIX_CATALOG,
  SESSION_DOT_MATRIX_FAMILIES,
  type DotMatrixFamily,
} from '@/components/ui/dot-matrix/session-dot-matrix';

/**
 * /debug/dot-matrix
 *
 * Visual catalog of every cataloged busy-indicator glyph, grouped by family
 * and named by filename stem.
 *
 * Not linked from anywhere — just hit /debug/dot-matrix.
 */

const FAMILY_LABEL: Record<DotMatrixFamily, string> = {
  '3x3': '3×3',
  circular: 'Circular',
  square: 'Square',
};

export default function DebugDotMatrixPage() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-10 px-4 py-10">
      <header className="space-y-1">
        <h1 className="text-foreground text-xl font-medium">Dot matrix</h1>
        <p className="text-muted-foreground text-sm">
          Every variant, named. Sessions use 3×3, circular, and square at 14px.
        </p>
      </header>

      {(Object.entries(FAMILY_LABEL) as [DotMatrixFamily, string][]).map(([id, label]) => {
        const entries = DOT_MATRIX_CATALOG.filter((entry) => entry.family === id);
        const inSessionPool = SESSION_DOT_MATRIX_FAMILIES.has(id);
        return (
          <section key={id} className="space-y-3">
            <div className="space-y-0.5">
              <h2 className="text-foreground text-sm font-medium">
                {label}{' '}
                <span className="text-muted-foreground font-normal tabular-nums">
                  {entries.length}
                </span>
              </h2>
              {inSessionPool ? null : (
                <p className="text-muted-foreground/60 text-xs">Not in the live session pool.</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {entries.map(({ name, Component }) => (
                <div
                  key={name}
                  className="bg-popover flex flex-col items-center gap-3 rounded-md border px-3 py-4"
                >
                  <Component size={32} />
                  <span className="text-muted-foreground text-center font-mono text-[11px] leading-tight">
                    {name}
                  </span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
