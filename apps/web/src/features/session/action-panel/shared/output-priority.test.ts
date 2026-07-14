import { describe, expect, it } from 'bun:test';
import type { OutputItem } from './derive-panels';
import { sortOutputs } from './output-priority';

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
