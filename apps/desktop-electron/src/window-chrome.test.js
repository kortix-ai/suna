const { describe, expect, test } = require('bun:test');

const {
  DESKTOP_CHROME_JS,
  MAC_TITLEBAR,
  configureNativeWindowControls,
  macBandMetrics,
  macLightsEndX,
  macTrafficLightPosition,
} = require('./window-chrome');

describe('desktop window chrome', () => {
  test('keeps interactive title-bar elements outside drag regions', () => {
    expect(DESKTOP_CHROME_JS).toContain('button,a,input,textarea');
    expect(DESKTOP_CHROME_JS).toContain('-webkit-app-region:no-drag');
  });

  test('does not inject a full-width drag overlay', () => {
    expect(DESKTOP_CHROME_JS).not.toContain('kortix-drag-strip');
    expect(DESKTOP_CHROME_JS).not.toContain('pointer-events:none');
    expect(DESKTOP_CHROME_JS).not.toContain('MutationObserver');
  });

  test('uses native macOS window controls', () => {
    const calls = [];
    configureNativeWindowControls(
      { setWindowButtonVisibility: (visible) => calls.push(visible) },
      true,
    );
    expect(calls).toEqual([true]);
  });

  test('does not configure macOS controls on other platforms', () => {
    const calls = [];
    configureNativeWindowControls(
      { setWindowButtonVisibility: (visible) => calls.push(visible) },
      false,
    );
    expect(calls).toEqual([]);
  });
});

/* The band used to be described by four disagreeing numbers (60 here, 52 for
   .kx-app-header, 40 for the tab bar, and a 26px centre line in two React
   files), so a control drawn "on the traffic-light line" was 4px off it. These
   pin the derivation. */
describe('macOS title-bar band geometry', () => {
  test('traffic lights are vertically centered in the band', () => {
    const { y } = macTrafficLightPosition();
    expect(y + MAC_TITLEBAR.lightSize / 2).toBe(MAC_TITLEBAR.band / 2);
  });

  test('the light cluster is three lights wide', () => {
    // close + minimize + zoom: inset, one diameter, two pitches.
    expect(macLightsEndX()).toBe(10 + 12 + 20 * 2);
    expect(macLightsEndX()).toBe(62);
  });

  test('the app control shares the lights’ centre line', () => {
    const { controlTop } = macBandMetrics();
    const { y } = macTrafficLightPosition();
    expect(controlTop + MAC_TITLEBAR.control / 2).toBe(y + MAC_TITLEBAR.lightSize / 2);
  });

  test('the app control clears the lights by the full gutter', () => {
    const { controlLeft } = macBandMetrics();
    expect(controlLeft - macLightsEndX()).toBe(MAC_TITLEBAR.gutter);
    expect(controlLeft).toBe(72);
  });

  test('content starts after the control, not on top of it', () => {
    const { contentLeft, controlLeft } = macBandMetrics();
    expect(contentLeft).toBe(controlLeft + MAC_TITLEBAR.control + MAC_TITLEBAR.contentGap);
    expect(contentLeft).toBe(108);
  });

  test('every derived offset is a whole pixel', () => {
    for (const value of Object.values(macBandMetrics())) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
