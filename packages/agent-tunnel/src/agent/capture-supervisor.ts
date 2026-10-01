import { spawn, type ChildProcess } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, statSync, truncateSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { MAX_SERVICE_LOG_BYTES } from './service-paths';

const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/** A child that ran this long was healthy: its next restart starts at the short delay again. */
const HEALTHY_RUN_MS = 60_000;
const KILL_AFTER_MS = 5_000;

export interface CaptureSupervisorOptions {
  /** The `kortix-capture` binary. */
  bin: string;
  /** Home of the agent: holds `capture/` (recorder files) and `logs/`. */
  home: string;
  env?: NodeJS.ProcessEnv;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

/** `KORTIX_CAPTURE_BIN`, else `capture/kortix-capture` beside the agent bundle's folder. Null when absent. */
export function resolveCaptureBin(env: NodeJS.ProcessEnv = process.env, bundleFile = bundlePath()): string | null {
  const name = process.platform === 'win32' ? 'kortix-capture.exe' : 'kortix-capture';
  const candidate = env.KORTIX_CAPTURE_BIN?.trim() || join(dirname(bundleFile), '..', 'capture', name);
  return existsSync(candidate) ? candidate : null;
}

function bundlePath(): string {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return join(process.cwd(), 'agent-cli.js');
  }
}

/**
 * Runs `kortix-capture record` for as long as the service lives. A crash or
 * exit restarts it with a 2 s to 60 s backoff. It never throws: the tunnel
 * must keep running when capture cannot start.
 */
export function startCaptureSupervisor(options: CaptureSupervisorOptions): { stop: () => void } {
  const env = options.env ?? process.env;
  const captureDir = env.KORTIX_CAPTURE_DIR?.trim() || join(options.home, 'capture');
  const logFile = join(options.home, 'logs', 'capture.log');
  const initial = options.initialBackoffMs ?? INITIAL_BACKOFF_MS;
  const max = options.maxBackoffMs ?? MAX_BACKOFF_MS;
  let backoff = initial;
  let stopped = false;
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const log = (line: string) => process.stdout.write(`[agent-tunnel] capture: ${line}\n`);

  const schedule = () => {
    if (stopped) return;
    log(`restarting in ${Math.round(backoff / 100) / 10}s`);
    timer = setTimeout(launch, backoff);
    backoff = Math.min(backoff * 2, max);
  };

  function launch() {
    timer = null;
    if (stopped) return;
    const startedAt = Date.now();
    let logFd: number | null = null;
    try {
      mkdirSync(captureDir, { recursive: true, mode: 0o700 });
      mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
      try {
        if (statSync(logFile).size > MAX_SERVICE_LOG_BYTES) truncateSync(logFile, 0);
      } catch {
        /* no log yet */
      }
      logFd = openSync(logFile, 'a', 0o600);
      child = spawn(options.bin, ['record'], {
        // The recorder exits by itself when this pid disappears (no orphan after a SIGKILL).
        env: { ...env, KORTIX_CAPTURE_DIR: captureDir, AGENT_TUNNEL_HOME: options.home, KORTIX_CAPTURE_PARENT_PID: String(process.pid) },
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
    } catch (error) {
      log(`could not start: ${error instanceof Error ? error.message : error}`);
      if (logFd !== null) closeSync(logFd);
      return schedule();
    }
    closeSync(logFd);
    const current = child;
    log(`started pid ${current.pid}`);
    // 'error' (spawn failure) may or may not be followed by 'exit'; settle once.
    let settled = false;
    const settle = (why: string) => {
      if (settled) return;
      settled = true;
      if (child === current) child = null;
      if (stopped) return;
      log(why);
      if (Date.now() - startedAt >= HEALTHY_RUN_MS) backoff = initial;
      schedule();
    };
    current.on('error', (error) => settle(`error: ${error.message}`));
    current.on('exit', (code, signal) => settle(`exited (${signal ?? code})`));
  }

  launch();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const running = child;
      if (!running || running.exitCode !== null) return;
      running.kill('SIGTERM');
      // The service exits right after stop(); an unref'd timer would never fire then.
      setTimeout(() => running.kill('SIGKILL'), KILL_AFTER_MS).unref();
    },
  };
}
