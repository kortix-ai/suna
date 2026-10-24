// `kortix artifacts` (flag `artifacts`): share paths of the project's Files as
// docs (Markdown) and pages (HTML), and list, read, save, version and unshare
// them. The API is the contract; this file only maps flags to it.
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  createArtifact,
  deleteArtifact,
  getArtifact,
  listAccountMembers,
  listArtifactTypes,
  listArtifactVersions,
  listArtifacts,
  readArtifactFile,
  restoreArtifactVersion,
  saveArtifact,
  setArtifactPinned,
  shareArtifactPath,
  updateArtifact,
  type Artifact,
  type ArtifactFileInput,
  type ArtifactListScope,
  type ArtifactType,
  type ArtifactVisibility,
} from '@kortix/sdk';
import { withKortixScope } from '../api/sdk.ts';
import { splitHelp } from '../command-argv.ts';
import { emitJson, fail, missing, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue, takeFlagValues } from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

const HELP = help`Usage: kortix artifacts <subcommand> [options]

An artifact is a path in the project's Files shared as one of two types:
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
                             --visibility private|project|public (default private),
                             --space <slug>, --agent <name> (where it is grouped;
                             default agent: this session's agent)
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
                             --space <slug> (bound to that space)
  info <artifact>            Title, type, path in Files, files, links.
  cat <artifact> [<path>]    Print one file (default the entry).
                             --version <id> reads an old version.
  pull <artifact> <dir>      Download its files, to edit and publish again.
  open <artifact>            Print its links (app, view, public).
  share <artifact>           --visibility private|project|public
                             --with <email|user-id> (repeat) shares a private
                             artifact with those people; --with "" clears.
  rename <artifact> "<title>"
  bind <artifact>            Group it: --space <slug>, --agent <name>, or
                             --clear (project-wide). Grouping only: it grants
                             nothing.
  versions <artifact>        Every save, newest first (from the Files history).
  restore <artifact> <version-id>
                             Write that version back, as a new save.
  pin <artifact> / unpin <artifact>
  rm <artifact>              Stop sharing it. Its files stay in Files.

<artifact> is an artifact id (or its first 8 characters from \`ls\`).

Visibility:
  private   you, and the people you --with (default)
  project   every member of the project
  public    anyone with the link (the "public" link from \`open\`)

Options:
  --project <id>     Project (default: linked, or this session's project).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Exit codes: 0 ok, 1 API error, 2 usage error, 3 version conflict.

Examples:
  kortix artifacts publish report.md --title "Q3 churn report"
  kortix artifacts publish ./deck --visibility project
  kortix artifacts add /Company/Plans/roadmap.md --visibility project
  kortix artifacts share 3f2a1b9c --visibility public
`;

const TYPES = ['doc', 'html'];
const VISIBILITIES = ['private', 'project', 'public'];
const KNOWN = ['types', 'publish', 'add', 'ls', 'list', 'info', 'cat', 'pull', 'open', 'share', 'rename', 'bind', 'versions', 'restore', 'pin', 'unpin', 'rm', 'delete'];

/** The files to publish: a folder's tree, or one file as `index.md` / `index.html`. */
async function collectFiles(path: string): Promise<Record<string, ArtifactFileInput>> {
  const info = await stat(path);
  if (!info.isDirectory()) return { [/\.(md|markdown)$/i.test(path) ? 'index.md' : 'index.html']: await fileInput(path) };
  const out: Record<string, ArtifactFileInput> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out[relative(path, full).split(sep).join('/')] = await fileInput(full);
    }
  };
  await walk(path);
  return out;
}

/** Raw bytes per request: well inside the API's 32 MB and its 25 s request deadline on a slow uplink. */
const BATCH_BYTES = 12 * 1024 * 1024;
const sizeOf = (file: ArtifactFileInput) => (file.content !== undefined ? Buffer.byteLength(file.content) : Math.floor((file.content_base64?.length ?? 0) * 0.75));

/** Split the files into requests of at most BATCH_BYTES, the entry (index.*) in the first. */
function batches(files: Record<string, ArtifactFileInput>): Array<Record<string, ArtifactFileInput>> {
  const paths = Object.keys(files).sort((x, y) => Number(/^index\.(md|html?)$/.test(y)) - Number(/^index\.(md|html?)$/.test(x)));
  const out: Array<Record<string, ArtifactFileInput>> = [];
  let current: Record<string, ArtifactFileInput> = {};
  let size = 0;
  for (const path of paths) {
    const bytes = sizeOf(files[path]!);
    if (size > 0 && size + bytes > BATCH_BYTES) {
      out.push(current);
      current = {};
      size = 0;
    }
    current[path] = files[path]!;
    size += bytes;
  }
  out.push(current);
  return out;
}

const TEXT = /\.(html?|css|m?js|json|txt|md|markdown|csv|svg|xml)$/i;
async function fileInput(path: string): Promise<ArtifactFileInput> {
  const bytes = await readFile(path);
  return TEXT.test(path) ? { content: bytes.toString('utf8') } : { content_base64: bytes.toString('base64') };
}

const short = (id: string) => id.slice(0, 8);
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

function printLinks(a: Artifact) {
  process.stdout.write(`  ${C.dim}files${C.reset}   ${a.path}\n`);
  process.stdout.write(`  ${C.dim}app${C.reset}     ${a.web_url}\n`);
  if (a.public_url) process.stdout.write(`  ${C.dim}public${C.reset}  ${a.public_url}\n`);
  process.stdout.write(`  ${C.dim}view${C.reset}    ${a.view_url}  ${C.dim}(signed, 12 h)${C.reset}\n`);
}

export async function runArtifacts(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const sub = argv[0]!;
  const rest = argv.slice(1);
  let f: {
    json: boolean; projectArg?: string; hostArg?: string; type?: string; title?: string; description?: string;
    visibility?: string; id?: string; baseVersion?: string; version?: string; search?: string;
    with: string[]; mine: boolean; shared: boolean; pinned: boolean; starter: boolean;
    space?: string; agent?: string; clear: boolean;
  };
  try {
    f = {
      json: takeFlagBool(rest, ['--json']),
      projectArg: takeFlagValue(rest, ['--project']),
      hostArg: takeFlagValue(rest, ['--host']),
      type: takeFlagValue(rest, ['--type']),
      title: takeFlagValue(rest, ['--title']),
      description: takeFlagValue(rest, ['--description']),
      visibility: takeFlagValue(rest, ['--visibility']),
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
  } catch (err) {
    return fail((err as Error).message);
  }
  const unknown = rest.find((arg) => arg.startsWith('-') && arg !== '-');
  if (unknown) return fail(`unknown option "${unknown}". Run \`kortix artifacts --help\`.`);
  if (!KNOWN.includes(sub)) return fail(`unknown subcommand "${sub}". Run \`kortix artifacts --help\`.`);
  if (f.type && !TYPES.includes(f.type)) return fail(`--type must be doc or html.`);
  if (f.visibility && !VISIBILITIES.includes(f.visibility)) return fail(`--visibility must be private, project or public.`);
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
        process.stdout.write(`${status.ok(`${verb} "${a.title}" (${a.type}, ${a.visibility})`)} ${C.dim}${short(a.artifact_id)}${C.reset}\n`);
        printLinks(a);
        return 0;
      };

      switch (sub) {
        case 'types': {
          const types = await listArtifactTypes(pid);
          if (a0) {
            const t = types.find((x) => x.type === a0);
            if (!t) return fail(`unknown type "${a0}". One of ${TYPES.join(', ')}.`);
            if (f.json) return out(t, '');
            if (f.starter) return out(null, t.starter);
            process.stdout.write(`${C.bold}${t.name}${C.reset} (${t.type}): ${t.description}\n\nFormat:\n${t.format.split('\n').map((l) => `  - ${l}`).join('\n')}\n\nStarter:\n\n${t.starter}`);
            return 0;
          }
          if (f.json) return out(types, '');
          for (const t of types) process.stdout.write(`${pad(t.type, 7)}${t.description}\n`);
          process.stdout.write(`\nRun \`kortix artifacts types <type>\` for its format and a starter.\n`);
          return 0;
        }
        case 'publish': {
          if (!a0) return missing('a file or a folder');
          let files: Record<string, ArtifactFileInput>;
          try {
            files = await collectFiles(a0);
          } catch {
            return fail(`Cannot read ${a0}.`);
          }
          // A title is a name: an explanation after ':' / ' - ' / '—' / '→' belongs in --description.
          if (f.title && /:|\s[-–—]\s|→/.test(f.title)) {
            process.stderr.write(`${C.dim}hint: a title is a short name ("${f.title.split(/:|\s[-–—]\s|→/)[0]!.trim()}"); put the rest in --description${C.reset}\n`);
          }
          const [first, ...rest] = batches(files);
          let a: Artifact;
          if (f.id) {
            const id = await resolve(f.id);
            if (!id) return 1;
            a = await saveArtifact(pid, id, {
              files: first,
              ...(f.title ? { title: f.title } : {}),
              ...(f.description ? { description: f.description } : {}),
              ...(f.baseVersion ? { base_version: f.baseVersion } : {}),
            });
          } else {
            a = await createArtifact(pid, { files: first, ...meta });
          }
          // The entry went first; the rest of a large folder follows as plain saves.
          for (const [i, batch] of rest.entries()) {
            if (!f.json) process.stderr.write(`${C.dim}uploading ${i + 2} of ${rest.length + 1}${C.reset}\n`);
            a = await saveArtifact(pid, a.artifact_id, { files: batch });
          }
          return shared(a, f.id ? 'Saved' : 'Published');
        }
        case 'add': {
          if (!a0) return missing('a path in Files');
          return shared(await shareArtifactPath(pid, { path: a0.startsWith('/') ? a0 : `/${a0}`, ...meta }), 'Shared');
        }
        case 'ls':
        case 'list': {
          const scope: ArtifactListScope = f.pinned ? 'pinned' : f.mine ? 'mine' : f.shared ? 'shared' : 'all';
          const list = await listArtifacts(pid, { scope, type: f.type as ArtifactType | undefined, q: f.search, space: f.space });
          if (f.json) return out(list, '');
          if (!list.length) return out(null, 'No artifacts yet. Publish one with `kortix artifacts publish <file>`.');
          for (const a of list) {
            process.stdout.write(`${C.dim}${short(a.artifact_id)}${C.reset}  ${pad(a.type, 6)}${pad(a.visibility, 9)}${pad(ago(a.updated_at), 9)}${a.pinned ? '★ ' : ''}${a.title}  ${C.dim}${a.path}${C.reset}\n`);
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
            process.stdout.write(`  ${a.type} · ${a.visibility}${a.shared_with_user_ids.length ? ` + ${a.shared_with_user_ids.length} people` : ''} · by ${a.created_by.name ?? a.created_by.email ?? a.created_by.user_id} · updated ${ago(a.updated_at)}${a.can_edit ? '' : ' · view only'}\n`);
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
              const project = await ctx.client.get<{ account_id: string }>(`/projects/${pid}`);
              const members = await listAccountMembers(project.account_id);
              for (const email of emails) {
                const m = members.find((x) => x.email?.toLowerCase() === email.toLowerCase());
                if (!m) return fail(`${email} is not a member of this account.`);
                people.push(m.user_id);
              }
            }
          }
          const a = await updateArtifact(pid, id, {
            ...(f.visibility ? { visibility: f.visibility as ArtifactVisibility } : {}),
            ...(people ? { shared_with_user_ids: people } : {}),
          });
          if (f.json) return out(a, '');
          process.stdout.write(`${status.ok(`"${a.title}" is ${a.visibility}${a.shared_with_user_ids.length ? `, shared with ${a.shared_with_user_ids.length} people` : ''}`)}\n`);
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
          return out(a, status.ok(`"${a.title}" is in ${a.space ?? (a.agent ? `${a.agent}'s space` : 'no space (project-wide)')}`));
        }
        case 'versions': {
          const id = await resolve(a0);
          if (!id) return a0 ? 1 : missing('an artifact id');
          const versions = await listArtifactVersions(pid, id);
          if (f.json) return out(versions, '');
          if (!versions.length) return out(null, 'No saves in the recent Files history.');
          for (const v of versions) process.stdout.write(`${pad(`#${v.number}`, 6)}${pad(ago(v.created_at), 9)}${C.dim}${v.id}${C.reset}\n`);
          return 0;
        }
        case 'restore': {
          const id = await resolve(a0);
          if (!id) return a0 ? 1 : missing('an artifact id');
          if (!a1) return missing('the version id to restore (from `kortix artifacts versions`)');
          const a = await restoreArtifactVersion(pid, id, a1);
          return out(a, status.ok(`Restored "${a.title}" to that version, as a new save`));
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
