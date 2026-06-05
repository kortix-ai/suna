/**
 * Pull a Suna sandbox's /workspace files. The sandboxes are archived (cold
 * storage) but resumable: start() un-archives, we tar+base64 /workspace over
 * stdout (the proven pull pattern from legacy-migration-rehydrate.ts), then
 * re-archive to control cost. Config/system files are stripped so the legacy
 * dir is just the user's content — there is ONE root kortix.toml per repo.
 */
import { getDaytona } from '../../shared/daytona';

// Stripped from each legacy/<slug>/ — Suna-era config + heavy/system dirs.
const EXCLUDES = [
  './.git', './kortix.toml', './.kortix', './node_modules', './.venv', './venv',
  './.cache', './.npm', './.bun', './.cargo', './.rustup', './.pnpm-store',
  './.local', './.config', './.ssh', './.gnupg', './__pycache__', './.cursor-server',
  './.vscode-server', './.persistent-system',
];

export function slugify(title: string, fallback: string): string {
  const s = title.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || fallback;
}

export interface ExtractResult { tarball: Buffer | null; state: string; bytes: number; }

/**
 * Un-archive `externalId`, tar /workspace (excluding config) to a gzip buffer,
 * re-archive. Returns null tarball if the sandbox is gone or /workspace empty.
 */
export async function extractWorkspace(externalId: string): Promise<ExtractResult> {
  const sb = await getDaytona().get(externalId);
  const state = (sb as { state?: string }).state ?? 'unknown';
  if (state === 'deleted') return { tarball: null, state, bytes: 0 };

  try {
    await sb.start(180); // archived/stopped → started (restores the filesystem)
  } catch (e: any) {
    return { tarball: null, state: `start-failed:${String(e?.message).slice(0, 60)}`, bytes: 0 };
  }

  const exclude = EXCLUDES.map((e) => `--exclude='${e}'`).join(' ');
  const cmd = `cd /workspace 2>/dev/null && tar czf - ${exclude} . 2>/dev/null | base64 | tr -d '\\n' || true`;
  let b64 = '';
  try {
    const res = await sb.process.executeCommand(cmd, undefined, undefined, 600);
    b64 = ((res as { result?: string }).result ?? '').trim();
  } finally {
    // Re-archive best-effort so we don't leave 14 sandboxes running.
    await sb.archive().catch(() => sb.stop().catch(() => {}));
  }

  if (!b64) return { tarball: null, state, bytes: 0 };
  const tarball = Buffer.from(b64, 'base64');
  return { tarball, state, bytes: tarball.length };
}
