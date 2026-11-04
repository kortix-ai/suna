/**
 * An in-memory Drive volume for memory tests (`setVolumeOpsForTests`): files
 * with a version and an mtime from a fake clock, and one commit per write
 * holding the whole volume, newest first, like Platinum's drive commits.
 */
import type { DriveRow } from '../../drives/service';
import { DriveStorageError, type VolumeCommit, type VolumeEntry, type VolumeFileStat } from '../../drives/volumes';
import type { VolumeOps } from '../../memory/volume-ops';

interface FakeFile {
  text: string;
  version: string;
  mtime: number;
}

export class FakeVolume implements VolumeOps {
  files = new Map<string, FakeFile>();
  /** Oldest first. */
  private history: { commit: VolumeCommit; files: Map<string, FakeFile> }[] = [];
  private clock = Date.parse('2026-10-24T10:00:00Z');
  private seq = 0;
  /** Called before each write lands: a test makes another writer win the race here. */
  beforeWrite: ((path: string) => void) | null = null;
  /** `author.kind` of the next commits. */
  author = 'user';

  available() {
    return true;
  }

  /** Put a file as another writer would (an agent through its mount). */
  put(path: string, text: string): void {
    this.clock += 1000;
    this.files.set(path, { text, version: `v${++this.seq}`, mtime: this.clock });
    this.commit();
  }

  private commit(): void {
    this.history.push({
      commit: { id: `vc_${this.seq}_${this.history.length}`, kind: 'api', author: { kind: this.author, id: null }, created_at: new Date(this.clock).toISOString() },
      files: new Map(this.files),
    });
  }

  private at(at?: string): Map<string, FakeFile> {
    if (!at) return this.files;
    const found = this.history.find((h) => h.commit.id === at);
    if (!found) throw new DriveStorageError(404, 'Version not found');
    return found.files;
  }

  async list(_drive: DriveRow, folder: string): Promise<VolumeEntry[]> {
    return [...this.files.entries()]
      .filter(([path]) => path.startsWith(`${folder}/`))
      .map(([path, file]) => ({ path, type: 'file' as const, size: Buffer.byteLength(file.text), mtime: file.mtime }));
  }

  async read(_drive: DriveRow, path: string, opts?: { at?: string; headBytes?: number }) {
    const file = this.at(opts?.at).get(path);
    if (!file) return null;
    const text = opts?.headBytes ? Buffer.from(file.text).subarray(0, opts.headBytes).toString('utf8') : file.text;
    return { text, etag: `"${file.version}"` };
  }

  async stat(_drive: DriveRow, path: string, at?: string): Promise<VolumeFileStat | null> {
    const file = this.at(at).get(path);
    return file ? { path, type: 'file', size: Buffer.byteLength(file.text), mtime: file.mtime, version: file.version } : null;
  }

  async write(_drive: DriveRow, path: string, text: string, opts: { overwrite: boolean; ifMatch?: string }): Promise<void> {
    this.beforeWrite?.(path);
    const current = this.files.get(path);
    if (current && !opts.overwrite) throw new DriveStorageError(409, 'A file or folder with that name already exists');
    if (opts.ifMatch && (!current || `"${current.version}"` !== opts.ifMatch)) throw new DriveStorageError(409, 'changed', 'file_changed');
    this.put(path, text);
  }

  async remove(_drive: DriveRow, path: string): Promise<void> {
    if (!this.files.delete(path)) throw new DriveStorageError(404, 'File or folder not found');
    this.clock += 1000;
    this.seq++;
    this.commit();
  }

  async commits(_drive: DriveRow, limit: number): Promise<VolumeCommit[]> {
    return this.history.map((h) => h.commit).reverse().slice(0, limit);
  }
}
