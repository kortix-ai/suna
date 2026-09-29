/**
 * The in-session preview sheet's state: which sandbox / HTML preview is open.
 *
 * A `show` output's preview row, a running app named under a message, and a
 * preview card all open HERE — a bottom sheet over the session — instead of the
 * Browser page tab. The Browser page tab replaces the session (`tab-store`
 * `navigateToPage` clears `activeSessionId`), so the reader loses their place
 * and must reopen the session. The sheet leaves the session mounted, so the
 * title row's one-tap X returns to the exact position (KRTX-602).
 *
 * The explicit "open in the full browser" control still opens the Browser page
 * tab; this store only backs the primary tap.
 */

import { create } from 'zustand';

interface ToolPreviewState {
  /** The preview URL to show, or `null` while the sheet is closed. */
  url: string | null;
  /** The sheet title: the tool's label / display title. */
  label: string;
  openPreview: (url: string, label?: string) => void;
  closePreview: () => void;
}

export const useToolPreviewStore = create<ToolPreviewState>()((set) => ({
  url: null,
  label: '',
  openPreview: (url, label = '') => set({ url, label }),
  closePreview: () => set({ url: null, label: '' }),
}));
