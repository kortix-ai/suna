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

/**
 * The `convex` npm CLI that matches CONVEX_BACKEND_IMAGE: the newest release
 * published before the backend's 2026-09-28 build. `kortix backends deploy`
 * runs this version when the project has no `convex` installed, so a newer CLI
 * that needs newer backend APIs never breaks a deploy. Bump it with the image.
 */
export const CONVEX_CLI_VERSION = '1.46.0';

import { readFileSync } from 'node:fs';

/**
 * Convex's own dashboard, the static export Convex publishes with the same
 * release as CONVEX_BACKEND_IMAGE (git 5c7cb5b), verified by sha256 at build.
 */
const DASHBOARD_ZIP_URL =
  'https://github.com/get-convex/convex-backend/releases/download/precompiled-2026-09-28-5c7cb5b/dashboard.zip';
const DASHBOARD_ZIP_SHA256 = 'b4d10c8a2a19f6b0e7e0de4fa80753d0ec479655277a87b8f9be9fcb3cdefbf1';
const DASHBOARD_SERVER = readFileSync(new URL('./dashboard-server.mjs', import.meta.url), 'utf8');

/** The file Kortix writes after create: the public origins exist only once the sandbox id does. */
export const CONVEX_ORIGINS_FILE = '/convex/origins.env';
/** Convex's process log: startup failures, crashes, the supervisor's restart lines. */
export const CONVEX_LOG_FILE = '/var/log/convex.log';
const DASHBOARD_LOG_FILE = '/var/log/convex-dashboard.log';
/**
 * Each log is capped at this size, plus one previous copy (`<file>.1`): at
 * most 4 × 50 MB on a disk that also holds the database. The cap is checked
 * every 30 s, so a file can overshoot it by what Convex writes in 30 s.
 * ponytail: copy-then-truncate loses the lines written between the two steps
 * (milliseconds). A logrotate-style reopen needs Convex to reopen its log.
 */
export const CONVEX_LOG_CAP_BYTES = 50 * 1024 * 1024;

const SUPERVISOR = `#!/bin/bash
# Waits for ${CONVEX_ORIGINS_FILE}, then runs the Convex backend forever.
cd /convex || exit 1
while [ ! -s ${CONVEX_ORIGINS_FILE} ]; do sleep 0.2; done
set -a; . ${CONVEX_ORIGINS_FILE}; set +a
export DO_NOT_REQUIRE_SSL=1 DISABLE_BEACON=1 RUST_LOG=info PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Caps each log at ${CONVEX_LOG_CAP_BYTES} bytes plus one previous copy. Both writers append (>>), so a truncate is safe.
( while true; do
    for f in ${CONVEX_LOG_FILE} ${DASHBOARD_LOG_FILE}; do
      if [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -gt ${CONVEX_LOG_CAP_BYTES} ]; then cp "$f" "$f.1" && : > "$f"; fi
    done
    sleep 30
  done ) &
# The Convex dashboard (port 6791), restarted if it ever exits.
( while true; do node /usr/local/bin/convex-dashboard-server.mjs >> ${DASHBOARD_LOG_FILE} 2>&1; sleep 1; done ) &
while true; do
  ./run_backend.sh >> ${CONVEX_LOG_FILE} 2>&1
  echo "convex exited $? at $(date +%s)" >> ${CONVEX_LOG_FILE}
  sleep 1
done
`;

export const CONVEX_IMAGE_SPEC = {
  base_image: CONVEX_BACKEND_IMAGE,
  steps: [
    { op: 'apt', packages: ['unzip'] },
    {
      op: 'run',
      cmd:
        `curl -fsSL ${DASHBOARD_ZIP_URL} -o /tmp/dashboard.zip` +
        ` && echo "${DASHBOARD_ZIP_SHA256}  /tmp/dashboard.zip" | sha256sum -c -` +
        ' && mkdir -p /opt/convex-dashboard && unzip -q /tmp/dashboard.zip -d /opt/convex-dashboard && rm /tmp/dashboard.zip',
    },
    {
      op: 'copy',
      content_b64: Buffer.from(DASHBOARD_SERVER).toString('base64'),
      dst: '/usr/local/bin/convex-dashboard-server.mjs',
      mode: '0644',
    },
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
/** Convex's dashboard, framed by Kortix web. */
export const CONVEX_DASHBOARD_PORT = 6791;
