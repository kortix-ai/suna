/**
 * Serve a project whose git upstream is a LOCAL bare repository.
 *
 * The proxy is otherwise a pure HTTP pass-through: it `fetch()`es
 * `upstream.url` and streams the result back. That silently assumes every
 * project has an HTTP(S) upstream. A project backed by a bare repo on disk —
 * a self-host install, the local test profile, or a preview whose managed
 * provider could not create a remote repo — has a `file://` upstream, and
 * `fetch('file://…')` throws, so the proxy answered
 * `502 git upstream unreachable` for it. The API's own git layer works with
 * such a project (git clones and pushes to `file://` happily); only the proxy
 * could not, so sessions started fine and then failed to materialize their
 * workspace.
 *
 * The fix is to be the git server rather than a proxy for one: git's
 * smart-HTTP protocol is a thin envelope around `git-upload-pack` and
 * `git-receive-pack`, which is exactly what a local repo can run.
 */
import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Services the smart-HTTP protocol exposes, and the scope each needs. */
export const GIT_SERVICES = {
  'git-upload-pack': 'read',
  'git-receive-pack': 'write',
} as const;

export type GitService = keyof typeof GIT_SERVICES;

/**
 * The on-disk path for a local upstream, or null when the URL is not local.
 *
 * Accepts `file:///abs/path` and a bare absolute path. Everything else — most
 * importantly anything with a host, which `file://host/path` can carry — is
 * NOT local and must keep going over HTTP.
 */
export function localRepoPath(upstreamUrl: string): string | null {
  const url = upstreamUrl.trim();
  if (!url) return null;
  if (url.startsWith('/')) return url.replace(/\/+$/, '') || '/';
  if (!url.startsWith('file://')) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // `file://host/path` addresses another machine; only an empty/localhost host
  // is this filesystem.
  if (parsed.hostname && parsed.hostname !== 'localhost') return null;
  const path = decodeURIComponent(parsed.pathname);
  if (!path.startsWith('/')) return null;
  return path.replace(/\/+$/, '') || '/';
}

/**
 * Resolve a local upstream to a real bare repository directory.
 *
 * Returns null when the path is not a usable repo, so the caller can answer a
 * clean 502 rather than spawning git against nothing. `realpathSync` collapses
 * symlinks and `..` before the check, so the value we spawn against is the one
 * we validated.
 */
export function resolveLocalRepo(upstreamUrl: string): string | null {
  const path = localRepoPath(upstreamUrl);
  if (!path) return null;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  try {
    if (!statSync(real).isDirectory()) return null;
    // A bare repo has these at its root; a working tree has them under `.git`.
    if (!statSync(join(real, 'objects')).isDirectory()) return null;
    if (!statSync(join(real, 'refs')).isDirectory()) return null;
  } catch {
    return null;
  }
  return real;
}

/** `0000`-terminated pkt-line, the framing git's smart-HTTP handshake uses. */
export function pktLine(payload: string): string {
  const length = payload.length + 4;
  return length.toString(16).padStart(4, '0') + payload;
}

/**
 * The advertisement body for `GET /info/refs?service=…`.
 *
 * git expects the service banner, a flush packet, then `--advertise-refs`
 * output verbatim.
 */
export function advertisementPrefix(service: GitService): string {
  return `${pktLine(`# service=${service}\n`)}0000`;
}

export interface GitProcessResult {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
}

/** Run one git service against a local repo. Never throws. */
export async function runGitService(
  service: GitService,
  repoPath: string,
  args: string[],
  stdin?: Uint8Array | null,
  timeoutMs = 120_000,
): Promise<GitProcessResult> {
  return await new Promise<GitProcessResult>((resolve) => {
    const child = spawn('git', [service.replace('git-', ''), ...args, repoPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // The proxy already authorized this request; git must never try to.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
      },
    });
    const out: Buffer[] = [];
    let err = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: Buffer.concat(out), stderr: err });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      err += `\n[killed: exceeded ${timeoutMs}ms]`;
      finish(false);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', (e) => {
      err += String(e?.message ?? e);
      finish(false);
    });
    child.on('close', (code) => finish(code === 0));
    if (stdin && stdin.byteLength) child.stdin.write(Buffer.from(stdin));
    child.stdin.end();
  });
}
