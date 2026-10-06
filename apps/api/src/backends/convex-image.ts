/**
 * The machine image every Kortix Backend boots: the self-hosted Convex backend,
 * pinned by digest, plus a supervisor.
 *
 * Sent inline on create (Platinum's `image` spec). Platinum hashes the spec and
 * builds it once per region; every later create with the same spec reuses the
 * build, so no environment needs a manual template step. Changing anything
 * here (the digest, the script) is a new image: existing backends keep theirs.
 *
 * Verified on Platinum 2026-10-06 (create → healthy 2.65 s, RSS 127 MB after a
 * deploy, data intact across stop, auto-resume and cold boot).
 */

/** ghcr.io/get-convex/convex-backend, git revision 5c7cb5bc7db4. `/version` answers `unknown`, so the digest is the version. */
export const CONVEX_BACKEND_IMAGE =
  'ghcr.io/get-convex/convex-backend@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4';

/** The file Kortix writes after create: the public origins exist only once the sandbox id does. */
export const CONVEX_ORIGINS_FILE = '/convex/origins.env';

const SUPERVISOR = `#!/bin/bash
# Waits for ${CONVEX_ORIGINS_FILE}, then runs the Convex backend forever.
cd /convex || exit 1
while [ ! -s ${CONVEX_ORIGINS_FILE} ]; do sleep 0.2; done
set -a; . ${CONVEX_ORIGINS_FILE}; set +a
export DO_NOT_REQUIRE_SSL=1 DISABLE_BEACON=1 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
while true; do
  ./run_backend.sh >> /var/log/convex.log 2>&1
  echo "convex exited $? at $(date +%s)" >> /var/log/convex.log
  sleep 1
done
`;

export const CONVEX_IMAGE_SPEC = {
  base_image: CONVEX_BACKEND_IMAGE,
  steps: [
    {
      op: 'copy',
      content_b64: Buffer.from(SUPERVISOR).toString('base64'),
      dst: '/usr/local/bin/convex-sup',
      mode: '0755',
    },
  ],
  entrypoint: '/usr/local/bin/convex-sup',
  ready_cmd: 'curl -fsS http://127.0.0.1:3210/version',
  size_mb: 2048,
} as const;

/** Convex API + sync + HTTP actions under /http. */
export const CONVEX_API_PORT = 3210;
/** Convex HTTP actions at the root (the site URL). */
export const CONVEX_SITE_PORT = 3211;
