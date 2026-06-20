---
name: kortix-social
description: Writes platform-native social content — LinkedIn posts, Twitter/X threads, carousels, Instagram/TikTok/Reels/Shorts video scripts, content calendars — and repurposes one long-form piece into many. Use when the user asks for a "LinkedIn post," "Twitter thread," "carousel," "social calendar," "what should I post," "repurpose this," "video hook," "reel," "short-form video," or to grow/strategize a social presence.
---

# Social Content

Turn product context into scroll-stopping, platform-native content — and turn one piece of content into many. This skill writes the words and the scripts; it hands visual production to `kortix-image`.

## Before writing

Read the shared context first, then write — don't interrogate.

1. **Product context** — read `/product-marketing.md`. Reuse audience, personas, customer language, proof points, and goals from it. If it's missing, you can still work, but suggest setting it up via the `product-marketing` skill so every post stays on-product.
2. **Voice & messaging** — read [`../internal-comms/SKILL.md`](../internal-comms/SKILL.md) for tone, positioning, and canonical terminology before writing any copy. It governs *what* you say.
3. **Visuals** — for carousels, quote graphics, thumbnails, or video covers, don't describe pixels here — hand the brief to [`../kortix-image/SKILL.md`](../kortix-image/SKILL.md) (which honors `brand-guidelines`).

Only ask for what the context doesn't cover: the **goal** (awareness / leads / traffic / community), **platform(s)**, the **action** you want readers to take, and whether it's **personal or company** brand. Default sensibly from the context rather than asking.

## Routing

| User intent | Mode |
| --- | --- |
| "write me a post / thread / carousel" | **Create** |
| "turn this blog/podcast/webinar into social" | **Repurpose** |
| "script a reel / TikTok / Short / video hook" | **Video** |
| "plan my week / build a calendar" | **Plan** |
| "what should I post? / I'm out of ideas" | **Ideate** |

## Platform quick reference

| Platform | Best for | Cadence | Native format |
| --- | --- | --- | --- |
| LinkedIn | B2B, thought leadership | 3–5×/week | Text story, carousel, poll |
| Twitter/X | Tech, real-time, community | 3–10×/day | Thread, hot take, reply |
| Instagram | Visual, lifestyle | 1–2 + Stories daily | Reel, carousel |
| TikTok | Reach, younger audience | 1–4×/day | Short-form video |

Two distribution rules that apply almost everywhere: **first-hour engagement decides reach**, and **external links in the post body suppress reach** — put links in the first comment or a reply. Character/hashtag limits live in [`references/platform-limits.md`](references/platform-limits.md).

## Create

Every post is **one hook + one idea + one action**. The first line earns the second.

- **Hook first.** Pick a hook type to the goal — curiosity, story, value, or contrarian. Library in [`references/post-templates.md`](references/post-templates.md). If reach is flat, the hook is almost always the cause; test new hooks before anything else.
- **One idea per post.** Don't pack a thread's worth of value into a single post — split it.
- **Standalone.** The reader has no prior context. A repurposed clip's caption must work even if they never saw the source.
- **One clear action.** A question, a save, a "link in comments" — never two.
- Match length and tone to the platform (limits file). LinkedIn rewards line breaks and 1,200–1,500 chars; X rewards brevity; carousels need a hook slide that promises a payoff.

## Repurpose

The strongest social content isn't written from scratch — it's **extracted from long-form and adapted per platform.** This is the highest-leverage mode.

1. **Mine content atoms** — pull 5–10 self-contained moments from the source: a quotable claim, a complete mini-story, a tactical tip, a contrarian take, a data callout, a behind-the-scenes moment.
2. **Adapt each atom to a format** — same idea, native shape:

   | Atom | Goes to |
   | --- | --- |
   | Quotable claim / hot take | X post, LinkedIn, quote graphic |
   | Complete mini-story (setup→resolution) | Reel, TikTok, Short |
   | Tactical tip / framework | LinkedIn carousel, Short |
   | Data / stat | LinkedIn carousel, X |
   | List of takeaways | X thread |

3. **Write standalone captions** for each.
4. **Spread across 1–2 weeks** — never dump them all at once.
5. **Reshare evergreen atoms** every 3–6 months.

Rough yield from one podcast/webinar/video: 3–5 short clips, 1–2 LinkedIn posts, 1 X thread, 1 carousel.

## Video

Short-form video is the highest-reach format on every platform. Frameworks and the full hook library are in [`references/short-form-video.md`](references/short-form-video.md). The essentials:

- **3-second rule** — visual hook **+** verbal hook **+** text overlay, all landing in the first second. Show the payoff or the problem immediately; never build up to it.
- **Pick a structure** — Problem→Agitate→Solution→CTA, List (one item every 5–8s), or Tutorial (show the result first). Keep it 9:16, 15–60s.
- **Caption everything** — most short-form is watched on mute; subtitles lift watch time 25–40%. Max 2 lines, 3–5 words each, key word highlighted.
- Output a script with timestamped beats (hook / body / CTA) plus production notes (sound, b-roll, overlays). Hand any cover frame or thumbnail to `kortix-image`.

## Plan

Build around **3–5 content pillars** the audience cares about and you can sustain — e.g. for a SaaS/dev-tool brand: industry insight (~30%), behind-the-scenes/build-in-public (~25%), educational how-tos (~25%), personal/opinion (~15%), promotional (~5%). Keep promo light.

Then produce a weekly grid (day × platform × pillar × format) and a **batching plan**: write the week's posts in one 2–3 hour block, schedule the evergreen ones, and leave gaps for real-time replies and trend-jacking. Maintain a 1–2 week queue, never more.

## Ideate

When stuck, generate from the pillars, not from a blank page: repurpose a past high-performer, react to industry news, answer a real audience question, share a lesson or failure, or document what you're building this week. For each idea, name the pillar, the platform, and the hook before drafting.

## References

- [`references/post-templates.md`](references/post-templates.md) — hook formulas + ready post/thread/carousel skeletons
- [`references/short-form-video.md`](references/short-form-video.md) — video hook library, scripting template, structures
- [`references/platform-limits.md`](references/platform-limits.md) — character counts, hashtag limits, "see more" thresholds

## Related skills

- **product-marketing** — owns the shared `/product-marketing.md` context this skill reads first
- **internal-comms** — voice, positioning, and approved terminology for all copy
- **kortix-image** — produces the carousels, graphics, thumbnails, and video covers
