---
name: instagram-reels
description: "Build and run an automated Instagram Reels pipeline on Kortix: topic and fact check, hook-first script, text-to-speech narration with word timestamps (ElevenLabs, or Sarvam Bulbul for Indian languages), AI images, a 1080x1920 render with animated captions inside Instagram's safe zones, machine QA plus frame review, and publishing through the Instagram connector (container -> poll -> publish) with duplicate protection. Use when a user wants to make Reels, post short vertical videos to Instagram on a schedule, or turn content into Reels for a business or creator account."
---

# Instagram Reels

Turns a topic into a finished, checked Reel and publishes it to an Instagram Business or Creator account through the Kortix Instagram connector. It works for one Reel made in a session, and for a schedule that runs with nobody watching.

```
topic -> source + fact ledger -> script -> voice + word timings -> shot list -> images
      -> render 1080x1920 -> QA + frame review -> caption + cover -> publish (container, poll, publish) -> ledger
```

The helpers are in `scripts/`. Copy the folder into the project (`skills/instagram-reels/scripts/`).

| Script | Does |
|---|---|
| `tts.py` | ElevenLabs narration, one request per sentence, exact word timings |
| `image.py` | gpt-image-2 (OpenAI) or Nano Banana (Gemini) images, with a cost log |
| `render_short.py` | Stills + voice + words -> 1080x1920 30 fps H.264/AAC: motion, karaoke captions, headlines, ducked music, -14 LUFS |
| `qa.py` | Machine checks plus one frame per second for review |
| `ig_publish.py` | Reel / story / post / carousel publishing with live-feed dedupe and a ledger |
| `kx.py` | Connector calls, 1-hour public file links, ledger helpers |

## 0. Setup (once per project)

1. **Account.** The Instagram account must be a **Business or Creator** account (Settings -> Account type). Personal accounts can't publish through the API.
2. **Brand facts.** Ask about the niche, audience, language, tone, voice, visual style, colours, fonts, cadence, hashtag set, and whether posts need a person's approval. Save them to `memory/` or a `brand.md`.
3. **Voice provider.** **Ask the user to choose** before you request any key: **ElevenLabs** (exact word timings from `tts.py`, the widest voice range, audio tags on v3) or **Sarvam Bulbul** (Hindi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Marathi, Punjabi, Odia and Indian English, at under half the price). Record the choice in `memory/` or `brand.md` and request only that provider's key.
4. **Secrets** (setup links, never chat):
   ```bash
   kortix secrets request ELEVENLABS_API_KEY OPENAI_API_KEY --scope runtime   # or GEMINI_API_KEY + IMAGE_PROVIDER=gemini
   # Sarvam Bulbul instead of ElevenLabs (Indian languages): kortix secrets request SARVAM_API_KEY --scope runtime
   ```
5. **Instagram connector** (Composio). Install it and hand over the sign-in link:
   ```bash
   kortix connectors catalog install instagram --slug instagram
   kortix connectors connect instagram --owner project
   kortix connectors accounts instagram          # if several accounts: export IG_ACCOUNT="<name>"
   ```
   Lock it down in `kortix.yaml`. Rules are first-match, so allows go before the block:
   ```yaml
   connectors:
     - slug: instagram
       provider: composio
       app: instagram
       policies:
         - { match: post_ig_user_media,                    action: always_run }
         - { match: post_ig_user_media_publish,            action: always_run }   # require_approval = a person approves each post
         - { match: get_user_info,                         action: always_run }
         - { match: get_multiple_nodes,                    action: always_run }
         - { match: get_ig_user_content_publishing_limit,  action: always_run }
         - { match: get_ig_media_insights,                 action: always_run }
         - { match: "*",                                   action: block }        # no DMs, no deleting, no comments
   ```
   Check: `python3 scripts/ig_publish.py reel --media x.mp4 --key t --dry-run` prints the IG user ID.
   Note: a held `require_approval` call has to be approved while the run waits. For unattended schedules, prefer `always_run` plus a strict QA gate, or put the human gate earlier (a person moves a file from `review/` to `queue/`).
6. **Voice.** ElevenLabs: `python3 scripts/tts.py --list-voices`, pick one with the user, store `TTS_VOICE_ID`. Sarvam: play the user a few Bulbul speakers (for example `shubh`, `priya`, `aditya`) in their language and store the one they pick.

## 1. Topic and facts

One idea per Reel. Keep a dedupe folder (`state/covered/<slug>.json`, one file per topic). Read the real source and write `facts.json` (claim, quote, URL, verdict) before writing narration. Only supported claims reach the voice, the screen or the caption. If the main claim fails, drop the topic.

## 2. Script for Reels

Target **15–45 s**. Reels must be **5–90 s** to publish as a Reel through the API (longer uploads become regular video posts). Short Reels get more completions and replays.

| Beat | Rule |
|---|---|
| Hook (0–1.5 s) | The first frame must stop the scroll: the subject plus a bold claim, number or question. Text on screen from frame 1, since many people watch muted. No intros, no logos. |
| Build | One idea per sentence, a new visual every 1.5–3 s, a concrete comparison. |
| Payoff | Answer the hook. End on a line that loops back to the start, or one clear call to action ("Save this for later", "Follow for part 2"). Only one ask. |

**Tone and emotion.** Choose an arc (curiosity -> reveal, problem -> fix, myth -> truth) and a register that matches the brand. Write for the ear. With ElevenLabs v3 (`TTS_MODEL=eleven_v3`), audio tags like `[excited]`, `[laughs]` or `[whispers]` add emotion. Use one or two per Reel, not every line.

## 3. Voice

```bash
export TTS_VOICE_ID=<voice>
python3 scripts/tts.py script.txt work/      # narration.wav, words.json, sentences.json, sentence-N.wav
```
**Sarvam Bulbul** (`bulbul:v3`) is the alternative for Indian languages: Hindi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Marathi, Punjabi, Odia and Indian English. `tts.py` calls ElevenLabs only. Bulbul returns audio without word timings: voice each sentence through the Sarvam API, then get `words.json` from a speech-to-text pass with word timestamps on `narration.wav` before you render.

Re-voice one sentence at a time to fix a read. Shorten the script rather than speeding up the voice.

## 4. Images

`shots.json`: one shot per sentence, 1.5–3.5 s, a concrete subject and a composition for each. Sources: the brand's own asset library -> licensed photos with credits -> generated:

```bash
python3 scripts/image.py "<brand style prefix>, <subject + composition>, vertical, subject centred, no text" work/shot-01.png --aspect 9:16 --quality medium
```
(or the Kortix `image_gen` tool). Keep one fixed style prefix per brand. Ask for no text in the image, since the renderer adds it. Read every image and regenerate wrong ones. Cap attempts per Reel and per month.

**Instagram safe zones (1080x1920):** keep text and faces out of the **top ~250 px** and the **bottom ~540 px** (caption, buttons, audio label), and out of the right **~120 px** (like/comment/share rail). The profile grid shows the **centre 1080x1350** (4:5), so the cover's subject and title must fit there.

## 5. Render

```bash
python3 scripts/render_short.py work/render.json
```
```json
{"shots": [{"image": "work/shot-01.png", "duration": 2.2, "motion": "in", "headline": "YOU'RE DOING THIS WRONG"},
           {"image": "work/shot-02.png", "duration": 2.8, "motion": "right"}],
 "narration": "work/narration.wav", "words": "work/words.json",
 "music": "assets/licensed-bed.mp3", "music_db": -22, "caption_y": 1380, "out": "out/reel.mp4"}
```
Captions sit at y≈1380, above the bottom UI. Headlines sit at y≈330, below the top UI. Music must be licensed for commercial use: API-published Reels can't attach Instagram's music library, so a business account must bring its own rights.

**Cover:** render a 1080x1920 JPEG with the title inside the centre 4:5 area (the `instagram-content-studio` skill's `card.py` does this), or pick a frame.

## 6. QA gate

```bash
python3 scripts/qa.py out/reel.mp4 --max 90 --frames out/qa-frames
```
The machine checks must all pass (1080x1920, H.264 yuv420p, AAC, 5–90 s, -16 to -12 LUFS, peak ≤ -1 dBFS, no dead air, faststart). Then **open every frame** and write `review.md`: hook frame readable muted? Right subject in each shot? Numbers match the facts? Text clear of the safe zones? Score hook / accuracy / visuals / captions / audio 0–10. Below 8 means fix and re-check (max 3 rounds). Never pass a Reel without reading the frames.

## 7. Caption

- **First line** = the hook, under ~125 chars (only that shows before "more").
- 2–4 short lines of value or context. Sources if it's factual.
- One call to action. AI disclosure where visuals or voice are generated ("Voice and visuals are AI-generated.").
- 3–5 relevant hashtags (more doesn't help). Max 2,200 chars and 30 hashtags. Write `#` as is; the connector handles encoding.
- Instagram applies its own "AI info" label to some content. Honest disclosure in the caption is still the safe default.

## 8. Publish

```bash
python3 scripts/ig_publish.py reel --media out/reel.mp4 --caption-file out/caption.txt --cover out/cover.jpg \
  --key reel-2026-10-30-why-saturn-is-flat --ledger-dir state/published
```
How it works: the MP4 gets a **1-hour Kortix session link** -> `post_ig_user_media` (`media_type: REELS`, `video_url`, `caption`, `share_to_feed: true`, optional `cover_url`) -> poll `status_code` every 10 s until `FINISHED` (up to 10 min) -> `post_ig_user_media_publish` -> permalink -> ledger file -> link revoked.

- **Duplicate safety:** the ledger key and the live feed (first 80 normalised caption characters) are checked before any write, and again after an ambiguous publish error. A post that went through is recorded, never posted twice. Make every caption unique.
- **Limits:** 100 API-published posts per 24 h per account (`get_ig_user_content_publishing_limit`). For a healthy feed, space Reels at least an hour apart.
- **Errors:** `9007` / not ready means the container wasn't `FINISHED`: keep polling. Container `ERROR` means the file is out of spec: rerun QA. Auth errors mean reconnect the connector (`kortix connectors connect instagram`). Allow 3 attempts per Reel, then mark it failed for a person.

## 9. Automate on Kortix

Two agents: a producer (voice and image keys, no Instagram connector) writes passed Reels into `queue/`, and a publisher (Instagram connector only) posts the oldest one.

```yaml
agents:
  reels-producer:
    prompt_file: agents/reels-producer.md     # load skills/instagram-reels; steps 1-7; write to queue/<slug>/; never publish
    skills: [instagram-reels]
    secrets: [ELEVENLABS_API_KEY, OPENAI_API_KEY]   # SARVAM_API_KEY instead of ELEVENLABS_API_KEY when the user chose Sarvam
    connectors: []
    workspace: { project_repository: true }
  reels-publisher:
    prompt_file: agents/reels-publisher.md    # load the skill; publish the oldest passed item with step 8; report the permalink
    skills: [instagram-reels]
    connectors: [instagram]
    workspace: { project_repository: true }
triggers:
  - { slug: make-reel,    type: cron, agent: reels-producer,  cron: "0 0 6 * * *",  timezone: UTC, enabled: false, overlap: allow }
  - { slug: publish-reel, type: cron, agent: reels-publisher, cron: "0 0 17 * * *", timezone: UTC, enabled: false, overlap: allow }
```
Store finished media and ledgers on the project Drive (`/drives/<folder>/`) or S3/R2, since `/workspace` doesn't survive the session. Use one folder per Reel and one ledger file per post. Ship triggers disabled and enable them after the user approves 2–3 Reels made by hand. Post when the audience is active (the account's insights show the hours).

## Costs (per 30 s Reel, list prices, October 2026)

| Item | Cost |
|---|---|
| ElevenLabs TTS, ~500–700 chars incl. re-voicing (~$0.08–0.10 per 1k chars) | ~$0.05–0.10 |
| or Sarvam Bulbul TTS, same chars (₹30 per 10k chars on `bulbul:v3`, ~$0.035 per 1k) | ~$0.02–0.03 |
| 6–10 images, gpt-image-2 medium (~$0.04–0.05) or Nano Banana (~$0.04) | ~$0.25–0.50 |
| Render, QA, Instagram Graph API | $0 |
| Agent model tokens | largest variable: check Kortix usage |

## Hard rules
- Never publish a Reel that failed QA or skipped the frame review.
- Never invent facts. Licensed music and images only. Disclose AI-generated voice and visuals.
- Never DM, comment, delete or edit posts unless the user asked for it. The connector policy should block these anyway.
