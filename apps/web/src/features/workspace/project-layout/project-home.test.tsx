import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./project-home.tsx', import.meta.url)), 'utf8');

describe('ProjectHome sidebar toggle', () => {
  test('connects collapsed-toggle hover to the sidebar peek controller', () => {
    expect(source).toContain('onPointerEnter={sidebarState ===');
    expect(source).toContain('peekEnter');
    expect(source).toContain('peekLeave');
  });

  // The panel's own header carries the collapse control (ProjectSidebar), so
  // this page-level toggle exists only to bring a hidden panel back.
  test('the toggle self-hides while the sidebar is docked open', () => {
    const gate = source.slice(
      source.indexOf('const showSidebarToggle ='),
      source.indexOf(';', source.indexOf('const showSidebarToggle =')),
    );
    expect(gate).toContain("sidebarState !== 'expanded'");
    expect(source).toContain('{showSidebarToggle && (');
  });

  // `sidebarState` tracks the desktop dock cookie, not the mobile Sheet — an
  // ungated gate would leave this page with no way to open the sheet.
  test('mobile is exempt from that gate', () => {
    const gate = source.slice(
      source.indexOf('const showSidebarToggle ='),
      source.indexOf(';', source.indexOf('const showSidebarToggle =')),
    );
    expect(gate).toContain('isMobileViewport ||');
  });

  test('does not send the project default as an explicit session sandbox override', () => {
    expect(source).not.toContain('sandbox_slug: activeSlug');
  });
});
