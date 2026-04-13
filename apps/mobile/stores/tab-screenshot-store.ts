/**
 * Tab Screenshot Store — stores captured screenshots for the tabs overview.
 *
 * Screenshots are saved as JPG files in the app's document directory
 * and the tabId → filePath mapping is persisted via AsyncStorage.
 * This means tab previews survive app restarts.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

const SCREENSHOT_DIR = `${FileSystem.documentDirectory}tab-screenshots/`;

/** Ensure the screenshots directory exists */
async function ensureDir() {
  const info = await FileSystem.getInfoAsync(SCREENSHOT_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(SCREENSHOT_DIR, { intermediates: true });
  }
}

/** Copy a temp capture file to the persistent screenshots dir */
async function persistScreenshot(tabId: string, tempUri: string): Promise<string> {
  await ensureDir();
  // Sanitize tabId for filename (replace colons, slashes, etc.)
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const destUri = `${SCREENSHOT_DIR}${safe}.jpg`;
  try {
    // If source is the same as dest, skip
    if (tempUri === destUri) return destUri;
    await FileSystem.copyAsync({ from: tempUri, to: destUri });
    return destUri;
  } catch {
    // If copy fails (e.g. temp file already cleaned up), return temp URI as fallback
    return tempUri;
  }
}

/** Delete a persisted screenshot file */
async function deleteScreenshotFile(uri: string) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  } catch {
    // Ignore — file may already be gone
  }
}

interface TabScreenshotState {
  /** Map of tabId → persistent file URI of the captured screenshot */
  screenshots: Record<string, string>;
  /** Store a screenshot for a tab (copies to persistent storage) */
  setScreenshot: (tabId: string, uri: string) => void;
  /** Remove a screenshot (when tab is closed) */
  removeScreenshot: (tabId: string) => void;
  /** Clear all screenshots */
  clear: () => void;
}

export const useTabScreenshotStore = create<TabScreenshotState>()(
  persist(
    (set, get) => ({
      screenshots: {},

      setScreenshot: (tabId, uri) => {
        // Immediately store the temp URI for instant display
        set((state) => ({
          screenshots: { ...state.screenshots, [tabId]: uri },
        }));
        // Then copy to persistent location in background
        persistScreenshot(tabId, uri).then((persistedUri) => {
          if (persistedUri !== uri) {
            set((state) => ({
              screenshots: { ...state.screenshots, [tabId]: persistedUri },
            }));
          }
        });
      },

      removeScreenshot: (tabId) => {
        const uri = get().screenshots[tabId];
        set((state) => {
          const { [tabId]: _, ...rest } = state.screenshots;
          return { screenshots: rest };
        });
        if (uri) deleteScreenshotFile(uri);
      },

      clear: () => {
        const uris = Object.values(get().screenshots);
        set({ screenshots: {} });
        // Clean up files in background
        uris.forEach((uri) => deleteScreenshotFile(uri));
      },
    }),
    {
      name: 'tab-screenshots',
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist the path mapping, not the actual image data
      partialize: (state) => ({ screenshots: state.screenshots }),
      // Guard against corrupted AsyncStorage data
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!state.screenshots || typeof state.screenshots !== 'object' || Array.isArray(state.screenshots)) {
          state.screenshots = {};
        }
      },
    },
  ),
);

/**
 * Validate persisted screenshots on app startup.
 * Removes entries whose files no longer exist (e.g. system cache cleanup).
 */
export async function validatePersistedScreenshots() {
  const { screenshots } = useTabScreenshotStore.getState();
  const invalid: string[] = [];

  await Promise.all(
    Object.entries(screenshots).map(async ([tabId, uri]) => {
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists) invalid.push(tabId);
      } catch {
        invalid.push(tabId);
      }
    }),
  );

  if (invalid.length > 0) {
    useTabScreenshotStore.setState((state) => {
      const next = { ...state.screenshots };
      for (const tabId of invalid) delete next[tabId];
      return { screenshots: next };
    });
  }
}
