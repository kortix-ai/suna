import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar variant of the project switcher is a merged control: the Kortix
 * mark and the project name in one shell, two hit areas.
 *
 * They shipped as two separate controls — a mark button beside a switcher —
 * which read as clutter because they answer the same question and looked
 * nothing alike. Merging them is only worth it if the merge holds: one shell
 * that reacts as a unit, and neither destination lost on the way in.
 *
 * Asserted against the source for the same reason as the header test:
 * observing this otherwise means mounting the sidebar with its auth, query,
 * i18n and sidebar providers to look at one row.
 */
const source = readFileSync(join(import.meta.dir, 'project-switcher.tsx'), 'utf8');

const control = source.slice(
  source.indexOf('data-slot="project-switcher"'),
  source.indexOf('// Sidebar: never blank the control'),
);

describe('merged brand/switcher control', () => {
  // The mark's whole job before the merge. Losing it would make the merge a
  // deletion dressed up as a redesign.
  test('the mark keeps its link to the project home', () => {
    expect(control).toContain('<Kortix');
    expect(control).toContain('href={homeHref}');
    expect(source).toContain("activeProjectId ? `/workspaces/${activeProjectId}` : '/workspaces'");
  });

  test('the name opens the switcher menu', () => {
    expect(control).toContain('<DropdownMenuTrigger asChild>');
    expect(control).toContain('aria-label="Switch workspace"');
  });

  // Two hit areas, never overlapping, each nameable by a screen reader.
  test('the two segments are separately labelled', () => {
    expect(control).toContain('aria-label={homeLabel}');
    expect(control).toContain('aria-label="Switch workspace"');
  });

  // This is what makes it one control instead of two: hover, press and open
  // state all live on the shell, so touching either half lights both.
  test('hover, press and open state live on the shell', () => {
    expect(control).toContain('group/switcher');
    expect(control).toContain('hover:bg-sidebar-accent/40');
    expect(control).toContain('has-[:active]:scale-[0.98]');
    expect(control).toContain('has-data-[state=open]:bg-sidebar-accent/40');
  });

  // A seam that is always drawn makes the shell read as two boxes again.
  test('the seam only appears on hover', () => {
    expect(control).toContain('bg-border/0 group-hover/switcher:bg-border/70');
    expect(control).not.toContain('group-hover/switcher:bg-border ');
  });

  // kortix-design-system: @phosphor-icons/react is the only icon source in
  // apps/web. A hand-pasted caret bypasses DEFAULT_ICON_WEIGHT entirely.
  test('the caret is a Phosphor icon, not pasted markup', () => {
    expect(control).toContain('<CaretUpDownIcon');
    expect(source).not.toContain('<svg');
  });

  // The menu portals out of the panel, so a hover-peeked sidebar would collapse
  // the moment the pointer reached the menu — leaving the menu floating over
  // nothing. Same guard the session filter menu already uses.
  test('the open menu holds a hover-peeked panel open', () => {
    expect(source).toContain('sidebar?.holdPeek(open)');
  });

  // Dead prop after the merge: the sidebar variant always leads with the mark.
  test('the showIcon escape hatch is gone', () => {
    expect(source).not.toContain('showIcon');
  });

  test('one workspace renders only the home mark and two workspaces expose the selector', () => {
    expect(source).toContain('workspaceCount >= 2');
    expect(source).toContain("variant === 'sidebar' && !showWorkspaceSwitcher");
    expect(source).toContain('data-slot="workspace-home"');
  });
});

/**
 * `resolveSwitcherLabel` guarantees the detail name beats the list name — but
 * only if this component hands the two values to the right parameters. Swap
 * them and every assertion in `project-switcher-label.test.ts` still passes
 * while the original two-titles bug is back, list-first, exactly as it was.
 *
 * Asserted against the source for the same reason as the tests above:
 * observing it otherwise means mounting the sidebar with its auth, query,
 * i18n and sidebar providers to read one label.
 */
describe('name wiring — detail is the source, the list is only a placeholder', () => {
  test('the authoritative name comes from useProjectName, not the list', () => {
    expect(source).toContain(
      'const activeProjectName = useProjectName(activeProjectId ?? undefined)',
    );
  });

  // `?? null` would collapse "no detail yet" into "detail says blank" and
  // silently disable the placeholder — see resolveSwitcherLabel's doc comment.
  test('the detail name is passed raw, so undefined survives', () => {
    expect(source).not.toContain('useProjectName(activeProjectId ?? undefined) ?? null');
  });

  test('the list value is passed as the placeholder, never as the name', () => {
    expect(source).toContain('placeholderProjectName: listProjectName');
    expect(source).toContain('activeProjectName,');
    expect(source).toContain(
      'projectsQuery.data?.find((p) => p.project_id === activeProjectId)?.name',
    );
  });

  // The pre-fix bug in one line. If this string ever reappears the list is a
  // second source again, not a placeholder.
  test('the list name is never merged into the name with ??', () => {
    expect(source).not.toContain('listProjectName ??');
    expect(source).not.toContain('?? listProjectName');
  });
});
