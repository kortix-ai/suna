# YouTube Infotainment Agency

An agent studio for **science-explainer YouTube videos** in the Kurzgesagt / Veritasium style. A showrunner
drives eleven specialised agents through the whole production, a critic scores every stage against a
rubric, and a person approves the topic, script, storyboard and final cut.

**1** topic & framing → **2** research & fact-check → **3** script → **4** storyboard → **5** animation →
**6** narration, score & SFX → **7** packaging → **8** publishing, sources & follow-up → learnings → 1

- **Visuals are code-rendered**: an image model draws each scene's key frame as the ideal version of the
  video, and animators recreate it as [HyperFrames](https://github.com/heygen-com/hyperframes) HTML + GSAP,
  so diagrams and numbers stay exact. Generative b-roll is supported but capped and off by default.
- **Narration, music and SFX** come from ElevenLabs (Eleven v4). The sound-editor casts a narrator for each
  episode from the ElevenLabs Voice Library, writes pauses into the script and measures them.
- **Every fact is traceable**: claims are verified by an independent fact-checker before a script, scene or
  description may use them; each video ships a sources page.
- **Deterministic plumbing**: the `yt` CLI (`pipeline/`, TypeScript on bun) owns the episode state machine,
  validation, timing, render, mix (−14 LUFS), QA, packaging and YouTube upload.

## Agents
| Agent | Stage |
|---|---|
| `showrunner` (default) | runs the loop, dispatches stages, owns the human gates |
| `topic-scout` | finds and frames topics |
| `researcher`, `fact-checker` | builds the dossier; independently verifies every claim |
| `scriptwriter` | beat-by-beat script, every fact citing a verified claim |
| `art-director`, `animator` | storyboard + style frames; HyperFrames scenes |
| `sound-editor` | narrator casting, narration, score, SFX |
| `packager`, `publisher` | title, thumbnail, description, chapters; upload and follow-up |
| `critic` | scores every stage against `rubrics/` |

You talk to the **showrunner**. The others are its subagents: it hands each one a stage with the `task`
tool, inside its own session, and they report back to it. They don't appear as agents you can start,
so nothing skips the critic or the review gates. The only other agent you can start is
`harness-reflector`, which improves the agents from past sessions.

## Setup
Agents use the project's default Kortix model, so no model key is needed. Set secrets with
`kortix secrets set NAME=-` (never paste keys into chat).

| Secret | Needed for | Required? |
|---|---|---|
| `ELEVENLABS_API_KEY` | narration, music and sound effects. A paid plan (Starter or above allows commercial use) with Text to Speech, Sound Effects, Music and Voices (read, for Voice Library casting) | **yes** |
| `OPENAI_API_KEY` | style frames: the image model (`gpt-image-2`) draws each scene's key frame for the animators, about $0.17 a frame | **yes** |
| `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN` | uploading and analytics. Made once in the browser: see **YouTube publishing setup** below | to publish |
| `YT_API_KEY` | YouTube search during topic research without the OAuth secrets | no |
| `MEDIA_S3_ENDPOINT`, `MEDIA_S3_BUCKET`, `MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY`, `MEDIA_S3_PREFIX` | S3-compatible storage (e.g. Cloudflare R2) so narration, music and renders survive between sessions. Without it an episode must finish in the session that started it | no |
| `FAL_KEY` | generative b-roll, off by default (`channel.yaml → broll.enabled`) | no |

Then:
1. **Sandbox.** Every agent runs in the `video` template (`Dockerfile.video`: ffmpeg, Chromium, bun,
   HyperFrames), 6 vCPU / 12 GB.
2. **HyperFrames skills.** The setup session downloads the eight skills the art-director and animator use
   (`scripts/sync-hyperframes-skills.sh`, see `install.md`) and opens a change request; approve it before
   the first episode.
3. **Your channel.** "Mote" is an example channel and mascot: edit `channel/` (brand, design, audio,
   `channel.yaml`) and `episodes/backlog.md`. The `rates` in `channel.yaml` are cost estimates for the
   spend ledger; check them against your plans.
4. **Start an episode:** `kortix sessions new --agent showrunner -p "Start a new episode from the top of
   episodes/backlog.md"`, then review the gates in the Kortix review inbox. Triggers ship disabled.

**What to expect.** On the default model a 1-minute episode took about 3¼ hours of agent time from topic
to final gate, plus however long each of the four gates waits for you, and about $7.40 of spend: $5.83
of ElevenLabs narration, music and SFX and about $1.50 of image-model style frames (a 60 s, 6-scene test
episode, October 2026). About two hours of that was the scenes, where the animators recreate the style
frames in code. Earlier test episodes in a simpler flat-vector style took 109–267 min. Nearly all of the
time is model generation (`bin/yt episode timing <slug>` shows where); most of the spend is music and
SFX re-rolls.

Try the pipeline offline first: `cd pipeline && bun install && bun test`, then `bin/yt smoke` renders a
22-second QA'd episode with stub voice and music.

## YouTube publishing setup (optional)
Publishing needs three secrets: `YT_CLIENT_ID`, `YT_CLIENT_SECRET` and `YT_REFRESH_TOKEN`. You make them
once, in the browser (about 15 minutes). Without them the agency still makes episodes but can't upload
them.

1. **Create the YouTube channel first.** On youtube.com, signed in with the Google account you will use in
   step 5, choose *Create a channel* (or use a Brand Account channel). For custom thumbnails, verify the
   channel by phone at youtube.com/verify: until then YouTube refuses custom thumbnails from Studio and
   from the API, and shows a frame it picks. One phone number verifies at most 2 channels a year; if no
   code arrives, try the voice call option or another carrier's number.
2. **Create a Google Cloud project.** At console.cloud.google.com, create a project, then under
   *APIs & Services → Library* enable **YouTube Data API v3** and **YouTube Analytics API**.
3. **Set up the Google Auth Platform.** *Branding*: an app name and a support email. *Audience*:
   **External**, then click **Publish app** so the status reads *In production*. An app left in *Testing*
   gets a refresh token that expires after 7 days. Google's app verification is not needed to publish to
   your own channel.
4. **Create the OAuth client.** *Clients → Create client →* **Web application**, with the authorized
   redirect URI `https://developers.google.com/oauthplayground`. Keep the client ID and the client secret.
   A `redirect_uri_mismatch` error right after creating it means wait a few minutes.
5. **Get the refresh token.** Open developers.google.com/oauthplayground. Click the gear icon, tick
   **Use your own OAuth credentials** (OAuth flow *Server-side*, access type *Offline*) and paste the
   client ID and secret. In *Step 1*, paste these three scopes into the box and click **Authorize APIs**:
   `https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly`.
   Sign in with the channel's account (pick the Brand Account if the channel is one). On *Google hasn't
   verified this app*, click *Advanced → Go to …* and allow all three permissions. In *Step 2*, click
   **Exchange authorization code for tokens** and copy the **Refresh token**. Because you used your own
   credentials, the Playground does not revoke it.
6. **Store the three values.** Paste them into a Kortix secrets link (an agent creates one with
   `kortix secrets request YT_CLIENT_ID YT_CLIENT_SECRET YT_REFRESH_TOKEN --scope runtime`), or run
   `kortix secrets set YT_CLIENT_ID=-` and paste the value (the same for the other two). Never paste them
   into chat. `kortix secrets ls` must show delivery **environment** for all three: a *connector* secret
   never reaches the agents' sandbox and can't be switched, so remove it with `kortix secrets unset` and
   store it again.
7. **Check.** Run `bin/yt youtube whoami` in a session, or ask an agent to. It prints the channel's name.
   "No YouTube channel" means the step 5 account has no channel yet: create it (step 1) and check again;
   the same token then works.

`YT_API_KEY` is optional: it only lets topic research search YouTube without the three secrets. Uploads
always start private, and only after a person approves the episode's final review.

## Known limits
- The default models read images, so the critic reviews snapshots and contact sheets. None of them takes
  audio, so narration and the mix are judged by measurement (`yt voice report`, loudness, silence), not by
  ear. A person should listen before approving the final review. An audio-capable reviewer (for example a
  Gemini key behind a `yt listen` tool) would close that gap.
- Nothing is published without a human approving the final gate, and uploads start private.
