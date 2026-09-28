import { z } from "zod";
import { optStr, optStrDefault, optUrl, optInt, optBoolTrue, optBoolFalse } from "./env-schema-helpers";
export const sandbox_provisioningSchema = {
  // Note: there is intentionally no DAYTONA_SNAPSHOT here. Every sandbox
  // boots from a per-project snapshot built by the snapshot builder
  // (apps/api/src/snapshots/builder.ts). A shared/global fallback image
  // would silently bypass per-project Dockerfiles and is explicitly
  // disallowed.
  DAYTONA_API_KEY: optStr,
  DAYTONA_SERVER_URL: optStr,
  DAYTONA_TARGET: optStr,
  // Org-level Daytona webhook signing secret (Svix `whsec_…`). When set, the
  // /v1/billing/webhooks/daytona endpoint closes compute billing the instant a
  // box stops; the reaper sweep is the backstop, so this is optional.
  DAYTONA_WEBHOOK_SECRET: optStr,

  // When a template's content hash changes and a fresh snapshot is built, drop
  // the now-superseded predecessor immediately (reap-on-repoint) instead of
  // leaving it for the lazy, pressure-gated quota GC. Keeps steady state at ~1
  // snapshot per lineage so the org-wide 100-snapshot quota can't fill with
  // stale builds (dev auto-deploys churn the default ~20×/day). Best-effort;
  // only deletes managed (kortix-default-/tpl-/wproj-) names that no other
  // template row still references. On by default; boot auto-heal covers the rare
  // cross-env race where another env's row pointed at the reaped (identical) name.
  KORTIX_SNAPSHOT_REAP_PREDECESSOR: optBoolTrue,
  // Pi worker pool (harness/worker split P1.8): keep this many PARKED boxes of
  // the shared pi-worker snapshot per environment, claimed at session create
  // (a claim skips provider create + box boot, ~4s of the cold path measured
  // on dev 2026-08-27). 0 = off. Pure accelerator: claim failure falls back to
  // an ordinary cold create.
  KORTIX_PI_WORKER_POOL_TARGET: optInt(0),
  // Parked boxes older than this are reaped and replaced; also the Daytona
  // auto-stop backstop a parked box is created with, so an orphaned box
  // reclaims itself even if every API instance dies.
  KORTIX_PI_WORKER_POOL_MAX_AGE_MINUTES: optInt(60),
  // The fresh-session Git fast path: KORTIX_SESSION_FRESH, the base-tip +
  // scaffold-delta hint (inline or remote bundle), and the OpenCode config-dir
  // hint that lets the daemon spawn OpenCode before the checkout. Default ON;
  // `false` restores the pre-2026-08-27 create-time contract. The daemon side
  // is additive and falls back to the clone path without these hints.
  KORTIX_FAST_GIT_BOOT_ENABLED: optBoolTrue,
  // Experimental compiled boot path. The API builds a verified checkout and
  // OpenCode launcher for one exact Git SHA. `off` preserves the clone and
  // baked-agent path. `shadow` verifies both artifacts without using them.
  // `prefer` uses both artifacts with legacy fallback. `required` fails closed.
  KORTIX_COMPILED_BOOT_MODE: z
    .enum(['off', 'shadow', 'prefer', 'required'])
    .optional()
    .default('off'),
  // A fresh session materializes its project from a prebuilt `.tar.gz` in S3
  // instead of a Git clone. `git` (default) never attempts S3 and is the
  // rollback mode. `prefer-s3` tries a prepared archive and falls back to the
  // legacy Git path on any acquisition failure. `require-s3` fails closed —
  // acceptance runs and controlled validation only. A project can override
  // the platform mode with `projects.metadata.project_snapshot_mode` (canary).
  // The producer worker runs on the leader whenever the bucket is configured,
  // independent of the consumption mode, so archives can be prepared ahead of
  // a rollout. Credentials: the explicit pair below, else the AWS SDK default
  // chain (env, shared config, ECS/EKS task role). Endpoint + path style are
  // the MinIO/S3-compatible overrides; leave them unset on AWS.
  KORTIX_PROJECT_SNAPSHOT_MODE: z
    .enum(['git', 'prefer-s3', 'require-s3'])
    .optional()
    .default('git'),
  KORTIX_PROJECT_SNAPSHOT_S3_BUCKET: optStr,
  KORTIX_PROJECT_SNAPSHOT_S3_REGION: optStr,
  KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT: optUrl(''),
  /**
   * Endpoint the SANDBOX reaches the store through, when it differs from the
   * API's (MinIO behind a proxy/tunnel; self-host). Presigned download URLs
   * are signed for this host. Unset = same as the endpoint above / AWS.
   */
  KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT: optUrl(''),
  KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE: optBoolFalse,
  // S3 Transfer Acceleration for the SANDBOX downloads only: presigned URLs
  // target <bucket>.s3-accelerate.amazonaws.com, so a box's connection ends at
  // the nearest AWS edge and the distance to the bucket rides AWS's backbone.
  // Needs `transfer_acceleration = true` on the bucket (Terraform module).
  // Ignored when a custom public endpoint (MinIO) is set. The API's own calls
  // stay on the regional endpoint.
  KORTIX_PROJECT_SNAPSHOT_S3_ACCELERATE: optBoolFalse,
  /** Optional key prefix inside the bucket (e.g. `dev/`), namespacing environments that share one bucket. */
  KORTIX_PROJECT_SNAPSHOT_S3_PREFIX: optStr,
  KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID: optStr,
  KORTIX_PROJECT_SNAPSHOT_S3_SECRET_ACCESS_KEY: optStr,
  /** Lifetime of the presigned download URL handed to a sandbox. */
  KORTIX_PROJECT_SNAPSHOT_DOWNLOAD_TTL_SECONDS: optInt(900),
  KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES: optInt(512 * 1024 * 1024),
  // Operator kill switch for the whole config-release feature (the
  // `config_releases` per-project flag). Default ON: a session runs the base branch's current
  // config. Set to false and the flag is unavailable platform-wide — the
  // Settings row disappears, both routes answer 403 `feature_disabled` for
  // every project, no convergence is scheduled, and every session falls back
  // to reading its workspace config dir, whatever a project chose.
  CONFIG_RELEASES_ENABLED: optBoolFalse,
  // Config archives go through the API's ONE object store
  // (src/object-store/s3.ts), same as project snapshots above, with their own
  // bucket/prefix so that naming a config bucket never starts the snapshot
  // producer (which the snapshot bucket setting gates).
  //   dev/staging/prod: the environment's S3 bucket, credentials from the AWS
  //     SDK default chain (the ECS task role). Point the prefix somewhere
  //     distinct when the bucket is shared with project snapshots.
  //   local/preview/self-host: Supabase Storage's S3 PROTOCOL endpoint
  //     (`<supabase>/storage/v1/s3`) with the S3 protocol key pair, bucket
  //     `kortix-config-releases` (created by database migration).
  // Required when CONFIG_RELEASES_ENABLED is on — see the conditional check in
  // validateEnv(); without it every archive request rebuilds from the mirror.
  KORTIX_CONFIG_ARCHIVE_S3_BUCKET: optStr,
  KORTIX_CONFIG_ARCHIVE_S3_REGION: optStr,
  /** S3-compatible endpoint. Empty = the AWS regional endpoint. */
  KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT: optUrl(''),
  KORTIX_CONFIG_ARCHIVE_S3_FORCE_PATH_STYLE: optBoolFalse,
  KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID: optStr,
  KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY: optStr,
  /** Key prefix inside the bucket. Keeps config archives apart from snapshots. */
  KORTIX_CONFIG_ARCHIVE_S3_PREFIX: optStr.transform((v) => (v.trim() ? v.trim() : 'config-releases')),
  /** Archives kept per project. Older ones are deleted after a publish. */
  KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT: optInt(20),
  // The endpoint the SANDBOX reaches the store through, when it differs from
  // the API's. Download URLs are presigned for this host and the archive route
  // answers 302 to them. Unset = presign for the API's own endpoint, and the
  // route streams the bytes when that host is loopback or private.
  KORTIX_CONFIG_ARCHIVE_PUBLIC_URL: optUrl(''),
  // Platinum is our own Cloud Hypervisor microVM API. PLATINUM_API_KEY is a
  // pt_live_… key; PLATINUM_API_URL is the control-plane base
  // (https://api.platinum.dev). PLATINUM_TEMPLATE is a ready Platinum template
  // id to boot sessions from (e.g. kortix-computer) — used as the fallback when
  // a session hasn't built its own per-project Platinum template.
  PLATINUM_API_KEY: optStr,
  PLATINUM_API_URL: optStr,
  PLATINUM_TEMPLATE: optStr,
  // Per-webhook HMAC-SHA-256 secret from Platinum's `POST /v1/webhooks` (shown
  // once at registration). Optional — same backstop story as Daytona's.
  PLATINUM_WEBHOOK_SECRET: optStr,
  // E2B_DOMAIN is the base E2B domain without a protocol. The default uses
  // E2B Cloud. A self-hosted deployment uses its own base domain.
  // E2B_TEMPLATE is an optional ready fallback template. Project-specific
  // templates built by the shared snapshot system take precedence.
  E2B_API_KEY: optStr,
  E2B_DOMAIN: optStrDefault('e2b.dev'),
  E2B_TEMPLATE: optStr,

};
