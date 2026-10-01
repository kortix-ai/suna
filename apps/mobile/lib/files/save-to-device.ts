/**
 * Download = save the file on the device, never "open it in some app"
 * (Jay, 2026-09-28: a .md Download opened a Markdown viewer instead of
 * saving the file).
 *
 * - Android: the system folder picker (Storage Access Framework) the first
 *   time, preset to Downloads by the system. The grant is persistable
 *   (`FilePickerContract` takes it), so the folder is remembered and every
 *   later Download saves there with no prompt. A folder that went away or lost
 *   its grant is forgotten and picked again.
 * - iOS: the system folder picker every time (the Files "Save" location).
 *   iOS grants a picked folder for that session only, so it cannot be
 *   remembered.
 *
 * The file is fetched to the cache first (`downloadOpenCodeFileToCache`);
 * this copies it into the chosen folder under a name
 * that does not overwrite an existing file.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File } from 'expo-file-system';
import { Platform } from 'react-native';

import { availableFileName } from './file-name';
import { mimeTypeForFile } from './mime-type';

const FOLDER_KEY = 'files.download-folder-uri';

export type SaveToDeviceResult =
  | { status: 'saved'; name: string; folder: string }
  | { status: 'cancelled' };

function isPickerCancel(error: unknown): boolean {
  const text = `${(error as { code?: string })?.code ?? ''} ${(error as Error)?.message ?? ''}`;
  return /cancel/i.test(text);
}

async function pickFolder(): Promise<Directory | null> {
  try {
    return await Directory.pickDirectoryAsync();
  } catch (error) {
    if (isPickerCancel(error)) return null;
    throw error;
  }
}

async function rememberedFolder(): Promise<Directory | null> {
  const uri = await AsyncStorage.getItem(FOLDER_KEY).catch(() => null);
  if (!uri) return null;
  try {
    const folder = new Directory(uri);
    if (folder.exists) return folder;
  } catch {
    // The grant is gone: pick again.
  }
  await AsyncStorage.removeItem(FOLDER_KEY).catch(() => {});
  return null;
}

async function writeInto(folder: Directory, sourceUri: string, name: string): Promise<string> {
  const existing = new Set(
    folder
      .list()
      .map((entry) => entry.name)
      .filter((entryName): entryName is string => typeof entryName === 'string'),
  );
  const finalName = availableFileName(name, (candidate) => existing.has(candidate));
  const target = folder.createFile(finalName, mimeTypeForFile(finalName) ?? 'application/octet-stream');
  await new File(sourceUri).copy(target);
  return target.name ?? finalName;
}

/** Save the cached file `sourceUri` as `name` in a folder on the device. */
export async function saveFileToDevice(sourceUri: string, name: string): Promise<SaveToDeviceResult> {
  if (Platform.OS === 'android') {
    const remembered = await rememberedFolder();
    if (remembered) {
      try {
        return { status: 'saved', name: await writeInto(remembered, sourceUri, name), folder: remembered.name };
      } catch {
        // Lost write access to the remembered folder: forget it and pick again.
        await AsyncStorage.removeItem(FOLDER_KEY).catch(() => {});
      }
    }
  }
  const folder = await pickFolder();
  if (!folder) return { status: 'cancelled' };
  const saved = await writeInto(folder, sourceUri, name);
  if (Platform.OS === 'android') await AsyncStorage.setItem(FOLDER_KEY, folder.uri).catch(() => {});
  return { status: 'saved', name: saved, folder: folder.name };
}
