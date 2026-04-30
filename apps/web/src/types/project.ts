/**
 * Project type — used by sandbox/VNC/file preview components.
 *
 * Formerly lived in lib/api/threads.ts (legacy). Relocated here since
 * the type is still consumed by live components.
 */
export type Project = {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at?: string;
  sandbox: {
    vnc_preview?: string;
    sandbox_url?: string;
    id?: string;
    pass?: string;
  };
  is_public?: boolean;
  icon_name?: string | null;
  /** Backfilled by the frontend on first v2 project load — not set by the agent tool. */
  user_handle?: string | null;
  [key: string]: any;
};
