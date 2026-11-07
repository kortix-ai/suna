// `kortix artifacts`: share paths of the workspace's Files as
// docs (Markdown) and pages (HTML), and list, read, save, version and unshare
// them. The API is the contract; this file only maps flags to it.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  deleteArtifact,
  getArtifact,
  listAccountMembers,
  listArtifacts,
  readArtifactFile,
  setArtifactPinned,
  updateArtifact,
  type Artifact,
  type ArtifactListScope,
  type ArtifactType,
  type ArtifactVisibility,
} from '@kortix/sdk';
import { formatRelative } from '@kortix/shared';
import { withKortixScope } from '../api/sdk.ts';
import { splitHelp, fromWorkspaceAlias, toWorkspaceAlias } from '../command-argv.ts';
import { emitJson, fail, missing, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue, takeFlagValues } from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import { artifactsPublish } from './artifacts-publish.ts';
import { artifactsTypes } from './artifacts-types.ts';
import { TYPES, short, type ArtifactsFlags, type ArtifactsRun } from './artifacts-run.ts';
const HELP = help`Usage: kortix artifacts <subcommand> [options]

An artifact is a path in the workspace's Files shared as one of two types:
  doc    a Markdown file people read and edit in place (export as PDF)
  html   an HTML page, or a folder with index.html and its assets: a deck,
         a dashboard, a mockup, a tool
The files are plain files in Files: edit them there (in a session, under
/drives) or with \`publish --id\`. Every save is a version.

Subcommands:
  types [<type>]             The types. With a type: its format and a starter
                             (--starter prints only the starter).
  publish <file|dir>         Upload and share as a new artifact, stored in your
                             folder in Files under Artifacts/. A .md file is a
                             doc; an .html file or a folder with index.html is
                             a page. Everything in the folder (images, video,
                             scripts) is uploaded with it; a folder over 12 MB
                             goes up in several saves. Prints the link.
                             --title "<title>" (default: the doc's # heading or
                             the page's <title>), --description "<sentence>",
                             --visibility private|workspace|public (default private),
                             --space <slug>, --agent <name> (where it is grouped;
                             default agent: this session's agent; spaces are
                             Work in progress, shown only with the workspace flag
                             \`chat\` on)
  add <path>                 Share a folder already in Files (it holds an
                             index.md or index.html; an index file stands for
                             its folder). Same options.
  publish <file|dir> --id <artifact>
                             Save the files into that artifact. A doc takes a
                             .md file. --base-version <v> refuses the save
                             (exit 3) when someone saved after version <v>
                             (the entry_version from \`info\` or \`pull\`).
  ls                         Artifacts you may view, newest first.
                             --mine, --shared (others shared), --pinned,
                             --type doc|html, --search "<text>",
                             --space <slug> (bound to that space; flag
                             \`chat\`)
  info <artifact>            Title, type, path in Files, files, links.
  cat <artifact> [<path>]    Print one file (default the entry).
                             --version <id> reads an old version.
  pull <artifact> <dir>      Download its files, to edit and publish again.
  open <artifact>            Print its links (app, view, public).
  share <artifact>           --visibility private|workspace|public
                             --with <email|user-id> (repeat) shares a private
                             artifact with those people; --with "" clears.
  rename <artifact> "<title>"
  bind <artifact>            Group it: --space <slug>, --agent <name>, or
                             --clear (workspace-wide). Grouping only: it grants
                             nothing.
  versions <artifact>        Every save, newest first (from the Files history).
  restore <artifact> <version-id>
                             Write that version back, as a new save.
  pin <artifact> / unpin <artifact>
  rm <artifact>              Stop sharing it. Its files stay in Files.

<artifact> is an artifact id (or its first 8 characters from \`ls\`).

Visibility:
  private    you, and the people you --with (default)
  workspace  every member of the workspace
  public     anyone with the link (the "public" link from \`open\`)

Options:
  --workspace <id>   Workspace (default: linked, or this session's workspace).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Exit codes: 0 ok, 1 API error, 2 usage error, 3 version conflict.

Examples:
  kortix artifacts publish report.md --title "Q3 churn report"
  kortix artifacts publish ./deck --visibility workspace
  kortix artifacts add /Company/Plans/roadmap.md --visibility workspace
  kortix artifacts share 3f2a1b9c --visibility public
`;

const VISIBILITIES = ['private', 'project', 'public'];
const KNOWN = ['types', 'publish', 'add', 'ls', 'list', 'info', 'cat', 'pull', 'open', 'share', 'rename', 'bind', 'versions', 'restore', 'pin', 'unpin', 'rm', 'delete'];

function printLinks(a: Artifact) {
  process.stdout.write(`  ${C.dim}files${C.reset}   ${a.path}\n`);
  process.stdout.write(`  ${C.dim}app${C.reset}     ${a.web_url}\n`);
  if (a.public_url) process.stdout.write(`  ${C.dim}public${C.reset}  ${a.public_url}\n`);
  process.stdout.write(`  ${C.dim}view${C.reset}    ${a.view_url}  ${C.dim}(signed, 12 h)${C.reset}\n`);
}


async function artifactsRead(sub: string, { pid, client, f, a0, a1, resolve, out }: ArtifactsRun): Promise<number> {
  switch (sub) {
    case 'ls':
    case 'list': {
      const scope: ArtifactListScope = f.pinned ? 'pinned' : f.mine ? 'mine' : f.shared ? 'shared' : 'all';
      const list = await listArtifacts(pid, { scope, type: f.type as ArtifactType | undefined, q: f.search, space: f.space });
      if (f.json) return out(list, '');
      if (!list.length) return out(null, 'No artifacts yet. Publish one with `kortix artifacts publish <file>`.');
      for (const a of list) {
        process.stdout.write(`${C.dim}${short(a.artifact_id)}${C.reset}  ${pad(a.type, 6)}${pad(toWorkspaceAlias(a.visibility), 11)}${pad(formatRelative(a.updated_at, { maxRelativeDays: null }) ?? '—', 9)}${a.pinned ? '★ ' : ''}${a.title}  ${C.dim}${a.path}${C.reset}\n`);
      }
      return 0;
    }
    case 'info':
    case 'open': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      const a = await getArtifact(pid, id, f.version ? { version: f.version } : {});
      if (f.json) return out(a, '');
      process.stdout.write(`${C.bold}${a.title}${C.reset}  ${C.dim}${a.artifact_id}${C.reset}\n`);
      if (sub === 'info') {
        process.stdout.write(`  ${a.type} · ${toWorkspaceAlias(a.visibility)}${a.shared_with_user_ids.length ? ` + ${a.shared_with_user_ids.length} people` : ''} · by ${a.created_by.name ?? a.created_by.email ?? a.created_by.user_id} · updated ${formatRelative(a.updated_at, { maxRelativeDays: null }) ?? '—'}${a.can_edit ? '' : ' · view only'}\n`);
        process.stdout.write(`  ${C.dim}entry_version${C.reset} ${a.entry_version ?? '-'}\n`);
        if (a.description) process.stdout.write(`  ${a.description}\n`);
        for (const file of a.version.files) process.stdout.write(`  ${C.dim}${pad(String(file.size), 9)}${C.reset}${file.path}\n`);
      }
      printLinks(a);
      return 0;
    }
    case 'cat': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      const blob = await readArtifactFile(pid, id, { ...(a1 ? { path: a1 } : {}), ...(f.version ? { version: f.version } : {}) });
      process.stdout.write(new Uint8Array(await blob.arrayBuffer()));
      return 0;
    }
    case 'pull': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      if (!a1) return missing('a folder to download into');
      const a = await getArtifact(pid, id, f.version ? { version: f.version } : {});
      for (const file of a.version.files) {
        const target = join(a1, ...file.path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        const blob = await readArtifactFile(pid, id, { path: file.path, ...(f.version ? { version: f.version } : {}) });
        await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
      }
      const source = a.version.files.length === 1 ? join(a1, a.version.files[0]!.path) : a1;
      return out({ dir: a1, entry_version: a.entry_version, files: a.version.files.map((x) => x.path) },
        status.ok(`Downloaded ${a.version.files.length} file(s) to ${a1}. Save changes with \`kortix artifacts publish ${source} --id ${short(id)} --base-version ${a.entry_version}\`.`));
    }
    case 'share': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      if (!f.visibility && !f.with.length) return missing('--visibility or --with');
      let people: string[] | undefined;
      if (f.with.length) {
        const wanted = f.with.filter(Boolean);
        const emails = wanted.filter((w) => w.includes('@'));
        people = wanted.filter((w) => !w.includes('@'));
        if (emails.length) {
          const project = await client.get<{ account_id: string }>(`/workspaces/${pid}`);
          const members = await listAccountMembers(project.account_id);
          for (const email of emails) {
            const m = members.find((x) => x.email?.toLowerCase() === email.toLowerCase());
            if (!m) return fail(`${email} is not a member of this workspace.`);
            people.push(m.user_id);
          }
        }
      }
      const a = await updateArtifact(pid, id, {
        ...(f.visibility ? { visibility: f.visibility as ArtifactVisibility } : {}),
        ...(people ? { shared_with_user_ids: people } : {}),
      });
      if (f.json) return out(a, '');
      process.stdout.write(`${status.ok(`"${a.title}" is ${toWorkspaceAlias(a.visibility)}${a.shared_with_user_ids.length ? `, shared with ${a.shared_with_user_ids.length} people` : ''}`)}\n`);
      printLinks(a);
      return 0;
    }
    case 'rename': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      if (!a1) return missing('a title');
      const a = await updateArtifact(pid, id, { title: a1 });
      return out(a, status.ok(`Renamed to "${a.title}"`));
    }
    case 'bind': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      if (!f.clear && f.space === undefined && f.agent === undefined) return missing('--space <slug>, --agent <name> or --clear');
      const a = await updateArtifact(pid, id, f.clear ? { space: null, agent: null } : { ...(f.space ? { space: f.space } : {}), ...(f.agent ? { agent: f.agent } : {}) });
      return out(a, status.ok(`"${a.title}" is in ${a.space ?? (a.agent ? `${a.agent}'s space` : 'no space (workspace-wide)')}`));
    }
    case 'pin':
    case 'unpin': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      const a = await setArtifactPinned(pid, id, sub === 'pin');
      return out(a, status.ok(`${sub === 'pin' ? 'Pinned' : 'Unpinned'} "${a.title}"`));
    }
    default: {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      await deleteArtifact(pid, id);
      return out({ deleted: true, artifact_id: id }, status.ok(`Stopped sharing ${short(id)}; its files stay in Files`));
    }
  }
}

function parseFlags(rest: string[]): ArtifactsFlags {
  return {
    json: takeFlagBool(rest, ['--json']),
    projectArg: takeFlagValue(rest, ['--project', '--workspace']),
    hostArg: takeFlagValue(rest, ['--host']),
    type: takeFlagValue(rest, ['--type']),
    title: takeFlagValue(rest, ['--title']),
    description: takeFlagValue(rest, ['--description']),
    visibility: fromWorkspaceAlias(takeFlagValue(rest, ['--visibility'])),
    id: takeFlagValue(rest, ['--id']),
    baseVersion: takeFlagValue(rest, ['--base-version']),
    version: takeFlagValue(rest, ['--version']),
    search: takeFlagValue(rest, ['--search']),
    with: takeFlagValues(rest, ['--with']),
    mine: takeFlagBool(rest, ['--mine']),
    shared: takeFlagBool(rest, ['--shared']),
    pinned: takeFlagBool(rest, ['--pinned']),
    starter: takeFlagBool(rest, ['--starter']),
    space: takeFlagValue(rest, ['--space']),
    agent: takeFlagValue(rest, ['--agent']),
    clear: takeFlagBool(rest, ['--clear']),
  };
}

export async function runArtifacts(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const sub = argv[0]!;
  const rest = argv.slice(1);
  let f: ArtifactsFlags;
  try {
    f = parseFlags(rest);
  } catch (err) {
    return fail((err as Error).message);
  }
  const unknown = rest.find((arg) => arg.startsWith('-') && arg !== '-');
  if (unknown) return fail(`unknown option "${unknown}". Run \`kortix artifacts --help\`.`);
  if (!KNOWN.includes(sub)) return fail(`unknown subcommand "${sub}". Run \`kortix artifacts --help\`.`);
  if (f.type && !TYPES.includes(f.type)) return fail(`--type must be doc or html.`);
  if (f.visibility && !VISIBILITIES.includes(f.visibility)) return fail(`--visibility must be private, workspace or public.`);
  if (f.space !== undefined && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(f.space)) return fail(`--space "${f.space}" is not a space slug (lowercase letters, digits, "-" or "_", at most 63 characters).`);
  if (f.agent !== undefined && !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(f.agent)) return fail(`--agent "${f.agent}" is not an agent name.`);
  const ctx = await resolveProjectContext({ projectArg: f.projectArg, hostArg: f.hostArg });
  if (!ctx) return 1;
  const pid = ctx.projectId;
  const out = (payload: unknown, line: string) => {
    if (f.json) emitJson(payload);
    else process.stdout.write(`${line}\n`);
    return 0;
  };
  const meta = {
    ...(f.title ? { title: f.title } : {}),
    ...(f.description ? { description: f.description } : {}),
    ...(f.visibility ? { visibility: f.visibility as ArtifactVisibility } : {}),
    ...(f.space ? { space: f.space } : {}),
    ...(f.agent ? { agent: f.agent } : {}),
  };

  try {
    return await withKortixScope(ctx.auth, async () => {
      /** A full id, or the one artifact whose id starts with the given prefix. */
      const resolve = async (ref: string | undefined): Promise<string | null> => {
        if (!ref) return null;
        if (/^[0-9a-f-]{36}$/i.test(ref)) return ref;
        const hits = (await listArtifacts(pid, { limit: 200 })).filter((a) => a.artifact_id.startsWith(ref.toLowerCase()));
        if (hits.length === 1) return hits[0]!.artifact_id;
        process.stderr.write(`${status.err(hits.length ? `"${ref}" matches ${hits.length} artifacts; pass more of the id.` : `No artifact "${ref}" you may view.`)}\n`);
        return null;
      };
      const [a0, a1] = rest;
      const shared = (a: Artifact, verb: string) => {
        if (f.json) return out(a, '');
        process.stdout.write(`${status.ok(`${verb} "${a.title}" (${a.type}, ${toWorkspaceAlias(a.visibility)})`)} ${C.dim}${short(a.artifact_id)}${C.reset}\n`);
        printLinks(a);
        return 0;
      };

      const run: ArtifactsRun = { pid, client: ctx.client, f, a0, a1, meta, resolve, out, shared };
      switch (sub) {
        case 'types':
          return artifactsTypes(run);
        case 'publish':
        case 'add':
        case 'versions':
        case 'restore':
          return artifactsPublish(sub, run);
        default:
          return artifactsRead(sub, run);
      }
    });
  } catch (err) {
    const code = (err as { details?: { code?: string } })?.details?.code ?? (err as { code?: string })?.code;
    if (code === 'version_conflict') {
      process.stderr.write(`${status.err((err as Error).message)}\n`);
      return 3;
    }
    return surfaceApiError(err);
  }
}
