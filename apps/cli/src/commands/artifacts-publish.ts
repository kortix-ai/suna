// `kortix artifacts` publish, add, versions and restore: upload files and save
// or restore versions.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  createArtifact,
  listArtifactVersions,
  restoreArtifactVersion,
  saveArtifact,
  shareArtifactPath,
  type Artifact,
  type ArtifactFileInput,
} from '@kortix/sdk';
import { formatRelative } from '@kortix/shared';
import { fail, missing } from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';
import type { ArtifactsRun } from './artifacts-run.ts';

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


export async function artifactsPublish(sub: string, { pid, f, a0, a1, meta, resolve, out, shared }: ArtifactsRun): Promise<number> {
  switch (sub) {
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
    case 'versions': {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      const versions = await listArtifactVersions(pid, id);
      if (f.json) return out(versions, '');
      if (!versions.length) return out(null, 'No saves in the recent Files history.');
      for (const v of versions) process.stdout.write(`${pad(`#${v.number}`, 6)}${pad(formatRelative(v.created_at, { maxRelativeDays: null }) ?? '—', 9)}${C.dim}${v.id}${C.reset}\n`);
      return 0;
    }
    default: {
      const id = await resolve(a0);
      if (!id) return a0 ? 1 : missing('an artifact id');
      if (!a1) return missing('the version id to restore (from `kortix artifacts versions`)');
      const a = await restoreArtifactVersion(pid, id, a1);
      return out(a, status.ok(`Restored "${a.title}" to that version, as a new save`));
    }
  }
}
