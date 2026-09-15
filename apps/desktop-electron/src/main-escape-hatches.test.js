const { describe, expect, test } = require('bun:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

/**
 * main.js boots Electron on require, so these pin its wiring by source text.
 * The policies it calls are pure and tested on their own: `backIndex` in
 * nav-rules.test.js, `rendererGoneNeedsRecovery` in renderer-recovery.test.js.
 */
const main = readFileSync(join(__dirname, 'main.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

describe('desktop escape hatches', () => {
  // The shell has no browser toolbar. Without these, a page with no in-app
  // exit could be left only through the hidden Frontend URL menu.
  test('the Go menu offers Back on Cmd/Ctrl+[ and Home', () => {
    expect(main).toContain("label: 'Go'");
    expect(main).toMatch(/label: 'Back',\s*accelerator: 'CmdOrCtrl\+\[',\s*click: \(\) => goBackInApp\(\)/);
    expect(main).toMatch(/label: 'Home',\s*accelerator: 'CmdOrCtrl\+Shift\+H',\s*click: \(\) => goHome\(\)/);
  });

  test('Back never traverses onto a page the navigation gate would refuse', () => {
    expect(main).toContain('backIndex(');
    expect(main).toContain('shouldLoadInApp');
    // With nothing in-app behind the page, Back goes home instead.
    const back = main.slice(main.indexOf('function goBackInApp('), main.indexOf('function goHome('));
    expect(back).toContain('goHome()');
    // Traverse to the checked index, never a blind `goBack()`.
    expect(back).toContain('goToIndex(');
    expect(back).not.toContain('.goBack()');
  });

  test('Home reloads the configured app URL', () => {
    const home = main.slice(main.indexOf('function goHome('));
    expect(home).toContain('navigateMainWindow(instanceStore.appUrl())');
  });

  test('a renderer that dies offers Reload instead of leaving an empty window', () => {
    expect(main).toContain("'render-process-gone'");
    expect(main).toContain('rendererGoneNeedsRecovery(');
    expect(main).toContain("require('./renderer-recovery')");
  });
});
