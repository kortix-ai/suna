import { readFile } from 'node:fs/promises';
import {
  deleteDriveFile,
  type Drive,
  type FolderPrincipalType,
  getFolderAccess,
  getProjectDrive,
  listDriveFolder,
  listFolderPrincipals,
  makeDriveFolder,
  moveDriveFile,
  readDriveFile,
  shareFolder,
  unshareFolder,
  uploadDriveFile,
} from '@kortix/sdk';
import { withKortixScope } from '../api/sdk.ts';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

const HELP = help`Usage: kortix drive <subcommand> [options]

The project's Files: one drive of folders (/Company, /Users/<name>, team
folders). Every command acts as you, with your folder access. Inside a
session it acts as the person who started the session.

Subcommands:
  ls [<path>]                       List a folder (default: the top of Files).
  cat <path>                        Print a file's bytes.
  put <local> <path>                Upload a local file to <path>.
  mkdir <path>                      Create a folder.
  mv <from> <to>                    Move or rename a file or folder.
  rm <path> [-r]                    Delete a file, or a folder with -r.
  access <path>                     Show who has access to a folder.
  share <path> (--everyone | --user <email> | --agent <name>) [--write]
                                    Share a folder (read, or write with --write).
  unshare <path> <grantId>          Stop one share (the id from \`access\`).

Options:
  -r, --recursive    rm: delete a folder and everything in it.
  --everyone         share: everyone in the project.
  --user <email>     share: a member of the account.
  --agent <name>     share: one of the project's agents.
  --write            share: give write instead of read.
  --json             Emit the API payload as JSON.
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.

Sharing from inside a session works only in your own private session.
`;

/** Paths in Files are absolute: `Company/x` means `/Company/x`. */
const abs = (p: string) => (p.startsWith('/') ? p : `/${p}`);

export async function runDrive(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;

  const sub = argv[0];
  const rest = argv.slice(1);
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let user: string | undefined;
  let agent: string | undefined;
  let everyone = false;
  let write = false;
  let recursive = false;
  let json = false;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    user = takeFlagValue(rest, ['--user']);
    agent = takeFlagValue(rest, ['--agent']);
    everyone = takeFlagBool(rest, ['--everyone']);
    write = takeFlagBool(rest, ['--write']);
    recursive = takeFlagBool(rest, ['-r', '--recursive']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const [a, b] = rest.filter((x) => !x.startsWith('-'));
  const ctx = await resolveProjectContext({ projectArg: projectFlag, hostArg: hostFlag });
  if (!ctx) return 1;

  try {
    return await withKortixScope(ctx.auth, async () => {
      const drive = await getProjectDrive(ctx.projectId);
      const id = drive.driveId;
      const done = (payload: unknown, line: string) => {
        if (json) emitJson(payload);
        else process.stdout.write(`${status.ok(line)}\n`);
        return 0;
      };
      switch (sub) {
        case 'ls':
          return driveLs(drive, abs(a ?? '/'), json);
        case 'cat': {
          if (!a) return missing('a file path');
          const { blob } = await readDriveFile(id, abs(a));
          process.stdout.write(new Uint8Array(await blob.arrayBuffer()));
          return 0;
        }
        case 'put': {
          if (!a || !b) return missing('a local file and a path in Files');
          const result = await uploadDriveFile(id, abs(b), new Uint8Array(await readFile(a)));
          return done(result, `Uploaded ${a} to ${abs(b)}`);
        }
        case 'mkdir':
          if (!a) return missing('a folder path');
          return done(await makeDriveFolder(id, abs(a)), `Created ${abs(a)}`);
        case 'mv':
          if (!a || !b) return missing('a source and a destination path');
          return done(await moveDriveFile(id, abs(a), abs(b)), `Moved ${abs(a)} to ${abs(b)}`);
        case 'rm':
          if (!a) return missing('a path');
          await deleteDriveFile(id, abs(a), { recursive });
          return done({ path: abs(a), deleted: true }, `Deleted ${abs(a)}`);
        case 'access':
          if (!a) return missing('a folder path');
          return driveAccess(id, abs(a), json);
        case 'share': {
          if (!a) return missing('a folder path');
          if ([everyone, !!user, !!agent].filter(Boolean).length !== 1) {
            return fail('Pass exactly one of --everyone, --user <email>, --agent <name>.');
          }
          let principalType: FolderPrincipalType = 'project';
          let principalId: string | undefined;
          if (agent) {
            principalType = 'agent';
            principalId = agent;
          } else if (user) {
            const { people } = await listFolderPrincipals(id);
            const person = people.find((p) => p.label.toLowerCase() === user!.toLowerCase());
            if (!person) return fail(`No member ${user} in this account.`);
            principalType = 'user';
            principalId = person.id;
          }
          const level = write ? 'write' : 'read';
          const result = await shareFolder(id, { path: abs(a), principalType, principalId, level });
          return done(result, `Shared ${abs(a)} with ${user ?? agent ?? 'everyone'} (${level})`);
        }
        case 'unshare':
          if (!a || !b) return missing('a folder path and a grant id (from `kortix drive access`)');
          return done(await unshareFolder(id, b), `Stopped share ${b} on ${abs(a)}`);
        default:
          process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
          return 2;
      }
    });
  } catch (err) {
    return surfaceApiError(err);
  }
}

async function driveLs(drive: Drive, path: string, json: boolean): Promise<number> {
  const folder = await listDriveFolder(drive.driveId, path);
  if (json) {
    emitJson(folder);
    return 0;
  }
  if (folder.entries.length === 0) {
    process.stdout.write(`  ${C.dim}${path} is empty.${C.reset}\n`);
    return 0;
  }
  for (const e of folder.entries) {
    const name = e.type === 'dir' ? `${e.name}/` : e.name;
    process.stdout.write(`  ${pad(name, 40)} ${C.faded}${e.access}${e.shared ? ' · shared' : ''}${C.reset}\n`);
  }
  return 0;
}

async function driveAccess(driveId: string, path: string, json: boolean): Promise<number> {
  const view = await getFolderAccess(driveId, path);
  if (json) {
    emitJson(view);
    return 0;
  }
  process.stdout.write(`  ${C.dim}${view.path} · your access: ${view.access}${C.reset}\n`);
  for (const g of view.grants) {
    const from = g.inherited ? ` ${C.faded}(from ${g.path})${C.reset}` : '';
    process.stdout.write(`  ${pad(g.label, 32)} ${pad(g.level, 7)} ${C.faded}${g.grantId}${C.reset}${from}\n`);
  }
  return 0;
}
