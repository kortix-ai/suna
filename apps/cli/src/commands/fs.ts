/**
 * `kortix fs` — shared filesystems, "a Google Drive between the agents".
 *
 * This is also how an AGENT reaches them. The pi worker runs exactly four
 * tools (bash, read, write, edit) and gains no fifth: `bash` executes in the
 * session ENVIRONMENT, and that image carries this binary at
 * /usr/local/bin/kortix (apps/sandbox/Dockerfile), already scoped to the
 * project by the sandbox token. So `kortix fs put …` from a bash tool call is
 * the agent surface — no new tool, no new authority, and the worker's
 * minimalism stays intact.
 *
 * Bytes move through stdin/stdout by default so the common agent shapes work
 * without a temp file:
 *   echo "state" | kortix fs put notes plan.md
 *   kortix fs get notes plan.md | head
 */
import { readFile, writeFile } from 'node:fs/promises';
import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

const HELP = help`Usage: kortix fs <subcommand> [options]

Shared filesystems — named volumes of state every agent in this project can
read and write. NOT the repo: \`kortix files\` browses git (config, versioned,
cloned per session); a filesystem is state, mutable, and alive whether or not
any session is.

Bytes move through stdin/stdout by default, so no temp file is needed:
  echo "handoff" | kortix fs put notes plan.md
  kortix fs get notes plan.md | head

Subcommands:
  ls                                List the project's filesystems.
  create <name> [--description D]   Create one (idempotent by name).
  rm <name>                         Delete one and every file in it.
  list <name> [--prefix P]          List files, optionally under a prefix.
  put <name> <path> [--file F]      Write bytes from stdin, or from --file.
  get <name> <path> [-o FILE]       Read bytes to stdout, or into a file.
  del <name> <path>                 Delete one file.

Options:
  --project <p>                     Project id or slug (default: linked).
  --content-type <t>                Content type for put (default: guessed).
  --limit <n>                       Max rows for list.
  --json                            Machine-readable output.
`;

/** Enough of a guess to keep text readable in a browser; explicit flag wins. */
export function guessContentType(path: string): string {
  const ext = path.toLowerCase().replace(/^.*\./, '');
  const map: Record<string, string> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    log: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    html: 'text/html',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export async function runFs(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let prefix: string | undefined;
  let limit: string | undefined;
  let out: string | undefined;
  let file: string | undefined;
  let description: string | undefined;
  let contentType: string | undefined;
  let json = false;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    prefix = takeFlagValue(rest, ['--prefix']);
    limit = takeFlagValue(rest, ['--limit']);
    out = takeFlagValue(rest, ['-o', '--out']);
    file = takeFlagValue(rest, ['-f', '--file']);
    description = takeFlagValue(rest, ['--description']);
    contentType = takeFlagValue(rest, ['--content-type']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  const positional = rest.filter((a) => !a.startsWith('-'));
  const ctx = await resolveProjectContext({ projectArg: projectFlag, hostArg: hostFlag });
  if (!ctx) return 1;
  const fs = () => kortixFromAuth(ctx.auth).project(ctx.projectId).filesystems;

  try {
    switch (sub) {
      case 'ls': {
        const rows = await withKortixScope(ctx.auth, () => fs().list());
        if (json) {
          emitJson(rows);
          return 0;
        }
        if (rows.length === 0) {
          process.stdout.write(`${status.info('no filesystems yet — kortix fs create <name>')}\n`);
          return 0;
        }
        for (const r of rows) {
          process.stdout.write(`${pad(r.name, 24)} ${C.dim}${r.description ?? ''}${C.reset}\n`);
        }
        return 0;
      }

      case 'create': {
        const name = positional[0];
        if (!name) {
          process.stderr.write(`${status.err('usage: kortix fs create <name>')}\n`);
          return 2;
        }
        const created = await withKortixScope(ctx.auth, () =>
          fs().create({ name, ...(description ? { description } : {}) }),
        );
        if (json) {
          emitJson(created);
          return 0;
        }
        process.stdout.write(`${status.ok(`filesystem ${created.name}`)}\n`);
        return 0;
      }

      case 'rm': {
        const name = positional[0];
        if (!name) {
          process.stderr.write(`${status.err('usage: kortix fs rm <name>')}\n`);
          return 2;
        }
        await withKortixScope(ctx.auth, () => fs().remove(name));
        process.stdout.write(`${status.ok(`deleted ${name}`)}\n`);
        return 0;
      }

      case 'list': {
        const name = positional[0];
        if (!name) {
          process.stderr.write(`${status.err('usage: kortix fs list <name>')}\n`);
          return 2;
        }
        const files = await withKortixScope(ctx.auth, () =>
          fs().files(name, {
            ...(prefix ? { prefix } : {}),
            ...(limit ? { limit: Number(limit) } : {}),
          }),
        );
        if (json) {
          emitJson(files);
          return 0;
        }
        if (files.length === 0) {
          process.stdout.write(`${status.info('empty')}\n`);
          return 0;
        }
        for (const f of files) {
          process.stdout.write(`${pad(f.path, 40)} ${C.dim}${humanSize(f.size)}${C.reset}\n`);
        }
        return 0;
      }

      case 'put': {
        const [name, path] = positional;
        if (!name || !path) {
          process.stderr.write(
            `${status.err('usage: kortix fs put <name> <path> [--file F]  (or pipe stdin)')}\n`,
          );
          return 2;
        }
        const bytes = file ? new Uint8Array(await readFile(file)) : await readStdin();
        if (bytes.byteLength === 0 && !file) {
          process.stderr.write(
            `${status.err('nothing on stdin — pipe content or pass --file')}\n`,
          );
          return 2;
        }
        const written = await withKortixScope(ctx.auth, () =>
          fs().write(name, path, bytes, { contentType: contentType ?? guessContentType(path) }),
        );
        if (json) {
          emitJson(written);
          return 0;
        }
        process.stdout.write(
          `${status.ok(`${written.path} ${C.dim}${humanSize(written.size)} ${written.sha256.slice(0, 12)}${C.reset}`)}\n`,
        );
        return 0;
      }

      case 'get': {
        const [name, path] = positional;
        if (!name || !path) {
          process.stderr.write(`${status.err('usage: kortix fs get <name> <path> [-o FILE]')}\n`);
          return 2;
        }
        const got = await withKortixScope(ctx.auth, () => fs().read(name, path));
        if (out) {
          await writeFile(out, got.bytes);
          process.stdout.write(`${status.ok(`wrote ${out} ${C.dim}${humanSize(got.bytes.length)}${C.reset}`)}\n`);
          return 0;
        }
        // Bytes to stdout, unchanged: this is what makes `kortix fs get … | …`
        // work for an agent. No trailing newline is added — the file's bytes
        // are the file's bytes.
        process.stdout.write(Buffer.from(got.bytes));
        return 0;
      }

      case 'del': {
        const [name, path] = positional;
        if (!name || !path) {
          process.stderr.write(`${status.err('usage: kortix fs del <name> <path>')}\n`);
          return 2;
        }
        await withKortixScope(ctx.auth, () => fs().removeFile(name, path));
        process.stdout.write(`${status.ok(`deleted ${path}`)}\n`);
        return 0;
      }

      default:
        process.stderr.write(`${status.err(`unknown subcommand: ${sub}`)}\n`);
        process.stdout.write(HELP);
        return 2;
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}
