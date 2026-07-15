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
  yes: boolean;
  json: boolean;
}
