---
recorded: 2026-09-02T10:12:57Z
incident_date: 2026-09-02
commit: 90311eec5d
---
# A CLI change does not reach agents until the SANDBOX IMAGE is rebuilt, and the preview never rebuilds it

**When:** adding or changing a `kortix` CLI command that agents are meant to
use. The agent path is `bash` → `kortix …` inside the session ENVIRONMENT, and
that binary is COMPILED INTO the sandbox image
(`apps/sandbox/Dockerfile:244`, `COPY --from=cli-builder /cli/kortix
/usr/local/bin/kortix`). That image is built by `deploy-dev.yml` — on main.
`deploy-preview.yml` builds only the gateway, API and frontend images, so a
branch preview runs NEW api code against an OLD sandbox image.
**Measured:** with `kortix fs` committed and the preview deployed, an agent on
pi.kortix.com answered `/usr/local/bin/kortix` for `command -v kortix` and
`FS_SUBCOMMAND_ABSENT` for `kortix fs --help`. The mechanism was fine; the
binary was three commits stale.
**Rules:** (1) a CLI change is verifiable on a preview only by running the CLI
from the REPO against the preview's API (`KORTIX_API_URL` + `KORTIX_TOKEN` +
`KORTIX_PROJECT_ID` env, which is exactly how the in-sandbox CLI
authenticates) — the in-sandbox binary proves nothing until dev redeploys;
(2) never conclude "agents can use it" from a green API test; probe the actual
binary in a live box; (3) when a new CLI subcommand is the agent surface for a
feature, say in the PR which deploy makes it real.
**Diagnostic:** `command -v kortix` succeeds but the new subcommand prints
usage/unknown — a stale image, not a broken command.
*Near-miss:* would have shipped `kortix fs` believing agents could already call
it. Caught by probing a live session instead of trusting the API tests.
*Enforcer:* none. A check that the sandbox image's CLI version matches the
deployed API commit would catch it.
