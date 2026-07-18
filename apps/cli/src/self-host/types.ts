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
  /** Operator holds a Kortix Enterprise license: unlocks SSO/SCIM/RBAC/audit
   *  entitlements platform-wide regardless of billing tier
   *  (ENTERPRISE_LICENSE_AVAILABLE, --enterprise-license). */
  enterpriseLicense?: boolean;
  /** Restrict new-account/organization creation to platform admins only
   *  (KORTIX_RESTRICT_ACCOUNT_CREATION + the frontend-mirroring
   *  KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION). Signups, existing teams, and
   *  SSO/JIT membership are unaffected — only spinning up a brand-new
   *  organization is gated. Defaults ON for self-host (see
   *  SHARED_FEATURE_FLAG_DEFAULTS); `--no-restrict-account-creation` opts
   *  out. */
  restrictAccountCreation?: boolean;
  /** Public domain reachability mode: this instance is reachable at
   *  `https://<domain>` (and `https://api.<domain>`) — sets KORTIX_DOMAIN,
   *  turning on the bundled Caddy reverse proxy/ACME TLS, same as
   *  `env set KORTIX_DOMAIN=...` (`--domain <domain>`). Pass an empty string
   *  to explicitly clear a previously configured domain. */
  domain?: string;
  /** Cloudflare-tunnel reachability mode: no public domain, but a
   *  `cloudflared` tunnel exposes the API to the internet so cloud sandboxes
   *  can call back to it — the recommended no-public-domain / local-machine
   *  path (`--tunnel cloudflare`). See CLOUDFLARE_TUNNEL_TOKEN/
   *  CLOUDFLARE_TUNNEL_HOSTNAME for the optional stable named-tunnel
   *  alternative to the zero-config ephemeral quick tunnel. */
  tunnel?: 'cloudflare';
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
