import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  DOT_MATRIX_CATALOG,
  SESSION_DOT_MATRIX_FAMILIES,
  SESSION_DOT_MATRIX_POOL,
  SESSION_DOT_MATRIX_VARIANTS,
  SessionDotMatrix,
  sessionDotMatrixIndex,
} from './session-dot-matrix';

describe('DOT_MATRIX_CATALOG', () => {
  test('holds only the curated 3x3/circular/square families, uniquely named', () => {
    const names = DOT_MATRIX_CATALOG.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    const count = (family: string) =>
      DOT_MATRIX_CATALOG.filter((entry) => entry.family === family).length;
    expect(count('3x3')).toBe(17);
    expect(count('circular')).toBe(15);
    expect(count('square')).toBe(20);
    expect(DOT_MATRIX_CATALOG).toHaveLength(52);
  });

  test('every catalog entry server-renders', () => {
    for (const { name, Component } of DOT_MATRIX_CATALOG) {
      const html = renderToStaticMarkup(<Component size={32} />);
      expect({ name, renders: html.length > 20 }).toEqual({ name, renders: true });
    }
  });
});

describe('SESSION_DOT_MATRIX_VARIANTS', () => {
  test('the live pool is the catalog filtered to the session families, in catalog order', () => {
    expect(SESSION_DOT_MATRIX_POOL).toEqual(
      DOT_MATRIX_CATALOG.filter((entry) => SESSION_DOT_MATRIX_FAMILIES.has(entry.family)),
    );
    expect(SESSION_DOT_MATRIX_VARIANTS).toEqual(
      SESSION_DOT_MATRIX_POOL.map((entry) => entry.Component),
    );
  });

  test('the registry is a real pool — many variants, every entry a component, no duplicates', () => {
    expect(SESSION_DOT_MATRIX_VARIANTS.length).toBeGreaterThanOrEqual(50);
    for (const variant of SESSION_DOT_MATRIX_VARIANTS) {
      expect(typeof variant).toBe('function');
    }
    // A duplicate entry silently doubles one glyph's share of sessions.
    expect(new Set(SESSION_DOT_MATRIX_VARIANTS).size).toBe(SESSION_DOT_MATRIX_VARIANTS.length);
  });

  test('every variant server-renders at the indicator size', () => {
    // The busy indicator is SSRed by Next like any client component, so a
    // variant that throws under renderToStaticMarkup is a 500 on the session
    // page for every session that hashes onto it — the worst kind of rare.
    for (const [i, Variant] of SESSION_DOT_MATRIX_VARIANTS.entries()) {
      const html = renderToStaticMarkup(<Variant size={14} />);
      expect({ variant: i, renders: html.length > 20 }).toEqual({ variant: i, renders: true });
    }
  });

  test('no sessionId falls back to the pre-existing default glyph', () => {
    const html = renderToStaticMarkup(<SessionDotMatrix size={14} />);
    expect(html.length).toBeGreaterThan(20);
  });

  test('renders only the glyph — no debug text alongside it', () => {
    const sample = renderToStaticMarkup(<SessionDotMatrix sessionId="ses_weight" size={14} />);
    // Everything visible is aria-hidden dots; any bare text is a leftover.
    expect(sample).not.toMatch(/>[A-Za-z]/);
  });

  test('5x5 variants scale dot weight to the 14px indicator instead of keeping 36px-design 5px dots', () => {
    // Find one session id per 5x5 family; the pool is family-ordered so the
    // hash only needs to land in that family's index range.
    for (const family of ['circular', 'square'] as const) {
      const indexes = SESSION_DOT_MATRIX_POOL.flatMap((entry, i) =>
        entry.family === family ? [i] : [],
      );
      let id = '';
      for (let i = 0; i < 5000 && !id; i += 1) {
        if (indexes.includes(sessionDotMatrixIndex(`ses_${family}_${i}`))) {
          id = `ses_${family}_${i}`;
        }
      }
      expect(id).not.toBe('');
      const html = renderToStaticMarkup(<SessionDotMatrix sessionId={id} size={14} />);
      expect(html).toContain('width:2px');
      expect(html).not.toContain('width:5px');
    }
  });
});

describe('sessionDotMatrixIndex', () => {
  test('deterministic — the same session id always lands on the same variant', () => {
    for (const id of ['ses_01J8...', 'a', '', '0f7c2a1e-4b9d-4e8a-9c3d-2f1e0a9b8c7d']) {
      expect(sessionDotMatrixIndex(id)).toBe(sessionDotMatrixIndex(id));
    }
  });

  test('always in range', () => {
    for (let i = 0; i < 200; i += 1) {
      const index = sessionDotMatrixIndex(`session-${i}`);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(SESSION_DOT_MATRIX_VARIANTS.length);
    }
  });

  test('spreads sessions across the pool instead of clumping', () => {
    // 200 realistic ids must reach a healthy share of a ~50-variant pool.
    // The bound is loose on purpose — this pins "the hash actually varies",
    // not a specific distribution.
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(sessionDotMatrixIndex(`0f7c2a1e-4b9d-4e8a-9c3d-${String(i).padStart(12, '0')}`));
    }
    expect(seen.size).toBeGreaterThan(SESSION_DOT_MATRIX_VARIANTS.length / 3);
  });

  test('near-identical ids diverge — one changed character moves the glyph', () => {
    // FNV-1a's whole job here: session ids often share long prefixes.
    const a = sessionDotMatrixIndex('ses_0000000000000001');
    const b = sessionDotMatrixIndex('ses_0000000000000002');
    const c = sessionDotMatrixIndex('ses_0000000000000003');
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });
});
