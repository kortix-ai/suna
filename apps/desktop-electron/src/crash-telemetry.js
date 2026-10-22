const fs = require('node:fs');
const path = require('node:path');

// The Sentry-compatible DSN is public (not a credential). Package it for installed
// apps, which do not inherit the build runner's environment.
function setupCrashTelemetry({ app, dsn, sentry }) {
  if (!dsn) return null;
  sentry ||= require('@sentry/electron/main');
  const log = path.join(app.getPath('userData'), 'crashes.log');
  sentry.init({
    dsn,
    release: `kortix-desktop@${app.getVersion()}`,
    environment: app.isPackaged ? 'production' : 'development',
    sendDefaultPii: false,
    // Do not upload native minidumps, screenshots, breadcrumbs or user paths.
    integrations: (defaults) => defaults.filter(({ name }) => name === 'FunctionToString' || name === 'LinkedErrors'),
  });
  function report(kind, detail) {
    const message = `desktop ${kind}: ${detail}`;
    try {
      fs.appendFileSync(log, `${new Date().toISOString()} ${app.getVersion()} ${message}\n`, { mode: 0o600 });
    } catch { /* telemetry must never prevent crash recovery */ }
    sentry.captureException(new Error(message));
  }
  process.on('uncaughtExceptionMonitor', (error) => {
    report('main', error?.name || 'uncaught exception');
  });
  return report;
}

module.exports = { setupCrashTelemetry };
