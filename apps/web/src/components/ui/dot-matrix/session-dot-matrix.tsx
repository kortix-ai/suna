'use client';

/**
 * The session-keyed dot-matrix picker.
 *
 * Every session gets its own busy-indicator animation: the session_id is
 * hashed (FNV-1a) onto one of the variants below, so the choice is RANDOM
 * ACROSS SESSIONS but STABLE WITHIN one — the same session shows the same
 * matrix on every render, reload, and device, with no stored state and no
 * `Math.random()`. A new session rolls a new glyph simply by having a new id.
 *
 * `DOT_MATRIX_CATALOG` is the curated set of variants: the 3x3, circular,
 * and square families only — hex and triangle are intentionally out (they
 * read poorly at the 14px busy-indicator size) and must not be added back.
 * `/debug/dot-matrix` renders the full catalog; the live session pool is
 * the catalog filtered to `SESSION_DOT_MATRIX_FAMILIES`. Order changes
 * reshuffle which session gets which glyph (harmless — the mapping is
 * cosmetic), but keep new entries APPENDED inside their family so existing
 * sessions keep their glyph.
 *
 * `SessionDotMatrix` with no `sessionId` renders `DotmSquare14` — the
 * pre-existing default — so session-less surfaces (the home demo, the debug
 * harness) keep today's visual.
 */

import type { ComponentType } from 'react';

import type { DotMatrixCommonProps } from '@/lib/dotmatrix-core';
import { Dotm3x3_10 } from './dotm-3x3-10';
import { Dotm3x3_12 } from './dotm-3x3-12';
import { Dotm3x3_13 } from './dotm-3x3-13';
import { Dotm3x3_15 } from './dotm-3x3-15';
import { Dotm3x3_16 } from './dotm-3x3-16';
import { Dotm3x3_18 } from './dotm-3x3-18';
import { Dotm3x3_19 } from './dotm-3x3-19';
import { Dotm3x3_2 } from './dotm-3x3-2';
import { Dotm3x3_20 } from './dotm-3x3-20';
import { Dotm3x3_21 } from './dotm-3x3-21';
import { Dotm3x3_3 } from './dotm-3x3-3';
import { Dotm3x3_4 } from './dotm-3x3-4';
import { Dotm3x3_5 } from './dotm-3x3-5';
import { Dotm3x3_6 } from './dotm-3x3-6';
import { Dotm3x3_7 } from './dotm-3x3-7';
import { Dotm3x3_8 } from './dotm-3x3-8';
import { Dotm3x3_9 } from './dotm-3x3-9';
import { DotmCircular1 } from './dotm-circular-1';
import { DotmCircular10 } from './dotm-circular-10';
import { DotmCircular11 } from './dotm-circular-11';
import { DotmCircular12 } from './dotm-circular-12';
import { DotmCircular14 } from './dotm-circular-14';
import { DotmCircular15 } from './dotm-circular-15';
import { DotmCircular17 } from './dotm-circular-17';
import { DotmCircular2 } from './dotm-circular-2';
import { DotmCircular3 } from './dotm-circular-3';
import { DotmCircular4 } from './dotm-circular-4';
import { DotmCircular5 } from './dotm-circular-5';
import { DotmCircular6 } from './dotm-circular-6';
import { DotmCircular7 } from './dotm-circular-7';
import { DotmCircular8 } from './dotm-circular-8';
import { DotmCircular9 } from './dotm-circular-9';
import { DotmSquare1 } from './dotm-square-1';
import { DotmSquare10 } from './dotm-square-10';
import { DotmSquare11 } from './dotm-square-11';
import { DotmSquare12 } from './dotm-square-12';
import { DotmSquare13 } from './dotm-square-13';
import { DotmSquare14 } from './dotm-square-14';
import { DotmSquare15 } from './dotm-square-15';
import { DotmSquare16 } from './dotm-square-16';
import { DotmSquare17 } from './dotm-square-17';
import { DotmSquare18 } from './dotm-square-18';
import { DotmSquare19 } from './dotm-square-19';
import { DotmSquare2 } from './dotm-square-2';
import { DotmSquare20 } from './dotm-square-20';
import { DotmSquare3 } from './dotm-square-3';
import { DotmSquare4 } from './dotm-square-4';
import { DotmSquare5 } from './dotm-square-5';
import { DotmSquare6 } from './dotm-square-6';
import { DotmSquare7 } from './dotm-square-7';
import { DotmSquare8 } from './dotm-square-8';
import { DotmSquare9 } from './dotm-square-9';

export type DotMatrixFamily = '3x3' | 'circular' | 'square';

export type DotMatrixCatalogEntry = {
  name: string;
  family: DotMatrixFamily;
  Component: ComponentType<DotMatrixCommonProps>;
};

export const DOT_MATRIX_CATALOG: readonly DotMatrixCatalogEntry[] = [
  { name: 'dotm-3x3-2', family: '3x3', Component: Dotm3x3_2 },
  { name: 'dotm-3x3-3', family: '3x3', Component: Dotm3x3_3 },
  { name: 'dotm-3x3-4', family: '3x3', Component: Dotm3x3_4 },
  { name: 'dotm-3x3-5', family: '3x3', Component: Dotm3x3_5 },
  { name: 'dotm-3x3-6', family: '3x3', Component: Dotm3x3_6 },
  { name: 'dotm-3x3-7', family: '3x3', Component: Dotm3x3_7 },
  { name: 'dotm-3x3-8', family: '3x3', Component: Dotm3x3_8 },
  { name: 'dotm-3x3-9', family: '3x3', Component: Dotm3x3_9 },
  { name: 'dotm-3x3-10', family: '3x3', Component: Dotm3x3_10 },
  { name: 'dotm-3x3-12', family: '3x3', Component: Dotm3x3_12 },
  { name: 'dotm-3x3-13', family: '3x3', Component: Dotm3x3_13 },
  { name: 'dotm-3x3-15', family: '3x3', Component: Dotm3x3_15 },
  { name: 'dotm-3x3-16', family: '3x3', Component: Dotm3x3_16 },
  { name: 'dotm-3x3-18', family: '3x3', Component: Dotm3x3_18 },
  { name: 'dotm-3x3-19', family: '3x3', Component: Dotm3x3_19 },
  { name: 'dotm-3x3-20', family: '3x3', Component: Dotm3x3_20 },
  { name: 'dotm-3x3-21', family: '3x3', Component: Dotm3x3_21 },
  { name: 'dotm-circular-1', family: 'circular', Component: DotmCircular1 },
  { name: 'dotm-circular-2', family: 'circular', Component: DotmCircular2 },
  { name: 'dotm-circular-3', family: 'circular', Component: DotmCircular3 },
  { name: 'dotm-circular-4', family: 'circular', Component: DotmCircular4 },
  { name: 'dotm-circular-5', family: 'circular', Component: DotmCircular5 },
  { name: 'dotm-circular-6', family: 'circular', Component: DotmCircular6 },
  { name: 'dotm-circular-7', family: 'circular', Component: DotmCircular7 },
  { name: 'dotm-circular-8', family: 'circular', Component: DotmCircular8 },
  { name: 'dotm-circular-9', family: 'circular', Component: DotmCircular9 },
  { name: 'dotm-circular-10', family: 'circular', Component: DotmCircular10 },
  { name: 'dotm-circular-11', family: 'circular', Component: DotmCircular11 },
  { name: 'dotm-circular-12', family: 'circular', Component: DotmCircular12 },
  { name: 'dotm-circular-14', family: 'circular', Component: DotmCircular14 },
  { name: 'dotm-circular-15', family: 'circular', Component: DotmCircular15 },
  { name: 'dotm-circular-17', family: 'circular', Component: DotmCircular17 },
  { name: 'dotm-square-1', family: 'square', Component: DotmSquare1 },
  { name: 'dotm-square-2', family: 'square', Component: DotmSquare2 },
  { name: 'dotm-square-3', family: 'square', Component: DotmSquare3 },
  { name: 'dotm-square-4', family: 'square', Component: DotmSquare4 },
  { name: 'dotm-square-5', family: 'square', Component: DotmSquare5 },
  { name: 'dotm-square-6', family: 'square', Component: DotmSquare6 },
  { name: 'dotm-square-7', family: 'square', Component: DotmSquare7 },
  { name: 'dotm-square-8', family: 'square', Component: DotmSquare8 },
  { name: 'dotm-square-9', family: 'square', Component: DotmSquare9 },
  { name: 'dotm-square-10', family: 'square', Component: DotmSquare10 },
  { name: 'dotm-square-11', family: 'square', Component: DotmSquare11 },
  { name: 'dotm-square-12', family: 'square', Component: DotmSquare12 },
  { name: 'dotm-square-13', family: 'square', Component: DotmSquare13 },
  { name: 'dotm-square-14', family: 'square', Component: DotmSquare14 },
  { name: 'dotm-square-15', family: 'square', Component: DotmSquare15 },
  { name: 'dotm-square-16', family: 'square', Component: DotmSquare16 },
  { name: 'dotm-square-17', family: 'square', Component: DotmSquare17 },
  { name: 'dotm-square-18', family: 'square', Component: DotmSquare18 },
  { name: 'dotm-square-19', family: 'square', Component: DotmSquare19 },
  { name: 'dotm-square-20', family: 'square', Component: DotmSquare20 },
];

export const SESSION_DOT_MATRIX_FAMILIES: ReadonlySet<DotMatrixFamily> = new Set([
  '3x3',
  'circular',
  'square',
]);

export const SESSION_DOT_MATRIX_POOL: readonly DotMatrixCatalogEntry[] =
  DOT_MATRIX_CATALOG.filter((entry) => SESSION_DOT_MATRIX_FAMILIES.has(entry.family));

export const SESSION_DOT_MATRIX_VARIANTS: readonly ComponentType<DotMatrixCommonProps>[] =
  SESSION_DOT_MATRIX_POOL.map((entry) => entry.Component);

/**
 * FNV-1a over the session id, reduced onto the registry. Deterministic and
 * dependency-free; `Math.imul` keeps the multiply in 32-bit space and
 * `>>> 0` makes the result unsigned before the modulo.
 */
export function sessionDotMatrixIndex(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SESSION_DOT_MATRIX_VARIANTS.length;
}

export type SessionDotMatrixProps = DotMatrixCommonProps & {
  /** Picks the variant. Absent → `DotmSquare14`, the pre-existing default. */
  sessionId?: string;
};

/**
 * The 5x5 families (circular, square) default `dotSize` to 5 for their 36px
 * design size. At the 14px busy-indicator size that leaves 5px dots whose
 * grid overflows the box — far too heavy. When the caller sets `size`
 * without `dotSize`, derive the dot from the same 36:5 ratio the variants
 * were designed at (14 → 2, matching `DotmSquare14`'s hand-tuned values).
 * 3x3 variants size themselves from `dotSize` + `cellPadding` and never
 * overflow, so they pass through untouched.
 */
const FIVE_BY_FIVE_FAMILIES: ReadonlySet<DotMatrixFamily> = new Set(['circular', 'square']);
const FIVE_BY_FIVE_BASE_SIZE = 36;
const FIVE_BY_FIVE_BASE_DOT_SIZE = 5;

export function fiveByFiveDotSizeFor(size: number): number {
  return Math.max(1, Math.round((size * FIVE_BY_FIVE_BASE_DOT_SIZE) / FIVE_BY_FIVE_BASE_SIZE));
}

export function SessionDotMatrix({ sessionId, ...props }: SessionDotMatrixProps) {
  if (!sessionId) {
    return <DotmSquare14 {...props} />;
  }
  const { family, Component } = SESSION_DOT_MATRIX_POOL[sessionDotMatrixIndex(sessionId)]!;
  const dotSize =
    props.dotSize == null && props.size != null && FIVE_BY_FIVE_FAMILIES.has(family)
      ? fiveByFiveDotSizeFor(props.size)
      : props.dotSize;
  return <Component {...props} dotSize={dotSize} />;
}
