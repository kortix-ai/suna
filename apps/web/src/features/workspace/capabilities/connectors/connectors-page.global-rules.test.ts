import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Global rules — project-wide connector approval policy — belongs to THIS
 * page.
 *
 * It used to sit at the far right of `shared/capability-tabs.tsx`, so it rode
 * above Agents, Skills and Triggers as well, none of which it governs. It now
 * sits at the far right of this page's OWN scope row — same position, one bar
 * down, and scoped to the only capability it governs. These assertions are the
 * ones that moved with it, plus the ones that keep it from drifting back.
 *
 * It stays put across all four scopes, Channels included: the rules govern
 * connector approval, and a control that appears and disappears as you click
 * along a tab strip is a control people stop trusting is there.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'connectors-page.tsx'), 'utf8');
const tabs = readFileSync(
  resolve(here, '../shared/capability-tabs.tsx'),
  'utf8',
);

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const filtersSlice = (body: string) => {
  const start = body.indexOf('filters={');
  expect(start).toBeGreaterThan(-1);
  // `filters` is the last prop on `CapabilityPageShell`; its slot ends where
  // the shell's children begin. That first child is the Channels scope, which
  // now precedes the catalogue branch — anchoring on the catalogue instead
  // would swallow the Channels body into this slice.
  const end = body.indexOf('{channelsActive ?', start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
};

describe('connectors page Global rules', () => {
  // It sits in the scope row, at the far right — not in the header above it,
  // and not on the shared capability bar it came from.
  test('the trigger lives in the tab row, after the scope tabs', () => {
    const body = code(source);
    const filters = filtersSlice(body);
    expect(filters).toContain('Global rules');
    expect(filters).toContain('setRulesOpen(true)');
    // After the tab strip in source order = to its right in the flex row.
    expect(filters.indexOf('TabsList')).toBeLessThan(filters.indexOf('Global rules'));
    // The header keeps only the Add action.
    const header = body.slice(body.indexOf('action={'), body.indexOf('filters={'));
    expect(header).not.toContain('Global rules');
    expect(header).toContain('Add a custom connector');
  });

  // Text, not a chip: the row already carries the tab strip's filled control,
  // and this is a way out to a settings surface rather than a second selector.
  // `ml-auto` — not the shell's `justify-between` — is what holds it right,
  // including on the wrapped narrow-viewport layout where it lands alone on
  // the second line.
  test('the trigger renders as muted text pinned right, not a button chip', () => {
    const filters = filtersSlice(code(source));
    const trigger = filters.slice(filters.indexOf('setRulesOpen(true)') - 200);
    expect(trigger).toContain('variant="text"');
    expect(trigger).toContain('ml-auto');
    expect(trigger).toContain('px-0');
  });

  // Global rules is readable by anyone who can open the page; only Add is
  // gated on write. Folding it into the `canWrite` branch would hide the
  // project's approval policy from every viewer.
  test('the trigger is not gated on canWrite', () => {
    const filters = filtersSlice(code(source));
    expect(filters).toContain('Global rules');
    expect(filters).not.toContain('canWrite');
  });

  // The header action carries a word, not a bare glyph — "Add" is the visible
  // label, and the longer `aria-label` opens with it so the accessible name
  // still contains the visible one.
  test('the header action reads "Add", at full button size', () => {
    const body = code(source);
    const header = body.slice(body.indexOf('action={'), body.indexOf('filters={'));
    expect(header).toContain('<PlusIcon className="size-4" />');
    expect(header).toContain('Add');
    expect(header).not.toContain('size="icon-md"');
    expect(header).toContain('aria-label="Add a custom connector"');
  });

  test('it opens in a Sheet and renders PoliciesPanel, with the copy intact', () => {
    const body = code(source);
    expect(body).toContain('<Sheet open={rulesOpen} onOpenChange={setRulesOpen}>');
    expect(body).toContain('<SheetTitle');
    expect(body).toContain('Approval rules that apply to every connector in this project.');
    expect(body).toContain('<PoliciesPanel projectId={projectId} />');
  });

  // `menu-registry.ts`'s `proj-connectors-policies` navigates straight here,
  // and an OAuth return is a full page load — component state would not
  // survive either. `?c=` is held in the URL for the same reason.
  test('open state is held in the URL, not component state', () => {
    const body = code(source);
    expect(body).toContain("search?.get('rules') === '1'");
    expect(body).toContain("params.set('rules', '1')");
    expect(body).toContain("params.delete('rules')");
  });

  test('the shared capability tab bar no longer carries it', () => {
    // Comment-stripped: that file's header comment names the control to record
    // where it moved to.
    const bar = code(tabs);
    expect(bar).not.toContain('Global rules');
    expect(bar).not.toContain('PoliciesPanel');
  });
});
