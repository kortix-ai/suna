/**
 * Pure model for the Capture Storage form: the draft the form edits, how it
 * reads from the stored view, the write payload it sends, and when it may save.
 * Kept out of the component so the load-bearing bits (the save payload and the
 * credential rule, which must mirror the API) are unit-tested without a render.
 */
import type { CaptureStorageInput, CaptureStorageView } from '@kortix/sdk';

export type CredKind = 'role' | 'keys';

export interface StorageDraft {
  mode: 'kortix' | 's3';
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  credKind: CredKind;
  roleArn: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The draft a stored view opens as. A secret is never read back, so its field starts empty. */
export function toDraft(view: CaptureStorageView): StorageDraft {
  if (view.mode !== 's3') {
    return { mode: 'kortix', endpoint: '', region: 'us-east-1', bucket: '', forcePathStyle: false, credKind: 'role', roleArn: '', accessKeyId: '', secretAccessKey: '' };
  }
  return {
    mode: 's3',
    endpoint: view.endpoint,
    region: view.region,
    bucket: view.bucket,
    forcePathStyle: view.force_path_style,
    credKind: view.role_arn ? 'role' : 'keys',
    roleArn: view.role_arn,
    accessKeyId: view.access_key_id,
    secretAccessKey: '',
  };
}

/** The write payload. Only the selected credential form is sent, so the API's either/or rule holds. */
export function toInput(draft: StorageDraft): CaptureStorageInput {
  if (draft.mode !== 's3') return { mode: 'kortix' };
  const common = {
    mode: 's3' as const,
    endpoint: draft.endpoint.trim(),
    region: draft.region.trim(),
    bucket: draft.bucket.trim(),
    force_path_style: draft.forcePathStyle,
  };
  return draft.credKind === 'role'
    ? { ...common, role_arn: draft.roleArn.trim() }
    : { ...common, access_key_id: draft.accessKeyId.trim(), secret_access_key: draft.secretAccessKey };
}

/** True when the draft is complete enough to save (mirrors the API's credential rule). */
export function validStorageDraft(draft: StorageDraft): boolean {
  if (draft.mode !== 's3') return true;
  if (!draft.region.trim() || !draft.bucket.trim()) return false;
  return draft.credKind === 'role' ? !!draft.roleArn.trim() : !!(draft.accessKeyId.trim() && draft.secretAccessKey);
}
