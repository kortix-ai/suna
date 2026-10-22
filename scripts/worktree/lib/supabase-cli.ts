import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh, which } from './exec';

/** The checkout this CLI ships in (scripts/worktree/lib → repo root), whatever the cwd. */
export const CLI_REPO_ROOT = join(import.meta.dir, '..', '..', '..');

/** The `supabase` CLI version the root package.json pins, or null. */
export function pinnedSupabaseVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    return pkg.devDependencies?.supabase ?? pkg.dependencies?.supabase ?? null;
  } catch {
    return null;
  }
}

export interface SupabaseCli {
  /** The binary every `supabase` call runs, or null when none is installed. */
  bin: string | null;
  /** Why the CLI must not start a project, or null. */
  refusal: string | null;
}

/**
 * Which `supabase` binary to run. The repo's pinned one wins whenever it is
 * installed: two CLI versions start different service images against the
 * SAME local project, a newer storage-api migrates the storage schema
 * forward, and the pinned one `pnpm test` runs then fails every upload with
 * 42P10. Only when the pin is not installed does PATH answer, and then a
 * version other than the pin is refused.
 */
export function resolveSupabaseCli(input: {
  root: string;
  pathBin: string | null;
  version: (bin: string) => string | null;
}): SupabaseCli {
  const pinnedBin = join(input.root, 'node_modules', '.bin', 'supabase');
  if (existsSync(pinnedBin)) return { bin: pinnedBin, refusal: null };
  if (!input.pathBin) return { bin: null, refusal: null };
  const pinned = pinnedSupabaseVersion(input.root);
  const installed = input.version(input.pathBin);
  if (pinned && installed !== pinned) {
    return {
      bin: input.pathBin,
      refusal:
        `supabase CLI ${installed ?? 'of unknown version'} at ${input.pathBin}, but the repo pins ${pinned} ` +
        `and its pinned binary is not installed. Mixing versions against one local project breaks storage ` +
        `uploads (42P10). Fix: (cd ${input.root} && pnpm install)`,
    };
  }
  return { bin: input.pathBin, refusal: null };
}

/** `<bin> --version`, or null when it cannot run. */
export function supabaseVersionOf(bin: string): string | null {
  try {
    const r = sh([bin, '--version']);
    return r.ok ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

let resolved: SupabaseCli | null = null;
/** The resolved CLI for this process (see {@link resolveSupabaseCli}). */
export function supabaseCli(): SupabaseCli {
  return (resolved ??= resolveSupabaseCli({ root: CLI_REPO_ROOT, pathBin: which('supabase'), version: supabaseVersionOf }));
}
/** The binary to spawn. `supabase` only when nothing resolved, so a missing CLI still fails loudly. */
export function supabaseBin(): string {
  return supabaseCli().bin ?? 'supabase';
}
