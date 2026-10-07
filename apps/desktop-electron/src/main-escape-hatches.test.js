const { describe, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * main.js boots Electron on require, so these pin its wiring by source text.
 * The policies it calls are pure and tested on their own: `historyTarget` in
 * navigation.test.js, `rendererGoneNeedsRecovery` in renderer-recovery.test.js.
 */
const main = readFileSync(join(__dirname, 'main.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('desktop escape hatches', () => {
  // The shell has no browser toolbar. Without these, a page with no in-app
  // exit could be left only through the hidden Frontend URL menu.
  test('the Go menu offers Back on Cmd/Ctrl+[ and Home', () => {
    expect(main).toContain("label: 'Go'");
    expect(main).toMatch(/label: 'Back',\s*accelerator: shortcuts\.back,\s*click: \(\) => goBackInApp\(\)/);
    expect(main).toMatch(/label: 'Home',\s*accelerator: shortcuts\.home,\s*click: \(\) => navigateWindow\('home'\)/);
    expect(main).toContain('NAVIGATION_SHORTCUTS.darwin');
  });

  test('Back never traverses onto a page the navigation gate would refuse', () => {
    expect(main).toContain("mainHistoryTarget('back')");
    expect(main).toContain('shouldLoadInApp');
    // With nothing in-app behind the page, Back goes home instead.
    const back = main.slice(main.indexOf('function goBackInApp('), main.indexOf('function goHome('));
    expect(back).toContain('goHome()');
    // Traverse to the checked index, never a blind `goBack()`.
    expect(back).toContain('goToIndex(');
    expect(back).not.toContain('.goBack()');
  });

  test('Home reloads the app home (the last project, via the site root)', () => {
    const home = main.slice(main.indexOf('function goHome('));
    expect(home).toContain('navigateMainWindow(instanceStore.homeUrl())');
  });

  test('Go ▸ Copy Current URL copies the page URL through the shared builder', () => {
    expect(main).toMatch(
      /id: 'kx-go-copy-url',\s*label: 'Copy Current URL',\s*accelerator: 'CommandOrControl\+L',\s*enabled: false,\s*click: \(\) => \{\s*const url = copyableUrl\(mainWindow\?\.webContents\.getURL\(\) \|\| ''\);\s*if \(url\) clipboard\.writeText\(url\);/,
    );
    // The enabled state follows every committed navigation, like the other
    // Go items.
    expect(main).toContain("menu.getMenuItemById('kx-go-copy-url')");
    expect(main).toMatch(/copyUrl\.enabled = copyableUrl\(url\) !== null/);
  });

  test('a renderer that dies offers Reload instead of leaving an empty window', () => {
    expect(main).toContain("'render-process-gone'");
    expect(main).toContain('rendererGoneNeedsRecovery(');
    expect(main).toContain("require('./renderer-recovery')");
  });

  test('a server redirect is gated like a navigation, and a page cannot repoint the shell unasked', () => {
    expect(main).toMatch(/webContents\.on\('will-redirect', \(event, url, _isInPlace, isMainFrame\) => \{\s*if \(isMainFrame\) gateTopNavigation\(event, url\);/);
    const setUrl = main.slice(main.indexOf("case 'set_frontend_url'"), main.indexOf('default:', main.indexOf("case 'set_frontend_url'")));
    expect(setUrl).toContain('dialog.showMessageBox');
    expect(setUrl.indexOf('dialog.showMessageBox')).toBeLessThan(setUrl.indexOf('switchInstance('));
  });
});
