// The audit archive's object store (bucket from AUDIT_ARCHIVE_*). Shared by the archive job and the export.
import { config } from '../../../lib/config';
import { ObjectStore } from '../../../lib/object-store/s3';

const store = new ObjectStore(() => ({
  name: 'audit archive',
  bucket: config.AUDIT_ARCHIVE_BUCKET,
  region: config.AUDIT_ARCHIVE_REGION,
  endpoint: config.AUDIT_ARCHIVE_ENDPOINT,
  forcePathStyle: config.AUDIT_ARCHIVE_FORCE_PATH_STYLE,
  accessKeyId: config.AUDIT_ARCHIVE_ACCESS_KEY_ID,
  secretAccessKey: config.AUDIT_ARCHIVE_SECRET_ACCESS_KEY,
}));

export function auditArchiveStore(): ObjectStore {
  return store;
}
