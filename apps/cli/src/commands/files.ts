import {
  resolveProjectContext,
  surfaceApiError,
  takeFlagValue,
  takeFlagBool,
  emitJson,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';

// ── Response shapes (mirror apps/api/src/projects git endpoints) ────────────

interface FileEntry {
  path: string;
  type: 'file';
  size: number | null;
}

interface CommitSummary {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  authored_at: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  subject: string;
  body: string;
}

interface CommitFile {
  path: string;
  old_path: string | null;
  status: string;
  additions: number;
  deletions: number;
}

interface CommitDetail extends CommitSummary {
  files: CommitFile[];
}

interface BranchInfo {
  name: string;
  is_default: boolean;
  tip: string;
  tip_short: string;
  subject: string;
  committer_name: string;
  committed_at: string;
  ahead: number | null;
  behind: number | null;
}

const HELP = `Usage: kortix files <subcommand> [options]

Browse the project's git repo — the same read-only view the dashboard shows
(Files tab + version history). Operates on the default branch unless --ref
selects another branch, tag, or commit sha.

Subcommands:
  ls [<path>]                       List files (recursive) under a path.
  cat <path>                        Print a file's contents.
  search <query> [--content]        Search filenames, or file contents with
                                    --content.
  history <path>                    Commit history for one file.
  branches                          List branches (ahead/behind the default).
  commits [--path <p>]              List commits on --ref.
  show <sha>                        Show one commit + its changed files.
  diff <sha> [--path <p>]           Print a commit's unified patch.
  compare <from> <into>             Summarize the diff between two refs.

Options:
  --ref <ref>        Branch / tag / commit (default: the project's default branch).
  --path <p>         Scope to a subtree (commits) or file (diff).
  --content          search: grep file contents instead of names.
  --limit <n>        Cap rows for history / commits.
  --json             Emit the raw API payload as JSON (machine-readable);
                     suppresses human output. Supported by every subcommand.
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.
`;

export async function runFiles(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let ref: string | undefined;
  let path: string | undefined;
  let limit: string | undefined;
  let content = false;
  let json = false;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    ref = takeFlagValue(rest, ['--ref']);
    path = takeFlagValue(rest, ['--path']);
    limit = takeFlagValue(rest, ['--limit']);
    content = takeFlagBool(rest, ['--content']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  const ctx = resolveProjectContext({ projectArg: projectFlag, hostArg: hostFlag });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}`;
  const refQ = ref ? `ref=${encodeURIComponent(ref)}` : '';

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const p = positional[0];
        const qs = [refQ, p ? `path=${encodeURIComponent(p)}` : ''].filter(Boolean).join('&');
        const items = await ctx.client.get<FileEntry[]>(`${base}/files${qs ? `?${qs}` : ''}`);
        if (json) {
          emitJson(items);
          return 0;
        }
        if (items.length === 0) {
          process.stdout.write(`  ${C.dim}No files${p ? ` under ${p}` : ''}.${C.reset}\n`);
          return 0;
        }
        process.stdout.write('\n');
        for (const f of items) {
          process.stdout.write(`  ${f.path}${C.faded}${f.size != null ? `  ${humanSize(f.size)}` : ''}${C.reset}\n`);
        }
        process.stdout.write(`\n  ${C.dim}${items.length} file${items.length === 1 ? '' : 's'}${C.reset}\n\n`);
        return 0;
      }
      case 'cat':
      case 'read': {
        const p = positional[0];
        if (!p) return missing('a file path');
        const qs = [`path=${encodeURIComponent(p)}`, refQ].filter(Boolean).join('&');
        const resp = await ctx.client.get<{ path: string; ref: string; content: string }>(
          `${base}/files/content?${qs}`,
        );
        if (json) {
          emitJson(resp);
          return 0;
        }
        process.stdout.write(resp.content);
        if (!resp.content.endsWith('\n')) process.stdout.write('\n');
        return 0;
      }
      case 'search': {
        const q = positional[0];
        if (!q) return missing('a search query');
        const qs = [
          `q=${encodeURIComponent(q)}`,
          content ? 'content=1' : '',
          refQ,
          limit ? `limit=${encodeURIComponent(limit)}` : '',
        ]
          .filter(Boolean)
          .join('&');
        const resp = await ctx.client.get<{
          results: { path: string; line_number?: number; line_text?: string }[];
        }>(`${base}/files/search?${qs}`);
        if (json) {
          emitJson(resp);
          return 0;
        }
        if (resp.results.length === 0) {
          process.stdout.write(`  ${C.dim}No matches.${C.reset}\n`);
          return 0;
        }
        process.stdout.write('\n');
        for (const r of resp.results) {
          if (r.line_number != null) {
            process.stdout.write(
              `  ${C.cyan}${r.path}${C.reset}${C.faded}:${r.line_number}${C.reset}  ${r.line_text?.trim() ?? ''}\n`,
            );
          } else {
            process.stdout.write(`  ${r.path}\n`);
          }
        }
        process.stdout.write(`\n  ${C.dim}${resp.results.length} match${resp.results.length === 1 ? '' : 'es'}${C.reset}\n\n`);
        return 0;
      }
      case 'history': {
        const p = positional[0];
        if (!p) return missing('a file path');
        const qs = [
          `path=${encodeURIComponent(p)}`,
          refQ,
          limit ? `limit=${encodeURIComponent(limit)}` : '',
        ]
          .filter(Boolean)
          .join('&');
        const resp = await ctx.client.get<{ commits: CommitSummary[]; hasMore: boolean }>(
          `${base}/files/history?${qs}`,
        );
        if (json) {
          emitJson(resp);
          return 0;
        }
        printCommitList(resp.commits, resp.hasMore);
        return 0;
      }
      case 'branches': {
        const resp = await ctx.client.get<{ default_branch: string; branches: BranchInfo[] }>(
          `${base}/branches`,
        );
        if (json) {
          emitJson(resp);
          return 0;
        }
        const nameW = Math.max(...resp.branches.map((b) => b.name.length), 6);
        process.stdout.write('\n');
        process.stdout.write(`  ${C.dim}${pad('BRANCH', nameW)}   TIP       AHEAD/BEHIND   SUBJECT${C.reset}\n`);
        for (const b of resp.branches) {
          const marker = b.is_default ? `${C.green}●${C.reset} ` : '  ';
          const ab = `${b.ahead ?? '?'}/${b.behind ?? '?'}`;
          process.stdout.write(
            `${marker}${pad(b.name, nameW)}   ${C.faded}${b.tip_short}${C.reset}  ${pad(ab, 12)}   ${C.dim}${trim(b.subject, 50)}${C.reset}\n`,
          );
        }
        process.stdout.write(`\n  ${C.dim}default: ${resp.default_branch} · ${resp.branches.length} branches${C.reset}\n\n`);
        return 0;
      }
      case 'commits':
      case 'log': {
        const qs = [
          refQ,
          path ? `path=${encodeURIComponent(path)}` : '',
          limit ? `limit=${encodeURIComponent(limit)}` : '',
        ]
          .filter(Boolean)
          .join('&');
        const resp = await ctx.client.get<{ commits: CommitSummary[]; hasMore: boolean }>(
          `${base}/commits${qs ? `?${qs}` : ''}`,
        );
        if (json) {
          emitJson(resp);
          return 0;
        }
        printCommitList(resp.commits, resp.hasMore);
        return 0;
      }
      case 'show': {
        const sha = positional[0];
        if (!sha) return missing('a commit sha');
        const c = await ctx.client.get<CommitDetail>(`${base}/commits/${encodeURIComponent(sha)}`);
        if (json) {
          emitJson(c);
          return 0;
        }
        process.stdout.write('\n');
        process.stdout.write(`  ${C.yellow}commit ${c.hash}${C.reset}\n`);
        process.stdout.write(`  ${C.dim}Author: ${c.author_name} <${c.author_email}>${C.reset}\n`);
        process.stdout.write(`  ${C.dim}Date:   ${c.committed_at}${C.reset}\n\n`);
        process.stdout.write(`  ${C.bold}${c.subject}${C.reset}\n`);
        if (c.body.trim()) process.stdout.write(`\n  ${c.body.split('\n').join('\n  ')}\n`);
        process.stdout.write('\n');
        for (const f of c.files) {
          const sym =
            f.status === 'added' ? C.green + 'A' : f.status === 'deleted' ? C.red + 'D' : C.cyan + 'M';
          const rename = f.old_path ? `${f.old_path} → ` : '';
          process.stdout.write(
            `  ${sym}${C.reset} ${rename}${f.path}  ${C.green}+${f.additions}${C.reset} ${C.red}-${f.deletions}${C.reset}\n`,
          );
        }
        process.stdout.write(`\n  ${C.dim}${c.files.length} file${c.files.length === 1 ? '' : 's'} changed${C.reset}\n\n`);
        return 0;
      }
      case 'diff': {
        const sha = positional[0];
        if (!sha) return missing('a commit sha');
        const qs = path ? `?path=${encodeURIComponent(path)}` : '';
        const resp = await ctx.client.get<{ patch: string }>(
          `${base}/commits/${encodeURIComponent(sha)}/diff${qs}`,
        );
        if (json) {
          emitJson({ sha, path: path ?? null, patch: resp.patch });
          return 0;
        }
        process.stdout.write(resp.patch.endsWith('\n') ? resp.patch : `${resp.patch}\n`);
        return 0;
      }
      case 'compare': {
        const from = positional[0];
        const into = positional[1];
        if (!from || !into) return missing('two refs: <from> <into>');
        const resp = await ctx.client.get<{
          from_sha: string | null;
          into_sha: string | null;
          files_changed: number;
          additions: number;
          deletions: number;
          is_up_to_date: boolean;
        }>(`${base}/version-diff?from=${encodeURIComponent(from)}&into=${encodeURIComponent(into)}`);
        if (json) {
          emitJson(resp);
          return 0;
        }
        process.stdout.write('\n');
        process.stdout.write(`  ${C.bold}${from}${C.reset} ${C.dim}→${C.reset} ${C.bold}${into}${C.reset}\n`);
        process.stdout.write(
          `  ${C.dim}${resp.files_changed} file${resp.files_changed === 1 ? '' : 's'} · ${C.green}+${resp.additions}${C.reset} ${C.red}-${resp.deletions}${C.reset}` +
            `${resp.is_up_to_date ? `  ${C.faded}(up to date)${C.reset}` : ''}\n\n`,
        );
        return 0;
      }
      default:
        process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

function printCommitList(commits: CommitSummary[], hasMore: boolean): void {
  if (commits.length === 0) {
    process.stdout.write(`  ${C.dim}No commits.${C.reset}\n`);
    return;
  }
  process.stdout.write('\n');
  for (const c of commits) {
    process.stdout.write(
      `  ${C.yellow}${c.short_hash}${C.reset}  ${trim(c.subject, 60)}  ${C.faded}${c.author_name} · ${c.committed_at.slice(0, 10)}${C.reset}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${commits.length} commit${commits.length === 1 ? '' : 's'}${hasMore ? ' (more available — raise --limit)' : ''}${C.reset}\n\n`,
  );
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
