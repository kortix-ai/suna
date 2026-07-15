import { describe, expect, it, test } from 'bun:test';
import type { OutputItem } from './derive-panels';
import { deliverableKindLabel, selectPrimaryDeliverable, sortOutputs } from './output-priority';

/** A file output — never an app, which lives in its own card and is never sorted here. */
type FileKind = Exclude<OutputItem['kind'], 'app'>;

function file(name: string, kind: FileKind = 'file'): OutputItem {
  return { callID: `c-${name}`, name, path: `/w/${name}`, kind } as OutputItem;
}

const names = (outputs: OutputItem[]) => outputs.map((o) => o.name);

describe('sortOutputs', () => {
  it('puts what the user asked for above what it took to build it', () => {
    // Exactly the shape of the reported run: five deliverables, buried under a
    // dozen source files the user never asked to see.
    const sorted = sortOutputs([
      file('globals.css'),
      file('layout.tsx'),
      file('Navbar.tsx'),
      file('profile.csv'),
      file('profile.pptx'),
      file('profile.pdf'),
      file('hero.png', 'image'),
      file('profile.xlsx'),
      file('profile.docx'),
      file('page.tsx'),
    ]);

    expect(names(sorted)).toEqual([
      'profile.pdf',
      'profile.xlsx',
      'profile.csv',
      'profile.docx',
      'profile.pptx',
      'hero.png',
      'globals.css',
      'layout.tsx',
      'Navbar.tsx',
      'page.tsx',
    ]);
  });

  it('ranks the document family in the order a person values it', () => {
    const sorted = sortOutputs([
      file('d.pptx'),
      file('c.docx'),
      file('b.xlsx'),
      file('a.pdf'),
    ]);
    expect(names(sorted)).toEqual(['a.pdf', 'b.xlsx', 'c.docx', 'd.pptx']);
  });

  it('puts images above source files but below documents', () => {
    const sorted = sortOutputs([file('app.tsx'), file('shot.png', 'image'), file('r.pdf')]);
    expect(names(sorted)).toEqual(['r.pdf', 'shot.png', 'app.tsx']);
  });

  it('ranks an HTML page above source code and images, but below a PDF', () => {
    const sorted = sortOutputs([
      file('main.ts'),
      file('hero.png', 'image'),
      file('index.html'),
      file('report.pdf'),
    ]);
    expect(names(sorted)).toEqual(['report.pdf', 'index.html', 'hero.png', 'main.ts']);
  });

  it('is stable — equal-rank files keep the order the agent made them in', () => {
    const sorted = sortOutputs([
      file('one.tsx'),
      file('two.tsx'),
      file('three.tsx'),
    ]);
    expect(names(sorted)).toEqual(['one.tsx', 'two.tsx', 'three.tsx']);
  });

  it('trusts the kind when a generated artifact has no filename', () => {
    const deck = { callID: 'x', name: 'Q3 Review', kind: 'presentation' } as OutputItem;
    const sorted = sortOutputs([file('style.css'), deck]);
    expect(names(sorted)).toEqual(['Q3 Review', 'style.css']);
  });

  it('does not drop anything — every output survives the sort', () => {
    const input = [file('a.pdf'), file('b.tsx'), file('c.png', 'image'), file('d.xlsx')];
    expect(sortOutputs(input)).toHaveLength(input.length);
  });

  it('handles an empty list', () => {
    expect(sortOutputs([])).toEqual([]);
  });
});

describe('selectPrimaryDeliverable (W2)', () => {
  const app = { callID: 'a', name: 'Dashboard', kind: 'app' as const, url: 'http://localhost:3000' };
  const pdf = { callID: 'f', name: 'report.pdf', kind: 'file' as const, path: 'report.pdf' };
  const css = { callID: 'g', name: 'globals.css', kind: 'file' as const, path: 'globals.css' };

  test('a live app outranks every file', () => {
    expect(selectPrimaryDeliverable([app], [pdf])).toBe(app);
  });

  test('no app → the top-ranked file', () => {
    expect(selectPrimaryDeliverable([], [css, pdf])).toBe(pdf);
  });

  test('nothing openable → null', () => {
    expect(selectPrimaryDeliverable([], [])).toBeNull();
    const noPath = { callID: 'x', name: 'Image', kind: 'image' as const };
    expect(selectPrimaryDeliverable([], [noPath])).toBeNull();
  });

  // ─── Freshness outranks rank: the run that just finished owns the payoff.
  // A stale rank-0 report.pdf from run 1 must never steal the auto-open from
  // the rank-3 notes.docx the run that just ended actually produced. ──

  test('a fresh low-rank file beats a stale top-rank file', () => {
    const staleTop = { ...pdf, fresh: undefined };
    const freshDocx = {
      callID: 'd',
      name: 'notes.docx',
      kind: 'file' as const,
      path: 'notes.docx',
      fresh: 'new' as const,
    };
    expect(selectPrimaryDeliverable([], [staleTop, freshDocx])).toBe(freshDocx);
  });

  test('a fresh app beats a fresh higher-rank file', () => {
    const freshApp = { ...app, fresh: 'new' as const };
    const freshPdf = { ...pdf, fresh: 'new' as const };
    expect(selectPrimaryDeliverable([freshApp], [freshPdf])).toBe(freshApp);
  });

  test('all-stale input still picks by rank', () => {
    expect(selectPrimaryDeliverable([], [css, pdf])).toBe(pdf);
  });

  // ─── easy-panel.tsx's chip-consume effect calls selectPrimaryDeliverable
  // with the UNFILTERED apps/files lists on purpose (the stale fallback is
  // its legitimate purpose — see the comment at that call site). The payoff
  // effect, by contrast, must pre-filter to fresh-only before calling in, so
  // that text-only turns in a session with history never resurrect a stale
  // deliverable. This test locks in the primitive the chip path depends on:
  // a stale-only input must still resolve to something openable. ──
  test('chip path: stale-only input still resolves (payoff must pre-filter to fresh before calling in)', () => {
    const stalePdf = { ...pdf, fresh: undefined };
    expect(selectPrimaryDeliverable([], [stalePdf])).toBe(stalePdf);
  });
});

describe('deliverableKindLabel (W3)', () => {
  test('names the kind a person recognizes, never an extension', () => {
    expect(deliverableKindLabel({ name: 'report.pdf', kind: 'file' })).toBe('PDF');
    expect(deliverableKindLabel({ name: 'data.xlsx', kind: 'file' })).toBe('Spreadsheet');
    expect(deliverableKindLabel({ name: 'data.csv', kind: 'file' })).toBe('Spreadsheet');
    expect(deliverableKindLabel({ name: 'notes.docx', kind: 'file' })).toBe('Document');
    expect(deliverableKindLabel({ name: 'deck.pptx', kind: 'presentation' })).toBe('Slides');
    expect(deliverableKindLabel({ name: 'photo.png', kind: 'image' })).toBe('Image');
    expect(deliverableKindLabel({ name: 'clip.mp4', kind: 'video' })).toBe('Video');
    expect(deliverableKindLabel({ name: 'Dashboard', kind: 'app' })).toBe('Web app');
    expect(deliverableKindLabel({ name: 'index.html', kind: 'file' })).toBe('Web page');
    expect(deliverableKindLabel({ name: 'main.ts', kind: 'file' })).toBe('File');
  });
});
