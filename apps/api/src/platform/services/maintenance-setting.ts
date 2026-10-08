import { z } from '@hono/zod-openapi';
import { createCachedPlatformSetting } from './platform-setting-cache';

// ─── Maintenance config (DB-backed; replaces Vercel Edge Config) ─────────────
// One row in kortix.platform_settings under 'maintenance_config'. GET is public
// (banner + maintenance page read it); PUT is admin-only. Set via /admin/utils.
const MAINTENANCE_KEY = 'maintenance_config';

export const MaintenanceSchema = z
  .object({
    level: z.string(),
    title: z.string(),
    message: z.string(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    statusUrl: z.string().nullable(),
    affectedServices: z.array(z.string()),
    updatedAt: z.string(),
  })
  .partial()
  .openapi('MaintenanceConfig');

export type MaintenanceConfigValue = Required<z.infer<typeof MaintenanceSchema>>;

export const DEFAULT_MAINTENANCE: MaintenanceConfigValue = {
  level: 'none',
  title: '',
  message: '',
  startTime: null,
  endTime: null,
  statusUrl: null,
  affectedServices: [],
  updatedAt: new Date(0).toISOString(),
};

function parseMaintenance(value: unknown): MaintenanceConfigValue {
  if (!value || typeof value !== 'object') return DEFAULT_MAINTENANCE;
  return { ...DEFAULT_MAINTENANCE, ...(value as Partial<MaintenanceConfigValue>) };
}

// The config is one singleton row that changes only when an admin flips it, but
// the GET is public and polled. Read it through the shared cached
// platform-setting reader, so the route never blocks on a DB round trip. The
// admin PUT writes through the cache, so the writing process serves the new
// value at once; other replicas converge within the reader's TTL.
export const maintenanceSetting = createCachedPlatformSetting<MaintenanceConfigValue>(
  MAINTENANCE_KEY,
  parseMaintenance,
);
