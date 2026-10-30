import { beforeEach, expect, mock, test } from 'bun:test';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The save-to-device copy contract (`lib/files/save-to-device`): the cached
 * source streams into the picked target with the FS layer's native transfer,
 * never through a whole-file buffer in JS (the same rule the download path
 * `downloadSandboxFileToCache` holds). These doubles record the copy
 * strategy; the streaming tests are RED on a `bytesSync()` whole-file read
 * and GREEN on the streaming copy.
 */

const FOLDER_KEY = 'files.download-folder-uri';
const PICKER_URI = 'content://downloads/tree/master';

let folders = new Map<string, FolderDouble>();
let sources = new Map<string, Uint8Array[]>();
let wholeFileReads: string[] = [];
let pickerCalls = 0;
let pickerError: unknown = null;
let createdFiles: Array<{ folder: string; name: string; mime: string | null }> = [];

const chunkOf = (bytes: number, seed: number): Uint8Array => {
  const chunk = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) chunk[i] = (i + seed) % 251;
  return chunk;
};

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
};

class RecordingTarget {
  readonly receivedChunks: Uint8Array[] = [];
  jsWrites = 0;
  failWrites = false;

  constructor(
    readonly createdName: string,
    readonly mime: string | null,
  ) {}

  get name(): string {
    return this.createdName;
  }

  write(bytes: Uint8Array): void {
    this.jsWrites += 1;
    if (this.failWrites) throw new Error('write refused');
    this.receivedChunks.push(bytes);
  }

  writableStream(): WritableStream<Uint8Array> {
    const target = this;
    return new WritableStream({
      write(chunk: Uint8Array): void {
        if (target.failWrites) throw new Error('write refused');
        target.receivedChunks.push(chunk);
      },
    });
  }
}

class FolderDouble {
  readonly children: RecordingTarget[] = [];
  private createFileFailWrites: boolean;

  constructor(
    readonly uri: string,
    readonly registeredName: string,
    existing: string[] = [],
    failNewTargets = false,
  ) {
    this.createFileFailWrites = failNewTargets; // every new target refuses its first write
    for (const existingName of existing) this.children.push(new RecordingTarget(existingName, null));
  }

  /** The real `Directory.name` is the last path segment; fresh instances read it from the registry. */
  get name(): string {
    return folders.get(this.uri)?.registeredName ?? this.uri.split('/').at(-1) ?? '';
  }

  get exists(): boolean {
    return true;
  }

  /** The module constructs fresh instances; state resolves through the registry. */
  private resolve(): FolderDouble {
    return folders.get(this.uri) ?? this;
  }

  list(): Array<{ name: string }> {
    return this.resolve().children;
  }

  createFile(name: string, mime: string | null): RecordingTarget {
    createdFiles.push({ folder: this.uri, name, mime });
    const target = new RecordingTarget(name, mime);
    const folder = this.resolve();
    target.failWrites = folder.createFileFailWrites;
    folder.children.push(target);
    return target;
  }

  static async pickDirectoryAsync(): Promise<FolderDouble> {
    pickerCalls += 1;
    if (pickerError) throw pickerError;
    return folders.get(PICKER_URI) ?? new FolderDouble(PICKER_URI, 'Downloads');
  }
}

class RecordingFile {
  constructor(readonly uri: string) {}

  bytesSync(): Uint8Array {
    wholeFileReads.push(this.uri);
    return concatChunks(sources.get(this.uri) ?? []);
  }

  readableStream(): ReadableStream<Uint8Array> {
    const chunks = sources.get(this.uri) ?? [];
    let index = 0;
    return new ReadableStream({
      pull(controller): void {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else controller.close();
      },
    });
  }
}

mock.module('react-native', () => ({ Platform: { OS: 'android' } }));
mock.module('expo-file-system', () => ({ Directory: FolderDouble, File: RecordingFile }));

const { saveFileToDevice } = await import('./save-to-device');

const addSource = (uri: string, chunks: Uint8Array[]): void => {
  sources.set(uri, chunks);
};
const addFolder = (uri: string, name: string, existing: string[] = [], failNewTargets = false): FolderDouble => {
  const folder = new FolderDouble(uri, name, existing, failNewTargets);
  folders.set(uri, folder);
  return folder;
};
const lastTargetIn = (uri: string): RecordingTarget => {
  const target = folders.get(uri)?.children.at(-1);
  if (!target) throw new Error(`no target was created in ${uri}`);
  return target;
};

beforeEach(async () => {
  folders = new Map();
  sources = new Map();
  wholeFileReads = [];
  pickerCalls = 0;
  pickerError = null;
  createdFiles = [];
  await AsyncStorage.removeItem(FOLDER_KEY);
  addFolder(PICKER_URI, 'Downloads');
});

test('a large source streams chunk by chunk into the target, never read whole', async () => {
  const chunks = [chunkOf(1_048_576, 3), chunkOf(1_048_576, 91), chunkOf(1_048_576, 147), chunkOf(1_048_576, 201)];
  addSource('file:///cache/archive.zip', chunks);

  const result = await saveFileToDevice('file:///cache/archive.zip', 'archive.zip');

  expect(result).toEqual({ status: 'saved', name: 'archive.zip', folder: 'Downloads' });
  expect(wholeFileReads).toEqual([]); // no bytesSync whole-file read
  const target = lastTargetIn(PICKER_URI);
  expect(target.jsWrites).toEqual(0); // no whole-file JS buffer write
  expect(target.receivedChunks.length).toBeGreaterThan(1); // chunked native transfer
  expect(concatChunks(target.receivedChunks)).toEqual(concatChunks(chunks));
  expect(createdFiles).toEqual([{ folder: PICKER_URI, name: 'archive.zip', mime: 'application/zip' }]);
});

test('a name that already exists gets the (1) suffix, never overwrites', async () => {
  addSource('file:///cache/report.md', [chunkOf(4_096, 7)]);
  const folder = addFolder(PICKER_URI, 'Downloads', ['report.md']);

  const result = await saveFileToDevice('file:///cache/report.md', 'report.md');

  expect(result).toEqual({ status: 'saved', name: 'report (1).md', folder: 'Downloads' });
  expect(createdFiles).toEqual([{ folder: PICKER_URI, name: 'report (1).md', mime: 'text/markdown' }]);
  expect(folder.children[0]?.receivedChunks).toEqual([]); // the existing file is untouched
});

test('a picker cancel returns cancelled and creates nothing', async () => {
  addSource('file:///cache/notes.md', [chunkOf(4_096, 13)]);
  pickerError = { code: 'DOCUMENT_PICKER_CANCELED', message: 'User canceled document picker' };

  const result = await saveFileToDevice('file:///cache/notes.md', 'notes.md');

  expect(result).toEqual({ status: 'cancelled' });
  expect(createdFiles).toEqual([]);
  expect(wholeFileReads).toEqual([]);
});

test('a remembered Android folder saves without opening the picker', async () => {
  addSource('file:///cache/data.json', [chunkOf(8_192, 17)]);
  const remembered = addFolder('content://other/tree/device', 'DeviceFolder');
  await AsyncStorage.setItem(FOLDER_KEY, remembered.uri);

  const result = await saveFileToDevice('file:///cache/data.json', 'data.json');

  expect(result).toEqual({ status: 'saved', name: 'data.json', folder: 'DeviceFolder' });
  expect(pickerCalls).toEqual(0);
  expect(await AsyncStorage.getItem(FOLDER_KEY)).toEqual(remembered.uri);
  expect(concatChunks(lastTargetIn(remembered.uri).receivedChunks)).toEqual(concatChunks(sources.get('file:///cache/data.json') ?? []));
});

test('a remembered folder that lost write access is forgotten and picked again', async () => {
  addSource('file:///cache/data.json', [chunkOf(8_192, 23)]);
  const lost = addFolder('content://other/tree/device', 'DeviceFolder', [], true);
  await AsyncStorage.setItem(FOLDER_KEY, lost.uri);

  const result = await saveFileToDevice('file:///cache/data.json', 'data.json');

  expect(result).toEqual({ status: 'saved', name: 'data.json', folder: 'Downloads' });
  expect(await AsyncStorage.getItem(FOLDER_KEY)).toEqual(PICKER_URI);
  const failed = lastTargetIn(lost.uri); // the failed remembered copy
  expect(failed.jsWrites).toEqual(0); // the failure path never fell back to a JS buffer write
  expect(failed.receivedChunks).toEqual([]);
  expect(wholeFileReads).toEqual([]); // the failure path never fell back to bytesSync
  expect(concatChunks(lastTargetIn(PICKER_URI).receivedChunks)).toEqual(concatChunks(sources.get('file:///cache/data.json') ?? []));
});
