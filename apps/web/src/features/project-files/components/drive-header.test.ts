import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FILES_HEADER_DESKTOP_CLASS, driveHeaderClass } from './drive-header';

const globalsCss = readFileSync(
  join(import.meta.dir, '..', '..', '..', 'app', 'globals.css'),
  'utf8',
);

const SHELL_SIDEBAR_TOGGLE_RIGHT_EDGE_PX = 100;

describe('driveHeaderClass', () => {
  test('indents the standalone page header past the collapsed-sidebar toggle', () => {
    const className = driveHeaderClass(true, true);
    expect(className).toContain('md:pl-14');
    expect(className).toContain('pt-14');
    expect(className).toContain('md:pt-3');
  });

  test('drops the left indent once the sidebar covers the toggle', () => {
    expect(driveHeaderClass(true, false)).not.toContain('md:pl-14');
  });

  test('opts the embedded session view out of the title-bar offsets entirely', () => {
    const className = driveHeaderClass(false, true);
    expect(className).not.toContain(FILES_HEADER_DESKTOP_CLASS);
    expect(className).not.toContain('md:pl-14');
    expect(className).toContain('pt-5');
  });

  test('tags every standalone header with the desktop title-bar hook', () => {
    expect(driveHeaderClass(true, true)).toContain(FILES_HEADER_DESKTOP_CLASS);
    expect(driveHeaderClass(true, false)).toContain(FILES_HEADER_DESKTOP_CLASS);
  });
});

describe('desktop title-bar clearance rules', () => {
  test('globals.css still styles the class the component emits', () => {
    expect(globalsCss).toContain(`.${FILES_HEADER_DESKTOP_CLASS}`);
  });

  test('macOS clears the traffic lights and the shell toggle while collapsed', () => {
    const rule = new RegExp(
      `html\\[data-desktop-platform='macos'\\] \\.${FILES_HEADER_DESKTOP_CLASS}\\[data-sidebar-collapsed\\] \\{\\s*padding-left: (\\d+)px;`,
    ).exec(globalsCss);

    expect(rule).not.toBeNull();
    expect(Number(rule?.[1])).toBeGreaterThan(SHELL_SIDEBAR_TOGGLE_RIGHT_EDGE_PX);
  });

  test('Win/Linux clears the top-right window controls instead', () => {
    const rule = new RegExp(
      `html\\[data-desktop='true'\\]:not\\(\\[data-desktop-platform='macos'\\]\\) \\.${FILES_HEADER_DESKTOP_CLASS} \\{\\s*padding-right: (\\d+)px;`,
    ).exec(globalsCss);

    expect(rule).not.toBeNull();
    expect(Number(rule?.[1])).toBeGreaterThan(0);
  });
});
