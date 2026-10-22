/**
 * Project snapshot archives — the producer side of the S3 config provider.
 *
 * A snapshot is the committed project tree at ONE exact commit, plus a
 * sanitized shallow `.git` (one commit, no remotes, no hooks, no reflogs),
 * packed as `.tar.gz` and published to object storage under an immutable,
 * revision-addressed prefix (see project-snapshot-store.ts). A fresh session
 * downloads it through a short-lived descriptor instead of cloning through the
 * Git proxy.
 *
 * This module is the public entry of the producer; it only re-exports. The
 * primitives it used to own live in the leaf `project-snapshot-shared.ts`, and
 * the implementation modules import that leaf directly — no module reaches
 * back through this barrel, so none of these re-exports closes an import
 * cycle:
 *   - `project-snapshot-shared.ts` — modes, ref normalization, marker, types;
 *   - `project-snapshot-ledger.ts` — the readiness LEDGER
 *     (`kortix.project_snapshot_archives`: one row per (project, sha);
 *     `queued` → `building` → `ready` | `failed`) and the ENQUEUE helpers used
 *     by every place the API learns a base tip (registration, proxy push, CR
 *     merge, session create);
 *   - `project-snapshot-build.ts` — the BUILD + PUBLISH step the leader worker
 *     runs for a claimed row;
 *   - `project-snapshot-worker-operations.ts` — claim / settle for that worker.
 *
 * What the archive deliberately does NOT carry: credentials, credential-bearing
 * remotes, hooks, reflogs, untracked files, LFS objects (pointers only — the
 * Git path has the same semantics), submodule contents (`.gitmodules` only,
 * like a clone without `--recurse-submodules`).
 */
export * from './project-snapshot-shared';
export * from './project-snapshot-ledger';
export * from './project-snapshot-build';
export * from './project-snapshot-worker-operations';
