import { statSync } from 'fs';

/** Identity of the files this process runs; a replaced file changes it. */
export function runtimeFingerprint(files: readonly string[]): string {
  return files
    .map((file) => {
      try {
        const stat = statSync(file);
        return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return 'missing';
      }
    })
    .join('|');
}

/** A macOS grant refused this long after start is not a grant this process missed. */
const PERMISSION_RESTART_MIN_UPTIME_S = 5 * 60;

/**
 * A background service must not outlive its own code or its macOS grants:
 *
 * - An app update replaces the binary under the running agent. macOS then
 *   cannot validate the old process's signature and refuses it Accessibility
 *   and Screen Recording, while the updated app itself shows them allowed.
 * - A grant made in System Settings applies to processes started after it.
 *
 * Both are healed by exiting: the supervisor (launchd KeepAlive, systemd
 * Restart=always, the Windows loop) starts the service again on the current
 * code with the current grants.
 */
export function watchForRestart(exit: (reason: string) => void, intervalMs = 60_000): {
  permissionMissing: () => void;
} {
  const files = [process.execPath, process.argv[1]].filter((file): file is string => Boolean(file));
  const started = runtimeFingerprint(files);
  setInterval(() => {
    if (runtimeFingerprint(files) !== started) exit('its code was updated');
  }, intervalMs).unref();
  return {
    permissionMissing: () => {
      if (process.uptime() < PERMISSION_RESTART_MIN_UPTIME_S) return;
      // After the refusal is sent: the caller gets the actionable error first.
      setTimeout(() => exit('macOS refused a desktop permission'), 1_000).unref();
    },
  };
}
