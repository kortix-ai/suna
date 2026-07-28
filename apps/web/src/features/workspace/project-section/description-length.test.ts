import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "ONE line of description" is the rule that keeps these screens readable.
 * Prose is how the old Customize sections grew — voice-view's description was
 * three sentences — so enforce it mechanically rather than by review.
 *
 * Scans the source for `description="…"` literals passed to
 * ProjectSectionPage and asserts each is a single short line.
 */

const MAX_DESCRIPTION_CHARS = 90;
const WEB_SRC = join(import.meta.dir, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every `description="…"` on a ProjectSectionPage element, with its file. */
function collectDescriptions(): { file: string; value: string }[] {
  const found: { file: string; value: string }[] = [];
  for (const file of walk(WEB_SRC)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('ProjectSectionPage')) continue;
    // Match the opening tag through its closing bracket, then pull the literal.
    for (const tag of source.matchAll(/<ProjectSectionPage\b[\s\S]*?>/g)) {
      for (const attr of tag[0].matchAll(/\bdescription=(?:"([^"]*)"|\{'([^']*)'\})/g)) {
        found.push({ file, value: attr[1] ?? attr[2] ?? '' });
      }
    }
  }
  return found;
}

describe('section descriptions stay one line', () => {
  const descriptions = collectDescriptions();

  test('every description fits on one line', () => {
    const tooLong = descriptions
      .filter((d) => d.value.length > MAX_DESCRIPTION_CHARS)
      .map((d) => `${d.file.replace(WEB_SRC, '')}: ${d.value.length} chars — "${d.value}"`);
    expect(tooLong).toEqual([]);
  });

  test('no description contains a newline', () => {
    const multiline = descriptions.filter((d) => d.value.includes('\n')).map((d) => d.file);
    expect(multiline).toEqual([]);
  });

  test('no description is more than two sentences', () => {
    const rambling = descriptions
      .filter((d) => (d.value.match(/[.!?](\s|$)/g) ?? []).length > 2)
      .map((d) => `${d.file.replace(WEB_SRC, '')}: "${d.value}"`);
    expect(rambling).toEqual([]);
  });

  test('the scanner actually finds the tag it guards', () => {
    // Guards against the regex silently matching nothing and the whole suite
    // passing vacuously once screens start using the component.
    const sample = `<ProjectSectionPage
        title="Skills"
        description="Reusable capabilities your agent can apply."
        state="ready"
      >`;
    const match = [...sample.matchAll(/<ProjectSectionPage\b[\s\S]*?>/g)];
    expect(match).toHaveLength(1);
    const attr = [...match[0][0].matchAll(/\bdescription=(?:"([^"]*)"|\{'([^']*)'\})/g)];
    expect(attr[0][1]).toBe('Reusable capabilities your agent can apply.');
  });
});
