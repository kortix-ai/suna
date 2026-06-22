/**
 * pnpm worktree — core library (barrel)
 *
 * Isolated, multi-instance dev worktrees. Each worktree gets a unique slot →
 * a deterministic block of ports for EVERY service (web, api, and the full
 * Supabase set), its own Supabase project (namespaced containers/volumes/
 * networks), its own node_modules + pnpm store, and explicit per-process env —
 * so any number of worktrees run at once without ever colliding, and the
 * primary `pnpm dev` (ports 3000/8008/5432x, project `kortix-local`) is never
 * touched.
 *
 * State lives entirely under $KORTIX_HOME (default ~/.kortix), OUTSIDE any
 * checkout, so the registry is shared across all worktrees and nothing dirties
 * a tracked tree. The only in-worktree artifact is the gitignored
 * `.kortix-worktree.json` marker.
 *
 * The implementation is split into focused modules under ./lib/; this file is
 * the single import surface (cli.ts and the tests import from here).
 */
export * from './lib/ports';
export * from './lib/exec';
export * from './lib/registry';
export * from './lib/git';
export * from './lib/supabase';
export * from './lib/migrate';
export * from './lib/launch-env';
export * from './lib/services';
export * from './lib/deps';
