---
name: kortix-image
description: "Recipe: produce a Kortix image (hero, OG card, social card, thumbnail, cover, blog image, illustration, UI asset). Load kortix-brand first. This skill covers sizes, tools, generation, compositing and export. Use when the user asks to create, art-direct or revise an image for Kortix, agents, sandboxes, coding workflows, launch assets, thumbnails or covers."
---

# Kortix image recipe

Turn a visual request into one clean, brand-safe image.

**Load [`kortix-brand`](../kortix-brand/SKILL.md) first.** It owns the values, the voice, the claims and the logo rules. This file owns the procedure only. If a request conflicts with the kit, say so and offer the closest on-brand option.

Output PNG by default. Output SVG only when the user asks for SVG.

## Read before you start

| Need | Read |
| --- | --- |
| Direction, avoid list, reject list, share-card template | [`art-direction.md`](../kortix-brand/references/visual/art-direction.md) |
| Which logo file, recolor, one mark per surface, composite rule | [`brandmark.md`](../kortix-brand/references/visual/brandmark.md) |
| Color and the one-accent rule | [`color.md`](../kortix-brand/references/visual/color.md) |
| Words in or beside the image (headline, caption, in-image text) | [`voice-and-tone.md`](../kortix-brand/references/verbal/voice-and-tone.md), [`claims.md`](../kortix-brand/references/verbal/claims.md), [`positioning.md`](../kortix-brand/references/verbal/positioning.md) |

Settle the context below. Default from the kit and the request. Ask only what changes the art direction.

- **Image goal.** Type (blog hero, social graphic, product mockup, banner, brand asset, OG image), placement (website, social, directory, app store, email) and dimensions.
- **Production approach.** Existing brand assets to use, photoreal or illustrative, one-off or reusable template.
- **Technical.** Available image tools and keys (Gemini, Replicate or Flux, Ideogram), budget, and whether the image needs web optimization.

## Specs

Generate at the native size of the surface. Keep critical content crop-safe.

- OG and blog hero: **1200 by 630** (1.91:1)
- X post: **1200 by 675** (16:9). X header: **1500 by 500**
- LinkedIn post: **1200 by 627**. LinkedIn personal cover: **1584 by 396**
- Square (Instagram, launch card): **1080 by 1080**. Story or reel: **1080 by 1920** (9:16)

Pin the aspect ratio in the prompt. A forgotten ratio is the most common cause of unusable output.

## Tools

- **General generation.** Gemini or Flux.
- **A consistent set.** Flux multi-reference.
- **Text that must live in the image.** Ideogram renders text best. Prefer the default: composite real text in Roobert after generation.
- **Product UI.** Never generate it. Screenshot the real Kortix UI at 2x and frame it.

## Workflow

1. Confirm the surface, the aspect ratio and any required text or facts.
2. Write one short prompt: subject, Kortix product truth, direction from `art-direction.md`, composition, aspect ratio. Keep it tight. Over-specifying produces worse images.
3. Generate as PNG. Composite the official logo file and any exact text after. Follow `brandmark.md`.
4. For the web, also export an optimized WebP (about 80% quality). Set explicit width and height to avoid layout shift. Add descriptive alt text.
5. Reject, and do not ship, any image that matches the reject list in `art-direction.md`.
6. Report the files you read and a "Guesses" list, as `SKILL.md` of `kortix-brand` says.
