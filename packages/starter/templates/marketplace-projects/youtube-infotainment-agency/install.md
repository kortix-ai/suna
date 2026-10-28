# Installing the YouTube Infotainment Agency

Follow these steps in order in the setup session. Step 1 makes the project valid: until it runs,
`kortix.yaml` registers eight HyperFrames skills (`skills:`) whose folders are not yet in `skills/`,
and `kortix validate` reports them missing.

1. **Download the HyperFrames skills.** Run `scripts/sync-hyperframes-skills.sh` from the repo root. It
   fetches `hyperframes`, `hyperframes-core`, `hyperframes-animation`, `hyperframes-keyframes`,
   `hyperframes-registry`, `hyperframes-cli`, `hyperframes-creative` and `hyperframes-audio` from the
   HyperFrames GitHub repo, at the release tag for the version `pipeline/package.json` pins, into
   `skills/`. Then run
   `kortix validate`; it must pass. A marketplace copy loses file permissions, so also restore the
   executable bit: `chmod +x bin/yt scripts/*.sh && git update-index --chmod=+x bin/yt scripts/*.sh`.
   Commit both and open a change request ("Install HyperFrames skills"). Sessions only see the skills
   once that change request is merged.
2. **Secrets.** `ELEVENLABS_API_KEY` (a paid ElevenLabs plan; Starter or above allows commercial use)
   and `OPENAI_API_KEY` (the image model draws each scene's style frame) are required. Optional: the
   YouTube secrets (`YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`, `YT_API_KEY`), `MEDIA_S3_*`
   and `FAL_KEY` — see the README's Setup table. No model key is needed.
   Mint setup links with `kortix secrets request <NAME…> --scope runtime` (a connector secret never
   reaches the sandbox); never ask for a key in chat.
   - **YouTube publishing.** Ask whether the person wants the agency to publish. If yes, take them
     through `README.md` → **YouTube publishing setup** one step at a time, starting at step 1:
     the channel must already exist on the account they will sign in with, and custom thumbnails
     need it phone-verified at youtube.com/verify. Mint the secrets link with
     `--scope runtime`, check that `kortix secrets ls` shows delivery environment, then run
     `bin/yt youtube whoami` and show them the channel name. If they skip it, tell them uploads stay
     off until these secrets are set.
3. **Sandbox.** Every agent uses the `video` sandbox template (`Dockerfile.video`: ffmpeg, Chromium, bun,
   HyperFrames). It asks for 6 vCPU / 12 GB.
4. **Check.** In a session on the `video` sandbox: `cd pipeline && bun install && bun test`, then
   `bin/yt smoke` (a 22-second offline episode with stub voice and music).
5. **Channel.** Tell the person to edit `channel/` (brand, design, audio, `channel.yaml`) and
   `episodes/backlog.md` for their channel before the first episode. Leave every trigger off.
