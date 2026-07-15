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
   *  of the marketing landing page (KORTIX_PUBLIC_DISABLE_LANDING_PAGE) — this
   *  is the self-host DEFAULT (a self-host is an app deployment, not a
   *  marketing site). `--no-landing` sets this explicitly (redundant with the
   *  default, kept for scripts); `--landing` sets it to `false` to
   *  re-enable the marketing site. */
  disableLanding?: boolean;
  /** Operator holds a Kortix Enterprise license: unlocks SSO/SCIM/RBAC/audit
   *  entitlements platform-wide regardless of billing tier
   *  (ENTERPRISE_LICENSE_AVAILABLE, --enterprise-license). */
  enterpriseLicense?: boolean;
  /** Escape hatch: let `init`/`start` proceed with required secrets unset
   *  instead of failing — local experimentation only, never for a real
   *  deployment (managed git / sandbox / LLM calls will fail at runtime). */
  allowMissingSecrets?: boolean;
  /** GitHub org (or omit for a personal account) to create/install the
   *  self-host GitHub App under — `connect-github`, and the guided `init`/
   *  `configure` GitHub step. */
  org?: string;
  /** Force the headless/manual GitHub App connect flow (print URLs, accept
   *  pasted-back code/installation_id) instead of auto-opening a browser.
   *  Automatic on a non-TTY even without this flag. */
  manual?: boolean;
  /** Skip the guided `connect-github` offer during `init`/`configure` —
   *  drops straight to the advanced "paste an existing App or PAT" menu. */
  skipGithub?: boolean;
  /** Operator admin email(s), comma-separated. Sets KORTIX_PLATFORM_ADMIN_EMAILS
   *  so these accounts are platform admins on this self-host (needed to
   *  configure the managed GitHub App and other server-wide settings in-app).
   *  `--admin-email you@org.com`. */
  adminEmail?: string;
  /** Dev mode: run locally-built images (e.g. a branch build) that aren't on
   *  any registry. Sets KORTIX_IMAGE_PULL=never (the updater/`update` skip
   *  `docker compose pull`) and forces auto-update off — combine with
   *  `--version <localtag>` so *_IMAGE resolves to an image already present
   *  in the local Docker engine (`--local-images`, alias `--no-pull`). */
  localImages?: boolean;
  yes: boolean;
  json: boolean;
}
