import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { channel } from "../config";
import { PIPELINE } from "./paths";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command, capturing output. Throws on non-zero exit unless `allowFail`. */
export async function run(
  cmd: string[],
  opts: { cwd?: string; allowFail?: boolean; env?: Record<string, string>; quiet?: boolean } = {},
): Promise<RunResult> {
  if (!opts.quiet && process.env.YT_VERBOSE) console.error(`$ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !opts.allowFail) {
    const tail = (stderr || stdout).split("\n").slice(-25).join("\n");
    throw new Error(`command failed (${code}): ${cmd.join(" ")}\n${tail}`);
  }
  return { code, stdout, stderr };
}

// ─── Heavy-job slots ─────────────────────────────────────────────────────────
// Stage agents run in parallel inside one sandbox; HyperFrames jobs each need ~1.65 cores and ~1.4 GB
// (channel.yaml → parallel.heavy_job). A counting lock shared by every `yt` process in the sandbox
// (one directory per slot; mkdir is atomic) keeps them from piling up.

/** How long a waiting job sleeps before trying the slots again. */
const SLOT_POLL_MS = 500;

/** How many heavy jobs this sandbox runs at once. */
/** Job kinds with their own slot pool: HyperFrames renders, and previews (check, snapshot). */
export type HeavyJobKind = "render" | "preview";

export function heavyJobSlots(kind: HeavyJobKind = "render"): number {
  const { cores, memory_gb } = kind === "render" ? channel().parallel.heavy_job : channel().parallel.preview_job;
  return Math.max(1, Math.min(Math.floor(cpus().length / cores), Math.floor(totalmem() / 2 ** 30 / memory_gb)));
}

const slotsDir = () => process.env.YT_HEAVY_SLOTS_DIR ?? join(tmpdir(), "yt-heavy-slots");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryTake(slot: string): boolean {
  try {
    mkdirSync(slot);
    writeFileSync(join(slot, "pid"), String(process.pid));
    return true;
  } catch {
    return false;
  }
}

async function acquireSlot(kind: HeavyJobKind): Promise<string> {
  const dir = slotsDir();
  mkdirSync(dir, { recursive: true });
  for (;;) {
    for (let i = 0; i < heavyJobSlots(kind); i++) {
      const slot = join(dir, `${kind}-${i}`);
      if (tryTake(slot)) return slot;
      // A process that died mid-job leaves its slot behind; reclaim it.
      const pid = Number(existsSync(join(slot, "pid")) ? readFileSync(join(slot, "pid"), "utf8") : 0);
      if (pid && !alive(pid)) {
        rmSync(slot, { recursive: true, force: true });
        if (tryTake(slot)) return slot;
      }
    }
    await Bun.sleep(SLOT_POLL_MS);
  }
}

/** Run `fn` while holding one of the sandbox's slots for this kind of job. */
export async function withHeavySlot<T>(fn: () => Promise<T>, kind: HeavyJobKind = "render"): Promise<T> {
  const slot = await acquireSlot(kind);
  try {
    return await fn();
  } finally {
    rmSync(slot, { recursive: true, force: true });
  }
}

/** `run` for a HyperFrames render: waits for a free render slot first. */
export const runHeavy: typeof run = (cmd, opts) => withHeavySlot(() => run(cmd, opts), "render");

/** `run` for a HyperFrames check or snapshot: waits for a free preview slot first. */
export const runPreview: typeof run = (cmd, opts) => withHeavySlot(() => run(cmd, opts), "preview");

/** The pinned HyperFrames CLI from pipeline/node_modules (falls back to npx). */
export function hyperframes(): string[] {
  const local = join(PIPELINE, "node_modules", ".bin", "hyperframes");
  return existsSync(local) ? [local] : ["npx", "-y", "hyperframes@0.8.151"];
}

export async function ffprobeDuration(path: string): Promise<number> {
  const { stdout } = await run([
    "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path,
  ]);
  return Number.parseFloat(stdout.trim());
}

export async function ffprobeJson(path: string): Promise<any> {
  const { stdout } = await run([
    "ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path,
  ]);
  return JSON.parse(stdout);
}
