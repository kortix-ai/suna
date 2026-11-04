---
name: instagram-content-studio
description: "Run a whole Instagram account on Kortix: Reels (voiced vertical video), Stories (9:16 image or video) and feed posts (4:5 single image or carousel), made with an image model (gpt-image-2 / Nano Banana) and a text-to-speech voice (ElevenLabs, or Sarvam Bulbul for Indian languages), checked by a QA gate, and published through the Instagram connector on a schedule, with duplicate protection and a content calendar. Use when a user wants an AI content studio for Instagram, daily stories and posts, a mix of Reels and image posts, or to automate a brand or creator account end to end."
---

# Instagram content studio

One pipeline for the three Instagram formats. They share a brand kit, a fact check, one image model, one voice and one publisher.

| Format | Size | Length | What it's for | Built with |
|---|---|---|---|---|
| **Reel** | 1080x1920, 9:16, H.264/AAC | 5–90 s (aim for 15–45) | Reach: new followers through the Reels feed | image model + TTS + `render_short.py` |
| **Story** | 1080x1920, 9:16, JPEG or MP4 | image, or video ≤60 s | Staying in touch with followers daily; disappears after 24 h | image model or real photo + `card.py` |
| **Feed post** | 1080x1350, 4:5 JPEG | single image or 2–10-slide carousel | Saves and shares: the evergreen grid | image model or real photo + `card.py` |

```
brand kit + calendar
   ├─ Reel:   topic -> facts -> script -> TTS (words.json) -> images -> render -> QA + frames -> caption -> publish
   ├─ Story:  pick (photo | news | AI poster) -> facts -> image -> card.py 9:16 -> read preview -> publish
   └─ Post:   pick -> facts -> image(s) -> card.py 4:5 (or carousel slides) -> read preview -> caption -> publish
                                                        all -> ig_publish.py -> ledger (one file per post)
```

Helpers are in `scripts/`. Copy the folder to `skills/instagram-content-studio/scripts/` in the project.

| Script | Does |
|---|---|
| `image.py` | One image from **gpt-image-2** (OpenAI, default) or **Nano Banana** (Gemini), with a cost log |
| `tts.py` | **ElevenLabs** narration, one request per sentence, exact word timings |
| `render_short.py` | Reel render: stills + voice + words -> 1080x1920 with motion, karaoke captions, headlines, ducked music, -14 LUFS |
| `card.py` | Story (1080x1920) / feed or carousel slide (1080x1350) composer: crop to focus, gradient, kicker, title, body, credit, handle, safe zones |
| `qa.py` | Video machine checks plus one frame per second |
| `ig_publish.py` | `reel` / `story` / `post` / `carousel` publishing with live-feed dedupe and a ledger |
| `kx.py` | Connector calls, 1-hour public file links, ledger helpers |

## 0. Setup (once)

1. **Business or Creator** Instagram account (personal accounts can't publish via the API).
2. **Brand kit.** Interview the user, then write `brand.md`:
   - niche, audience, language, the one promise of the account
   - tone (calm expert / playful / bold), banned words, emoji policy
   - visual style prefix for the image model (one sentence, reused word for word), palette hex codes, accent colour, font
   - voice provider for Reels: ElevenLabs or Sarvam Bulbul (see below), the voice ID or speaker, handle shown on cards, 5–8 hashtag pool
   - cadence (for example: 1 Reel/day, 1 Story/day, 3 posts/week) and posting hours from the account's insights
   - approval: fully automatic, or a person approves each item
3. **Voice provider.** **Ask the user to choose** before you request any key: **ElevenLabs** (exact word timings from `tts.py`, the widest voice range, audio tags on v3) or **Sarvam Bulbul** (Hindi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Marathi, Punjabi, Odia and Indian English, at under half the price). Record the choice in `brand.md` and request only that provider's key.
4. **Secrets** (setup links, never chat):
   ```bash
   kortix secrets request ELEVENLABS_API_KEY OPENAI_API_KEY --scope runtime
   # Gemini instead of OpenAI: kortix secrets request GEMINI_API_KEY --scope runtime ; IMAGE_PROVIDER=gemini
   # Sarvam Bulbul instead of ElevenLabs (Indian languages): kortix secrets request SARVAM_API_KEY --scope runtime
   ```
   Agents can also use the built-in Kortix `image_gen` tool instead of `image.py`, with no image key needed.
5. **Instagram connector:**
   ```bash
   kortix connectors catalog install instagram --slug instagram
   kortix connectors connect instagram --owner project
   kortix connectors accounts instagram     # several accounts -> export IG_ACCOUNT="<name>"
   ```
   ```yaml
   connectors:
     - slug: instagram
       provider: composio
       app: instagram
       policies:                                   # first match wins: allows before the block
         - { match: post_ig_user_media,                   action: always_run }
         - { match: post_ig_user_media_publish,           action: always_run }   # or require_approval
         - { match: get_user_info,                        action: always_run }
         - { match: get_multiple_nodes,                   action: always_run }
         - { match: get_ig_user_stories,                  action: always_run }
         - { match: get_ig_user_content_publishing_limit, action: always_run }
         - { match: get_ig_media_insights,                action: always_run }
         - { match: get_user_insights,                    action: always_run }
         - { match: "*",                                  action: block }
   ```
   Check with `python3 scripts/ig_publish.py post --media any.jpg --caption-file c.txt --key t --dry-run`.

## 1. Models

| Job | Default | Alternatives | Notes |
|---|---|---|---|
| Images (Reel shots, posters, slides) | **gpt-image-2** via `image.py` or Kortix `image_gen` | **Nano Banana** (`gemini-2.5-flash-image` or newer, `IMAGE_PROVIDER=gemini`, `IMAGE_MODEL=...`) | gpt-image-2 renders short headlines reliably. Nano Banana is cheap and good at keeping a character or product consistent across edits. |
| Voice (Reels) | **ElevenLabs** `eleven_multilingual_v2` | `eleven_v3` (audio tags such as `[excited]`), Flash/Turbo (cheaper, lower latency), **Sarvam Bulbul** `bulbul:v3` (Hindi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Marathi, Punjabi, Odia and Indian English; `SARVAM_API_KEY`) | ElevenLabs `/with-timestamps` gives character timings, so captions are exact, not guessed. `tts.py` calls ElevenLabs only. Bulbul returns audio without word timings: voice each sentence through the Sarvam API, then get `words.json` from a speech-to-text pass with word timestamps on `narration.wav` before you render. |
| Agent (topics, facts, scripts, review) | project default Kortix model | — | Needs vision: it must read every frame and preview. |
| Render | ffmpeg (+ optional HTML/Chromium or Remotion/Revideo for motion graphics) | — | Already in the sandbox. |

Prompt pattern for every image: `"<brand style prefix>, <subject and composition>, <aspect> composition, subject in the centre, no text"`. For a poster whose text is part of the art: `"... Large bold clean sans-serif headline at the top reading exactly: \"<≤8 WORDS>\". No other text."` Then **read the image**. If any letter is wrong, regenerate (max 3 times) or drop the baked text and let `card.py` draw the title (`bakedText: false`).

## 2. Content calendar and dedupe

Keep `calendar/` with one file per planned item (`2026-11-03-post-why-saturn-is-flat.json`: format, topic, angle, status). Each run takes the next `planned` item for its format, or proposes one from the brand's sources (RSS, blog, product updates, trending questions, a user backlog). Rules:
- Never repeat a topic or a source image. Keep `state/used/<source-id>.json`, one file each.
- Mix formats and angles. Don't post the same story format three days in a row. A day's story and post should cover different things.
- One idea per item.

## 3. Facts (every format)

Read the real source and record claim -> quote -> URL -> verdict in the item folder. Only supported claims go into voice, on-screen text or captions. Real photos need their exact credit line, taken from the source page (many archives require a specific credit). Never assume an image is free to use because of the website it's on. AI images and voices are disclosed in the caption ("Illustration is AI-generated." / "Voice and visuals are AI-generated.").

## 4. Reels

Follow the same flow as a dedicated Reels pipeline:
1. **Script** 15–45 s: a scroll-stopping hook in the first 1.5 s (subject plus a bold number, contrast or question, with on-screen text since many watch muted) -> one idea per sentence -> a payoff that answers the hook, or one CTA. Pick the emotional arc (curiosity -> reveal, problem -> fix, myth -> truth) and keep the brand's tone.
2. **Voice:** `TTS_VOICE_ID=<brand voice> python3 scripts/tts.py script.txt work/` -> `narration.wav`, `words.json`, `sentences.json`.
3. **Shots:** one per sentence, 1.5–3.5 s, a new framing each. Generate with the brand prefix at `--aspect 9:16`, and read and regenerate wrong ones.
4. **Render:** `python3 scripts/render_short.py work/render.json` (see the docstring for the spec: shots with `image`, `duration`, `motion`, optional `headline`; `narration`; `words`; optional licensed `music`).
5. **QA:** `python3 scripts/qa.py out/reel.mp4 --max 90 --frames out/qa-frames`. All checks must pass. Then open every frame and score hook / accuracy / visuals / captions / audio 0–10, each ≥8, fixing and re-checking up to 3 rounds.
6. **Cover:** `card.py` story layout with the title inside the centre 4:5 area (that's what the grid shows).
7. **Publish:** `python3 scripts/ig_publish.py reel --media out/reel.mp4 --caption-file out/caption.txt --cover out/cover.jpg --key reel-<date>-<slug> --ledger-dir state/published`

## 5. Stories

Pick one format per day:
- **Photo:** a real, credited image (an archive, the brand's own photos, a product shot). Use the source's facts and its exact credit.
- **News:** a fresh item from the brand's feeds. Scrape the page, write the text only from it, and copy the credit line.
- **AI poster:** one true, checked fact rendered as a poster with the image model (`--aspect 9:16`). Credit "AI-generated illustration".

Compose and preview:
```json
{"kind": "story", "image": "work/story.png", "kicker": "Did you know", "title": "A teaspoon of neutron star weighs a billion tons",
 "text": "Neutron stars pack more mass than the Sun into a ball about 20 km across.", "credit": "Illustration: AI-generated",
 "handle": "@yourbrand", "focus": [0.5, 0.4], "accent": "#F4CE68"}
```
```bash
python3 scripts/card.py work/story.json out/story.jpg
```
**Read `out/story.jpg` before publishing.** Is the subject visible and not badly cropped? Is the text readable and inside the frame? Is the credit present? Is nothing in the top ~250 px or bottom ~340 px (profile bar, reply box)? `card.py` refuses text that climbs into the top zone. A video story is a 9:16 MP4 ≤60 s, rendered with `render_short.py`.

```bash
python3 scripts/ig_publish.py story --media out/story.jpg --key story-<date> --ledger-dir state/published
```
Stories have no caption, so the live-feed caption dedupe doesn't apply. The ledger key (one per day) is the guard. `get_ig_user_stories` lists stories that are live now. Link stickers, polls and music stickers aren't available through the API; put the call to action in the image text.

## 6. Feed posts

**Single image:** same JSON as a story with `"kind": "post"` -> 1080x1350. Write a caption:
- line 1 = the hook (under ~125 chars, before "more")
- 2–3 short lines of context
- `Image: <full credit>` / `Source: <url>` for factual or real-image posts, and the AI disclosure for generated art
- one call to action ("Save this", "Share with a friend who…")
- 3–5 hashtags from the brand pool. Max 2,200 chars.

```bash
python3 scripts/card.py work/post.json out/post.jpg
python3 scripts/ig_publish.py post --media out/post.jpg --caption-file out/caption.txt --key post-<date>-<slug> --ledger-dir state/published
```

**Carousel** (2–10 JPEG slides, all 4:5; carousels earn the most saves): slide 1 = hook title, slides 2..n-1 = one point each with the same layout, last slide = summary plus CTA. Render each slide with `card.py` (same kicker and accent, a "2/6" counter in the kicker), read all of them, then:
```bash
python3 scripts/ig_publish.py carousel --media out/s1.jpg --media out/s2.jpg --media out/s3.jpg --caption-file out/caption.txt --key carousel-<date>-<slug> --ledger-dir state/published
```
Alt text for accessibility: the connector's `post_ig_user_media` accepts `alt_text` for images (not videos or stories). Add it if the brand wants it.

## 7. Publishing rules (all formats)

- Media goes to Instagram through a **1-hour Kortix session link** (`kx.share`), revoked after publish. Instagram fetches JPEG images and MP4 video only.
- Flow: create container -> poll `status_code` until `FINISHED` -> `post_ig_user_media_publish` -> permalink -> ledger file.
- **Duplicate safety:** ledger key first, then a live-feed caption fingerprint check, before writing and after any ambiguous error. Unique captions and keys per item.
- **Limits:** 100 API posts per 24 h (`get_ig_user_content_publishing_limit`). Keep 1 h or more between feed items.
- **Failures:** max 3 attempts per item, then mark it failed and tell a person. Auth errors mean reconnect `instagram`. Container `ERROR` means the media is out of spec: rerun QA.

## 8. Automate on Kortix

```yaml
agents:
  ig-studio:
    prompt_file: agents/ig-studio.md   # "Load skills/instagram-content-studio. The trigger names the format. Make ONE item, pass its gate, publish once, report the permalink."
    skills: [instagram-content-studio]
    connectors: [instagram]
    secrets: [ELEVENLABS_API_KEY, OPENAI_API_KEY]   # SARVAM_API_KEY instead of ELEVENLABS_API_KEY when the user chose Sarvam
    workspace: { project_repository: true }
triggers:
  - { slug: ig-story, type: cron, agent: ig-studio, cron: "0 30 3 * * *",  timezone: UTC, enabled: false, overlap: allow,
      prompt: "Format: story. Skip if state/published/story-<today>.json exists." }
  - { slug: ig-post,  type: cron, agent: ig-studio, cron: "0 30 13 * * 1,3,5", timezone: UTC, enabled: false, overlap: allow,
      prompt: "Format: post (single or carousel). Skip if today's post is already in state/published/." }
  - { slug: ig-reel,  type: cron, agent: ig-studio, cron: "0 0 17 * * *",  timezone: UTC, enabled: false, overlap: allow,
      prompt: "Format: reel. Make, QA, and publish one Reel." }
```
- For heavy Reel volume, split into a producer (no connector) that writes passed items to `queue/` and a publisher (connector only) that posts them, so a slow render never blocks a story.
- Keep media, previews, fact files and the ledger on the project Drive (`/drives/<folder>/`) or S3/R2. `/workspace` doesn't survive the session.
- One folder per item, one ledger file per post: parallel runs never edit the same file. Use an expiring lock (a timestamped lock file) if two runs of the same format could overlap.
- Ship triggers **disabled**. Run each format by hand with the user first, then enable.
- **Weekly review (optional):** a trigger that reads `get_ig_media_insights` (reach, saves, shares, plays) for the week's items, writes the winners and losers to `memory/`, and adjusts the calendar (formats, hooks, posting hours).

## Costs (list prices, October 2026)

| Item | Unit price | Per item |
|---|---|---|
| ElevenLabs TTS (v2/v3) | ~$0.08–0.10 per 1k chars (Flash ~half) | Reel: ~$0.05–0.10 |
| Sarvam Bulbul TTS | ₹30 per 10k chars on `bulbul:v3` (~$0.035 per 1k chars), ₹15 per 10k on `bulbul:v2` | Reel: ~$0.02–0.03 |
| gpt-image-2 | ~$0.006 low / ~$0.04–0.05 medium / ~$0.17–0.21 high per image | Reel (6–10 imgs): ~$0.30–0.50 · Story/post: ~$0.05–0.15 · Carousel (6): ~$0.30 |
| Nano Banana (Gemini) | ~$0.04 per image | similar or lower |
| Instagram Graph API, ffmpeg, PIL | $0 | $0 |
| Agent model tokens | per Kortix usage | the largest variable |

Example month (1 Reel + 1 Story per day, 3 posts per week): about 30×$0.50 + 30×$0.10 + 13×$0.15 ≈ **$20 of media**, plus agent tokens. Reusing images and capping regenerations keeps it there.

## Hard rules
- Nothing publishes without its gate: the QA plus frame review for Reels, and a read preview for Stories and posts.
- No invented facts. Real images credited exactly. AI voice and images disclosed. Licensed music only.
- Publish once per item. Never DM, comment, delete or edit posts unless the user asked for it.
