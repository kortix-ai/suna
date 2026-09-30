const { test, expect } = require('bun:test');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setupCrashTelemetry } = require('./crash-telemetry');

test('reports sanitized renderer failure with release and writes a private local log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-crash-'));
  const events = [];
  let options;
  try {
    const report = setupCrashTelemetry({
      app: { getPath: () => dir, getVersion: () => '1.2.3', isPackaged: true },
      dsn: 'https://public@example.test/1',
      sentry: { init: (value) => { options = value; }, captureException: (error) => events.push(error) },
    });
    report('renderer', 'crashed (exit 1)');
    expect(options.release).toBe('kortix-desktop@1.2.3');
    expect(options.sendDefaultPii).toBe(false);
    expect(options.integrations([{ name: 'SentryMinidump' }, { name: 'OnUncaughtException' }, { name: 'FunctionToString' }])).toEqual([{ name: 'FunctionToString' }]);
    expect(events[0].message).toBe('desktop renderer: crashed (exit 1)');
    expect(readFileSync(join(dir, 'crashes.log'), 'utf8')).toContain('1.2.3 desktop renderer: crashed (exit 1)');
    expect(setupCrashTelemetry({ app: {}, dsn: '' })).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
