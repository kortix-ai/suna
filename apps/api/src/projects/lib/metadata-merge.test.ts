import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Guard (FIX-J adjustment #4): no whole-object RMW writer on projects.metadata ─
//
// A SINGLE remaining unfenced read-modify-write writer can silently revert the
// routing pin, so the sweep must be total. This lint scans every non-test source
// file for `.update(projects)` and asserts any `metadata:` it SETs goes through
// the sanctioned SQL-side atomic-merge helpers — never a whole object / spread.

const SRC_ROOT = join(import.meta.dir, '..', '..'); // apps/api/src
/** A metadata SET value is safe iff it is built by a merge helper (or a `sql`
 *  expression, or a `…Expr` variable holding one) — never an object literal or a
 *  spread of the existing metadata. */
const SAFE_METADATA_VALUE = /metadataMerge|metadataMergeSubtree|metadataClearSubtreeKey|metadataExpr|sql`/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...tsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'metadata-merge.ts') {
      out.push(full);
    }
  }
  return out;
}

/** Every `metadata:` assignment inside a `.update(projects)…set({…})` window. */
function projectsMetadataWrites(source: string): string[] {
  const values: string[] = [];
  const re = /\.update\(\s*projects\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // Window from the .update(projects) to the closing of its .set({…}) (bounded
    // by the .where(...) that always follows, or a generous char cap).
    const start = m.index;
    const whereAt = source.indexOf('.where(', start);
    const window = source.slice(start, whereAt === -1 ? start + 800 : whereAt);
    const meta = window.match(/\bmetadata:\s*([\s\S]*?)(?:,\s*\n|,\s*updatedAt|\n\s*})/);
    if (meta) values.push(meta[1]!.trim());
  }
  return values;
}

describe('FIX-J guard — no whole-object RMW writer on projects.metadata', () => {
  const files = tsFiles(SRC_ROOT);

  test('the scan actually finds the projects.metadata writers', () => {
    const total = files.reduce((n, f) => n + projectsMetadataWrites(readFileSync(f, 'utf8')).length, 0);
    // activateWithCas, setPinWithGenerationBump, writeTransitionMarker, agent-config,
    // r1 seed, r4 triggers, r6 experimental, r6 onboarding, templates slug, meet.
    expect(total).toBeGreaterThanOrEqual(8);
  });

  test('every projects.metadata SET uses the atomic-merge helpers, never a raw object', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const value of projectsMetadataWrites(readFileSync(file, 'utf8'))) {
        if (!SAFE_METADATA_VALUE.test(value)) {
          offenders.push(`${file.slice(SRC_ROOT.length + 1)} → metadata: ${value.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
