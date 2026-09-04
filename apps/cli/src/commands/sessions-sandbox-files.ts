/**
 * `kortix sessions files` — the sandbox filesystem, the way the dashboard's
 * file panel drives it.
 *
 * `kortix files` reads the REPO through the API (any ref, no sandbox needed).
 * This is the other half: the LIVE workspace of one session — what the agent
 * has actually written this turn, before anything is committed. Every call
 * goes to that session's own sandbox daemon through the SDK session handle, so
 * two open sessions never cross wires.
 */

import { readFile as fsReadFile } from 'node:fs/promises';

import { toSandboxAbsolutePath } from '@kortix/sdk';

import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import type { Auth } from '../api/auth.ts';
import { emitJson, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { confirm } from '../prompts.ts';
import { C, help, pad, status } from '../style.ts';
import { loadSessionForChat } from './sessions-chat.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

const FILES_HELP = help`Usage: kortix sessions files <session-id> <subcommand> [options]

Read and edit the LIVE workspace of one session's sandbox — the working tree
the agent is editing right now, before anything is committed. (\`kortix files\`
reads the committed repo instead.) Paths resolve under /workspace unless they
start with /workspace, /tmp, /home or /opt. Wakes the sandbox if it is asleep.

Subcommands:
  ls [<path>]              List a directory (default /workspace). --json.
  status                   Uncommitted changes, with +/- line counts. --json.
  find <query>             Fuzzy filename search. --content searches file
                           contents (ripgrep) instead. --limit <N>. --json.
  write <path>             Overwrite a file atomically (upload → rename →
                           drop backup). Reads stdin, or --from <local file>.
  touch <path>             Create an empty file.
  mkdir <path>             Create a directory (recursive, idempotent).
  mv <from> <to>           Rename or move.
  rm <path>                Delete a file or directory (recursive). Asks first;
                           -y skips the prompt.

Options:
  --from <local path>      \`write\` reads this local file instead of stdin.
  --content                \`find\` searches contents instead of filenames.
  --limit <N>              \`find\` result cap (filename search only).
  -y, --yes                Skip the \`rm\` confirmation.
  --project <id>           Operate on this project id (default: linked).
  --host <name>            Operate against a non-default Kortix host.
  --json                   Machine-readable output.
  -h, --help               Show this help.

Examples:
  kortix sessions files <session-id> ls out
  kortix sessions files <session-id> status
  kortix sessions files <session-id> find report --content
  echo "hello" | kortix sessions files <session-id> write out/note.txt
`;

const SUBCOMMANDS = ['ls', 'list', 'status', 'find', 'write', 'touch', 'mkdir', 'mv', 'rm'];

/** stdin as one blob — how `write` takes content when there is no --from. */
async function readStdin(): Promise<Blob> {
  const chunks: BlobPart[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    chunks.push(new Uint8Array(chunk));
  }
  return new Blob(chunks);
}

export async function runSessionsFiles(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(FILES_HELP);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let from: string | undefined;
  let limitArg: string | undefined;
  let content = false;
  let assumeYes = false;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    from = takeFlagValue(rest, ['--from']);
    limitArg = takeFlagValue(rest, ['--limit']);
    content = takeFlagBool(rest, ['--content']);
    assumeYes = takeFlagBool(rest, ['-y', '--yes']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const positional = rest.filter((a) => !a.startsWith('-'));
  const sessionId = positional[0];
  const sub = positional[1];
  if (!sessionId || !sub) {
    process.stderr.write(`${status.err('Pass a session id and a subcommand.')}\n\n${FILES_HELP}`);
    return 2;
  }
  if (!SUBCOMMANDS.includes(sub)) {
    process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${FILES_HELP}`);
    return 2;
  }

  const arg1 = positional[2];
  const arg2 = positional[3];
  const needsOneArg = ['find', 'write', 'touch', 'mkdir', 'rm'];
  if (needsOneArg.includes(sub) && !arg1) {
    process.stderr.write(
      `${status.err(`\`files ${sub}\` needs ${sub === 'find' ? 'a query' : 'a path'}.`)}\n`,
    );
    return 2;
  }
  if (sub === 'mv' && (!arg1 || !arg2)) {
    process.stderr.write(`${status.err('`files mv` needs <from> and <to>.')}\n`);
    return 2;
  }

  const opts: CtxOpts = { projectArg, hostArg };
  const resolved = await loadSessionForChat(sessionId, opts, 'sessions files', {
    requireRunning: false,
  });
  if (!resolved) return 1;
  const auth: Auth = resolved.auth;
  const files = kortixFromAuth(auth).session(
    resolved.ctx.projectId,
    resolved.session.session_id,
  ).files;

  try {
    return await withKortixScope(auth, async () => {
      switch (sub) {
        case 'ls':
        case 'list': {
          const dir = toSandboxAbsolutePath(arg1 ?? '/workspace');
          const nodes = await files.list(dir);
          if (json) {
            emitJson(nodes);
            return 0;
          }
          if (nodes.length === 0) {
            process.stdout.write(`  ${C.dim}${dir} is empty.${C.reset}\n`);
            return 0;
          }
          const nameW = Math.max(...nodes.map((n) => n.name.length), 4);
          process.stdout.write('\n');
          for (const node of nodes) {
            const kind = node.type === 'directory' ? `${C.cyan}dir ${C.reset}` : 'file';
            process.stdout.write(
              `  ${kind}  ${pad(node.name, nameW)}   ${C.faded}${node.path}${C.reset}\n`,
            );
          }
          process.stdout.write(
            `\n  ${C.dim}${nodes.length} entr${nodes.length === 1 ? 'y' : 'ies'} in ${dir}${C.reset}\n\n`,
          );
          return 0;
        }
        case 'status': {
          const rows = await files.status();
          if (json) {
            emitJson(rows);
            return 0;
          }
          if (rows.length === 0) {
            process.stdout.write(`  ${C.dim}Working tree clean.${C.reset}\n`);
            return 0;
          }
          const pathW = Math.max(...rows.map((r) => r.path.length), 4);
          process.stdout.write('\n');
          process.stdout.write(`  ${C.dim}${pad('PATH', pathW)}   STATUS     +/-${C.reset}\n`);
          for (const row of rows) {
            process.stdout.write(
              `  ${pad(row.path, pathW)}   ${pad(row.status, 9)}  ${C.green}+${row.added}${C.reset} ${C.red}-${row.removed}${C.reset}\n`,
            );
          }
          process.stdout.write(
            `\n  ${C.dim}${rows.length} changed file${rows.length === 1 ? '' : 's'}${C.reset}\n\n`,
          );
          return 0;
        }
        case 'find': {
          if (content) {
            const matches = await files.findText(arg1!);
            if (json) {
              emitJson(matches);
              return 0;
            }
            if (matches.length === 0) {
              process.stdout.write(`  ${C.dim}No matches for "${arg1}".${C.reset}\n`);
              return 0;
            }
            for (const match of matches) {
              process.stdout.write(
                `  ${C.cyan}${match.path}${C.reset}${C.dim}:${match.line_number}${C.reset}  ${match.lines.replace(/\n+$/, '')}\n`,
              );
            }
            process.stdout.write(
              `\n  ${C.dim}${matches.length} match${matches.length === 1 ? '' : 'es'}${C.reset}\n`,
            );
            return 0;
          }
          const limit = limitArg ? Number(limitArg) : undefined;
          if (limitArg && (!Number.isInteger(limit) || limit! <= 0)) {
            process.stderr.write(`${status.err(`Invalid --limit "${limitArg}".`)}\n`);
            return 2;
          }
          const paths = await files.findFiles(arg1!, limit ? { limit } : undefined);
          if (json) {
            emitJson(paths);
            return 0;
          }
          if (paths.length === 0) {
            process.stdout.write(`  ${C.dim}No file matches "${arg1}".${C.reset}\n`);
            return 0;
          }
          for (const path of paths) process.stdout.write(`  ${path}\n`);
          process.stdout.write(
            `\n  ${C.dim}${paths.length} file${paths.length === 1 ? '' : 's'}${C.reset}\n`,
          );
          return 0;
        }
        case 'write': {
          const content = from
            ? new Blob([new Uint8Array(await fsReadFile(from))])
            : await readStdin();
          // The daemon's upload endpoint never overwrites (it uniquifies a
          // colliding name), so this goes through the SDK's atomic write:
          // upload to a temp name, back the target up, rename into place,
          // drop the backup — and restore the original if the rename fails.
          const result = await files.write(toSandboxAbsolutePath(arg1!), content);
          if (json) {
            emitJson(result);
            return 0;
          }
          process.stdout.write(
            `${status.ok(`Wrote ${C.bold}${result.path}${C.reset} ${C.dim}(${result.bytes} B)${C.reset}`)}\n`,
          );
          return 0;
        }
        case 'touch': {
          const created = await files.create(toSandboxAbsolutePath(arg1!));
          if (json) {
            emitJson(created);
            return 0;
          }
          process.stdout.write(
            `${status.ok(`Created ${C.bold}${created[0]?.path ?? arg1}${C.reset}`)}\n`,
          );
          return 0;
        }
        case 'mkdir': {
          const dir = toSandboxAbsolutePath(arg1!);
          await files.mkdir(dir);
          if (json) {
            emitJson({ path: dir });
            return 0;
          }
          process.stdout.write(`${status.ok(`Created ${C.bold}${dir}${C.reset}`)}\n`);
          return 0;
        }
        case 'mv': {
          const fromPath = toSandboxAbsolutePath(arg1!);
          const toPath = toSandboxAbsolutePath(arg2!);
          await files.rename(fromPath, toPath);
          if (json) {
            emitJson({ from: fromPath, to: toPath });
            return 0;
          }
          process.stdout.write(`${status.ok(`Moved ${fromPath} → ${C.bold}${toPath}${C.reset}`)}\n`);
          return 0;
        }
        case 'rm': {
          const path = toSandboxAbsolutePath(arg1!);
          // Deletion is recursive server-side, so a mistyped directory takes
          // the whole subtree with it. Ask, unless the caller said not to or
          // there is nobody there to answer.
          const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
          if (!assumeYes && !json && interactive) {
            process.stdout.write(
              `${status.warn(`Deleting ${path} in ${resolved.session.session_id.split('-')[0]} — directories go recursively.`)}\n`,
            );
            if (!(await confirm('Delete it?', false))) {
              process.stdout.write(`${status.info('Left it alone.')}\n`);
              return 0;
            }
          }
          await files.remove(path);
          if (json) {
            emitJson({ path, deleted: true });
            return 0;
          }
          process.stdout.write(`${status.ok(`Deleted ${C.bold}${path}${C.reset}`)}\n`);
          return 0;
        }
      }
      return 0;
    });
  } catch (err) {
    return surfaceApiError(err);
  }
}
