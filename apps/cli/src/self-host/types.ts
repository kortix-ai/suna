export interface SelfHostCommandFlags {
  instance: string;
  tag?: string;
  release?: string;
  /** Which moving tag to track when no explicit tag/release is pinned. */
  channel?: 'stable' | 'latest';
  /** Enable/disable the in-compose auto-updater. */
  autoUpdate?: boolean;
  /** Daily local clock time the auto-updater rolls the stack, HH:MM 24h (default 02:00). */
  updateTime?: string;
  /** IANA timezone the auto-updater interprets updateTime in (default America/New_York). */
  updateTz?: string;
  /** Allow a brief downtime window for a non-backward-compatible migration (KORTIX_ALLOW_DOWNTIME). */
  allowDowntime?: boolean;
  /** Single-account mode: this deployment is meant for exactly one account —
   *  no teams. Sets KORTIX_SINGLE_ACCOUNT_MODE + the matching KORTIX_PUBLIC_
   *  frontend flag (--single-account). */
  singleAccount?: boolean;
  /** Redirect unauthenticated visitors hitting "/" straight to /auth instead
   *  of the marketing landing page (KORTIX_PUBLIC_DISABLE_LANDING_PAGE,
   *  --no-landing). */
  disableLanding?: boolean;
  /** Operator holds a Kortix Enterprise license: unlocks SSO/SCIM/RBAC/audit
   *  entitlements platform-wide regardless of billing tier
   *  (ENTERPRISE_LICENSE_AVAILABLE, --enterprise-license). */
  enterpriseLicense?: boolean;
  /** Escape hatch: let `init`/`start` proceed with required secrets unset
   *  instead of failing — local experimentation only, never for a real
   *  deployment (managed git / sandbox / LLM calls will fail at runtime). */
  allowMissingSecrets?: boolean;
  /** Dev mode: run locally-built images (e.g. a branch build) that aren't on
   *  any registry. Sets KORTIX_IMAGE_PULL=never (the updater/`update` skip
   *  `docker compose pull`) and forces auto-update off — combine with
   *  `--version <localtag>` so *_IMAGE resolves to an image already present
   *  in the local Docker engine (`--local-images`, alias `--no-pull`). */
  localImages?: boolean;
  yes: boolean;
  json: boolean;
}
