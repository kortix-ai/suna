/**
 * pending-picker-result — recovers a camera photo after Android kills the
 * host activity mid-pick (`ImagePicker.getPendingResultAsync`). Pure: the
 * picker call is injected so this module has no native import.
 *
 * `useRecoverPendingPick` (`components/session/useRecoverPendingPick.ts`)
 * wraps this for the two composers.
 */
import type { AttachedFile } from './attachments';
import { imageAssetToFile, type ImageAssetLike } from './attach-sources';

/** A subset of `ImagePickerResult | ImagePickerErrorResult | null` — only the
 * fields this module reads. */
export type PendingLike =
  | { canceled: true; assets: null }
  | { canceled: false; assets: ImageAssetLike[] }
  | { code: string; message?: string };

export interface PendingPickRecovery {
  consume(): Promise<AttachedFile[]>;
}

/**
 * Wraps `getPending` so it is called at most once per `PendingPickRecovery`
 * instance — every call after the first resolves `[]` without invoking it
 * again. The caller keeps one module-level instance per JS realm, so after
 * Android restarts the JS realm following activity death, exactly one
 * composer's `consume()` gets the real result.
 */
export function createPendingPickRecovery(
  getPending: () => Promise<PendingLike | null>,
): PendingPickRecovery {
  let called = false;

  const consume = async (): Promise<AttachedFile[]> => {
    if (called) return [];
    called = true;

    const result = await getPending();
    if (!result) return [];
    if ('canceled' in result && result.canceled) return [];
    if ('code' in result) return [];

    const now = Date.now();
    return result.assets.map((asset, i) => imageAssetToFile(asset, `photo_${now}_${i}.jpg`));
  };

  return { consume };
}
