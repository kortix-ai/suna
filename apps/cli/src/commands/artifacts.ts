// `kortix artifacts` (flag `artifacts`): publish HTML pages — docs, slides,
// boards, dashboards, pages — to the project, and list, read, share, version
// and delete them. The API is the contract; this file only maps flags to it.
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
  publishArtifactVersion,
  readArtifactFile,
  restoreArtifactVersion,
  setArtifactPinned,
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

An artifact is an HTML page published to the project: a doc, a slide deck, a
design board, a dashboard, or any page. Each publish is a new version. People
open it in the Kortix app (Artifacts), and a share link can make it public.

Subcommands:
  types [<type>]             The types. With a type: its format and a starter
                             page to copy (--starter prints only the page).
  publish <file|dir>         Publish a new artifact. A file is published as
                             index.html; a folder publishes every file in it
                             (it needs an index.html). Prints the link.
                             --type page|doc|slides|board|dashboard (default page)
                             --title "<title>" (default: the page's <title>)
                             --description "<one sentence>"
                             --visibility private|project|public (default private)
  publish <file|dir> --id <artifact>
                             Publish a new version of that artifact. Files you
                             leave out are kept. --remove <path> drops one.
                             --base-version <n> refuses if someone published
                             after version n (exit 3).
  ls                         Artifacts you may view, newest first.
                             --mine, --shared (others made), --pinned,
                             --type <type>, --search "<text>"
  info <artifact>            Title, type, visibility, versions, files, links.
  cat <artifact> [<path>]    Print one file's source (default index.html).
                             --version <n> reads an old version.
  pull <artifact> <dir>      Download every file, to edit and publish again.
  open <artifact>            Print its links (app, view, public).
  share <artifact>           --visibility private|project|public
                             --with <email|user-id> (repeat) shares a private
                             artifact with those people; --with "" clears.
  rename <artifact> "<title>"
  versions <artifact>        Every version, newest first.
  restore <artifact> <n>     Make version n the current version again.
  pin <artifact> / unpin <artifact>
  rm <artifact>              Delete it, every version and file. Its creator
                             or a project manager.

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
  kortix artifacts types slides
  kortix artifacts publish report.html --type doc --title "Q3 churn report"
  kortix artifacts publish ./deck --type slides --visibility project
  kortix artifacts publish report.html --id 3f2a1b9c --base-version 2
  kortix artifacts share 3f2a1b9c --visibility public
`;

const TYPES = ['page', 'doc', 'slides', 'board', 'dashboard'];
const VISIBILITIES = ['private', 'project', 'public'];
const KNOWN = ['types', 'publish', 'ls', 'list', 'info', 'cat', 'pull', 'open', 'share', 'rename', 'versions', 'restore', 'pin', 'unpin', 'rm', 'delete'];

/** Every file under a folder, as published path → content. */
async function collectFiles(path: string): Promise<Record<string, ArtifactFileInput>> {
  const info = await stat(path);
  if (!info.isDirectory()) return { 'index.html': await fileInput(path) };
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

const TEXT = /\.(html?|css|m?js|json|txt|md|csv|svg|xml)$/i;
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
    visibility?: string; id?: string; label?: string; baseVersion?: string; version?: string; search?: string;
    remove: string[]; with: string[]; mine: boolean; shared: boolean; pinned: boolean; starter: boolean;
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
      label: takeFlagValue(rest, ['--label']),
      baseVersion: takeFlagValue(rest, ['--base-version']),
      version: takeFlagValue(rest, ['--version']),
      search: takeFlagValue(rest, ['--search']),
      remove: takeFlagValues(rest, ['--remove']),
      with: takeFlagValues(rest, ['--with']),
      mine: takeFlagBool(rest, ['--mine']),
      shared: takeFlagBool(rest, ['--shared']),
      pinned: takeFlagBool(rest, ['--pinned']),
      starter: takeFlagBool(rest, ['--starter']),
    };
  } catch (err) {
    return fail((err as Error).message);
  }
  const unknown = rest.find((arg) => arg.startsWith('-') && arg !== '-');
  if (unknown) return fail(`unknown option "${unknown}". Run \`kortix artifacts --help\`.`);
  if (!KNOWN.includes(sub)) return fail(`unknown subcommand "${sub}". Run \`kortix artifacts --help\`.`);
  if (f.type && !TYPES.includes(f.type)) return fail(`--type must be one of ${TYPES.join(', ')}.`);
  if (f.visibility && !VISIBILITIES.includes(f.visibility)) return fail(`--visibility must be private, project or public.`);
  const version = f.version ? Number(f.version) : undefined;
  if (f.version && !(Number.isInteger(version) && version! > 0)) return fail('--version must be a version number.');
  const baseVersion = f.baseVersion ? Number(f.baseVersion) : undefined;
  if (f.baseVersion && !(Number.isInteger(baseVersion) && baseVersion! > 0)) return fail('--base-version must be a version number.');

  const ctx = await resolveProjectContext({ projectArg: f.projectArg, hostArg: f.hostArg });
  if (!ctx) return 1;
  const pid = ctx.projectId;
  const out = (payload: unknown, line: string) => {
    if (f.json) emitJson(payload);
    else process.stdout.write(`${line}\n`);
    return 0;
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

      switch (sub) {
        case 'types': {
          const types = await listArtifactTypes(pid);
          if (a0) {
            const t = types.find((x) => x.type === a0);
            if (!t) return fail(`unknown type "${a0}". One of ${TYPES.join(', ')}.`);
            if (f.json) return out(t, '');
            if (f.starter) return out(null, t.starter);
            process.stdout.write(`${C.bold}${t.name}${C.reset} (${t.type}): ${t.description}\n\nFormat:\n${t.format.split('\n').map((l) => `  - ${l}`).join('\n')}\n\nStarter page:\n\n${t.starter}`);
            return 0;
          }
          if (f.json) return out(types, '');
          for (const t of types) process.stdout.write(`${pad(t.type, 11)}${t.description}\n`);
          process.stdout.write(`\nRun \`kortix artifacts types <type>\` for its format and a starter page.\n`);
          return 0;
        }
        case 'publish': {
          if (!a0) return missing('an HTML file or a folder');
          let files: Record<string, ArtifactFileInput | null>;
          try {
            files = await collectFiles(a0);
          } catch {
            return fail(`Cannot read ${a0}.`);
          }
          for (const p of f.remove) files[p] = null;
          const common = {
            files,
            ...(f.title ? { title: f.title } : {}),
            ...(f.description ? { description: f.description } : {}),
            ...(f.type ? { type: f.type as ArtifactType } : {}),
            ...(f.label ? { label: f.label } : {}),
          };
          if (f.id) {
            const id = await resolve(f.id);
            if (!id) return 1;
            const a = await publishArtifactVersion(pid, id, { ...common, ...(baseVersion ? { base_version: baseVersion } : {}) });
            if (f.json) return out(a, '');
            process.stdout.write(`${status.ok(`Published version ${a.current_version} of "${a.title}"`)} ${C.dim}${short(a.artifact_id)}${C.reset}\n`);
            printLinks(a);
            return 0;
          }
          const a = await createArtifact(pid, { ...common, ...(f.visibility ? { visibility: f.visibility as ArtifactVisibility } : {}) });
          if (f.json) return out(a, '');
          process.stdout.write(`${status.ok(`Published "${a.title}" (${a.type}, ${a.visibility})`)} ${C.dim}${short(a.artifact_id)}${C.reset}\n`);
          printLinks(a);
          return 0;
        }
        case 'ls':
        case 'list': {
          const scope: ArtifactListScope = f.pinned ? 'pinned' : f.mine ? 'mine' : f.shared ? 'shared' : 'all';
          const list = await listArtifacts(pid, { scope, type: f.type as ArtifactType | undefined, q: f.search });
          if (f.json) return out(list, '');
          if (!list.length) return out(null, 'No artifacts yet. Publish one with `kortix artifacts publish <file>`.');
          for (const a of list) {
            process.stdout.write(`${C.dim}${short(a.artifact_id)}${C.reset}  ${pad(a.type, 10)}${pad(a.visibility, 9)}${pad(`v${a.current_version}`, 5)}${pad(ago(a.updated_at), 9)}${a.pinned ? '★ ' : ''}${a.title}\n`);
          }
          return 0;
        }
        case 'info':
        case 'open': {
          const id = await resolve(a0);
          if (!id) return a0 ? 1 : missing('an artifact id');
          const a = await getArtifact(pid, id, version ? { version } : {});
          if (f.json) return out(a, '');
          process.stdout.write(`${C.bold}${a.title}${C.reset}  ${C.dim}${a.artifact_id}${C.reset}\n`);
          if (sub === 'info') {
            process.stdout.write(`  ${a.type} · ${a.visibility}${a.shared_with_user_ids.length ? ` + ${a.shared_with_user_ids.length} people` : ''} · version ${a.version.version} of ${a.current_version} · by ${a.created_by.name ?? a.created_by.email ?? a.created_by.user_id} · updated ${ago(a.updated_at)}\n`);
            if (a.description) process.stdout.write(`  ${a.description}\n`);
            for (const file of a.version.files) process.stdout.write(`  ${C.dim}${pad(String(file.size), 9)}${C.reset}${file.path}\n`);
          }
          printLinks(a);
          return 0;
        }
        case 'cat': {
          const id = await resolve(a0);
          if (!id) return a0 ? 1 : missing('an artifact id');
          const blob = await readArtifactFile(pid, id, { path: a1, version });
          process.stdout.write(new Uint8Array(await blob.arrayBuffer()));
          return 0;
        }
        case 'pull': {
          const id = await resolve(a0);
          if (!id) return a0 ? 1 : missing('an artifact id');
          if (!a1) return missing('a folder to download into');
          const a = await getArtifact(pid, id, version ? { version } : {});
          for (const file of a.version.files) {
            const target = join(a1, ...file.path.split('/'));
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, new Uint8Array(await (await readArtifactFile(pid, id, { path: file.path, version: a.version.version })).arrayBuffer()));
          }
          return out({ dir: a1, version: a.version.version, files: a.version.files.map((x) => x.path) },
            status.ok(`Downloaded version ${a.version.version} (${a.version.files.length} files) to ${a1}. Publish changes with \`kortix artifacts publish ${a1} --id ${short(id)} --base-version ${a.version.version}\`.`));
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
        case 'versions': {
          const id = await resolve(a0);
          if (!id) return a0 ? 1 : missing('an artifact id');
          const versions = await listArtifactVersions(pid, id);
          if (f.json) return out(versions, '');
          for (const v of versions) {
            process.stdout.write(`${pad(`v${v.version}`, 6)}${pad(ago(v.created_at), 9)}${pad(`${v.files.length} files`, 10)}${v.label ?? ''}${v.created_by_session_id ? ` ${C.dim}(session ${short(v.created_by_session_id)})${C.reset}` : ''}\n`);
          }
          return 0;
        }
        case 'restore': {
          const id = await resolve(a0);
          const n = Number(a1);
          if (!id) return a0 ? 1 : missing('an artifact id');
          if (!Number.isInteger(n) || n < 1) return missing('the version number to restore');
          const a = await restoreArtifactVersion(pid, id, n);
          return out(a, status.ok(`Version ${n} is now version ${a.current_version} of "${a.title}"`));
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
          return out({ deleted: true, artifact_id: id }, status.ok(`Deleted ${short(id)}`));
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
